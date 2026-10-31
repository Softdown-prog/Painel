import copy
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
import driver
import receiver
from io import BytesIO

POLICY = json.loads((Path(__file__).parent / 'policy.example.json').read_text())

def claims():
    now = time.time()
    return {'iss': receiver.ISSUER, 'aud': receiver.AUDIENCE, 'iat': now - 1, 'nbf': now - 1, 'exp': now + 300,
            'actor_id': '189416996', 'repository_id': '1433232532', 'repository': 'Softdown-prog/Painel',
            'ref': 'refs/heads/main', 'event_name': 'workflow_dispatch',
            'workflow_ref': 'Softdown-prog/Painel/.github/workflows/vps-command.yml@refs/heads/main',
            'sha': 'a' * 40, 'run_id': '12345'}

class Authorization(unittest.TestCase):
    def test_trusted_identity_readonly_inventory(self):
        self.assertEqual(receiver.validate_claims(claims(), POLICY, 'infrastructure', 'inventory')['name'], 'Softdown-prog/Painel')

    def test_rejects_prs_other_refs_actors_workflows_and_repositories(self):
        for field, value in [('event_name', 'pull_request'), ('ref', 'refs/heads/feature'), ('actor_id', '1'),
                             ('repository_id', '1'), ('repository', 'evil/Painel'), ('aud', 'evil'),
                             ('workflow_ref', 'Softdown-prog/Painel/.github/workflows/evil.yml@refs/heads/main')]:
            c = dict(claims(), **{field: value})
            with self.subTest(field=field), self.assertRaises(ValueError):
                receiver.validate_claims(c, POLICY, 'infrastructure', 'inventory')

    def test_rejects_unknown_project_and_shell(self):
        for project, operation in [('postgres', 'deploy'), ('infrastructure', 'shell'), ('../../root', 'inventory')]:
            with self.subTest(project=project), self.assertRaises(ValueError):
                receiver.validate_claims(claims(), POLICY, project, operation)

    def test_other_repository_cannot_access_panel(self):
        c = dict(claims(), repository_id='1438758092', repository='Softdown-prog/Terrania',
                 workflow_ref='Softdown-prog/Terrania/.github/workflows/deploy-vps.yml@refs/heads/main')
        with self.assertRaises(ValueError):
            receiver.validate_claims(c, POLICY, 'panel', 'deploy')
        self.assertTrue(receiver.validate_claims(c, POLICY, 'terrania', 'deploy'))

    def test_expiration_and_future_issue(self):
        for c in [dict(claims(), exp=0), dict(claims(), iat=time.time() + 100)]:
            with self.assertRaises(ValueError):
                receiver.validate_claims(c, POLICY, 'infrastructure', 'inventory')

    def test_replay_returns_same_result_and_rejects_changed_payload(self):
        db = sqlite3.connect(':memory:')
        db.execute('create table jobs (id text primary key,digest text,result text)')
        self.assertIsNone(receiver.reserve(db, '12345', 'digest'))
        with self.assertRaises(ValueError): receiver.reserve(db, '12345', 'digest')
        db.execute('update jobs set result=? where id=?', ('{"exitCode":0}', '12345')); db.commit()
        self.assertEqual(receiver.reserve(db, '12345', 'digest'), {'exitCode': 0})
        with self.assertRaises(ValueError): receiver.reserve(db, '12345', 'changed')
        db.close()

    def test_signed_oidc_and_signature_tampering(self):
        import base64
        from cryptography.hazmat.primitives.asymmetric import rsa, padding
        from cryptography.hazmat.primitives import hashes
        private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public = private.public_key().public_numbers()
        enc = lambda b: base64.urlsafe_b64encode(b).decode().rstrip('=')
        key = {'kid':'test','kty':'RSA', 'e': enc(public.e.to_bytes(3,'big')), 'n':enc(public.n.to_bytes(256,'big'))}
        header,body = enc(b'{"alg":"RS256","kid":"test"}'),enc(json.dumps(claims()).encode())
        signature = enc(private.sign((header+'.'+body).encode(),padding.PKCS1v15(),hashes.SHA256()))
        token = header+'.'+body+'.'+signature
        with patch.object(receiver,'get_json',return_value={'keys':[key]}):
            self.assertEqual(receiver.verify_oidc(token,POLICY,'infrastructure','inventory')[0]['run_id'],'12345')
            changed = header+'.'+enc(json.dumps(dict(claims(),actor_id='1')).encode())+'.'+signature
            with self.assertRaises(Exception): receiver.verify_oidc(changed,POLICY,'infrastructure','inventory')

    def test_subprocess_deadline_is_enforced(self):
        import sys
        with self.assertRaises(subprocess.TimeoutExpired):
            driver.run([sys.executable, '-c', 'import time;time.sleep(3)'], timeout=0.05)

class Deployment(unittest.TestCase):
    def test_https_probe_identifies_itself_and_checks_server_revision(self):
        project = {'adapter':'panel','containers':{'api':'test-api'},'public_url':'https://panel.example.test/api/session'}
        c = {'Image':'id','State':{'Running':True,'Health':{'Status':'healthy'}},'Config':{'Image':'ref'}}
        image = {'Config':{'Labels':{'org.opencontainers.image.revision':'a'*40}}}
        with patch.object(driver,'inspect',return_value=c), patch.object(driver,'image_info',return_value=image), \
             patch.object(driver.urllib.request,'urlopen',return_value=BytesIO(json.dumps({'revision':'a'*40}).encode())) as http:
            self.assertTrue(driver.verify_project(project,{'sha':'a'*40})['publicVerified'])
            request = http.call_args.args[0]
            self.assertEqual(request.get_header('User-agent'),'VPS-Operations-Healthcheck/1.0')
            self.assertEqual(request.get_header('Accept'),'application/json')
        with patch.object(driver,'inspect',return_value=c), patch.object(driver,'image_info',return_value=image), \
             patch.object(driver.urllib.request,'urlopen',return_value=BytesIO(b'{"revision":"old"}')):
            with self.assertRaises(RuntimeError): driver.verify_project(project,{'sha':'a'*40})

    def test_digest_registry_and_service_set_are_exact(self):
        with self.assertRaises(ValueError):
            driver.prepare_images(POLICY['projects']['panel'], {'sha': 'a'*40, 'images': {'postgres': 'evil'}}, 'token', None)

    def test_revision_and_health_must_match_not_only_workflow_success(self):
        project = {'containers': {'app': 'a', 'worker': 'b'}, 'adapter': 'compose'}
        with patch.object(driver, 'inspect', return_value={'Image':'id','State':{'Running':True,'Health':{'Status':'healthy'}},'Config':{'Image':'ref'}}), \
             patch.object(driver, 'image_info', return_value={'Config':{'Labels':{'org.opencontainers.image.revision':'b'*40}}}):
            with self.assertRaises(RuntimeError): driver.verify_project(project, {'sha': 'a'*40})

    def test_two_services_and_project_without_softload(self):
        project = {'containers': {'api': 'independent-api', 'jobs': 'independent-worker'}, 'adapter': 'compose'}
        with patch.object(driver, 'inspect', return_value={'Image':'id','State':{'Running':True,'Health':{'Status':'healthy'}},'Config':{'Image':'ref'}}), \
             patch.object(driver, 'image_info', return_value={'Config':{'Labels':{'org.opencontainers.image.revision':'a'*40}}}):
            result = driver.verify_project(project, {'sha':'a'*40})
        self.assertEqual([s['container'] for s in result['services']], ['independent-api','independent-worker'])

    def test_compose_rolls_back_only_its_service_on_failure(self):
        project = POLICY['projects']['terrania']
        old = {'Config':{'Image':'old-image', 'Labels':{'com.docker.compose.project':'terrania-origins',
               'com.docker.compose.project.config_files':'/old/compose.yml'}}}
        calls = []
        def fake_run(args, **kwargs):
            calls.append(args)
            if 'config' in args:
                return json.dumps({'services':{'multiplayer':{'image':'old-image'}}}).encode()
            return b''
        with tempfile.TemporaryDirectory() as temp, patch.object(driver,'prepare_release',return_value=Path(temp)), \
             patch.object(driver,'inspect',return_value=old), patch.object(driver,'run',side_effect=fake_run), \
             patch.object(driver,'wait_healthy'), patch.object(driver,'verify_project',side_effect=RuntimeError('new service unhealthy')):
            with self.assertRaises(RuntimeError): driver.compose_activate(project,'a'*40,{'multiplayer':'new@sha256:abc'},None)
        updates = [args for args in calls if 'up' in args]
        self.assertEqual(len(updates),2)
        self.assertTrue(all(args[-1]=='multiplayer' and '--no-deps' in args for args in updates))
        self.assertIn('/old/compose.yml',updates[-1])
        self.assertFalse(any('softload' in token for args in calls for token in args))

    def test_no_destructive_cleanup_or_shared_restart_in_adapters(self):
        source = (Path(__file__).parent/'driver.py').read_text()
        self.assertNotIn("'prune'",source)
        self.assertNotIn("'down'",source)
        self.assertNotIn("'--remove-orphans'",source)
        self.assertNotIn("'docker', 'restart'",source)

if __name__ == '__main__':
    unittest.main()
