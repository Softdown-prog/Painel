"""Codex sidecar rollout regression: isolated, no Docker or production writes."""
import copy
import json
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch
import admission
import codex
import receiver

SHA = 'a' * 40
IMAGE = 'ghcr.io/softdown-prog/painel-codex@sha256:' + 'b' * 64
OLD = 'vps-panel-codex:f3046f6'
ROOT = Path(__file__).resolve().parent


def container(name, image=OLD):
    service = 'api' if name == codex.API else codex.SERVICE
    result = {
        'Name':'/'+name,'Id':'container-'+name,
        'Config':{'Image':image,'User':'61110:61110',
                  'Labels':{'com.docker.compose.project':codex.PROJECT,
                            'com.docker.compose.service':service}},
        'State':{'Running':True,'Health':{'Status':'healthy'}},
        'Mounts':[{'Type':'bind','Destination':target,'Source':source,'RW':not read_only}
                  for target,(source,read_only) in codex.BINDS.items()],
        'HostConfig':{'ReadonlyRootfs':True,'Privileged':False,'CapAdd':None,
                      'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true',
                      'apparmor=panel-codex','seccomp=/etc/softload-panel/codex-seccomp.json'],
                      'PortBindings':None,'Memory':1024**3,'NanoCpus':1500000000,
                      'PidsLimit':128}
    }
    return result


class CodexPolicy(unittest.TestCase):
    def test_one_registered_service_and_exact_authorized_workflow(self):
        policy=json.loads((ROOT/'policy.example.json').read_text())
        project=policy['projects']['panel-codex']
        self.assertEqual(project['adapter'],'codex')
        self.assertEqual(project['containers'],{codex.SERVICE:codex.CONTAINER})
        self.assertEqual(project['images'],{codex.SERVICE:'ghcr.io/softdown-prog/painel-codex'})
        self.assertEqual(admission.contract(project)['services'][codex.SERVICE]['profile'],'codex-bridge')
        repo=policy['repositories']['1433232532']
        self.assertEqual(repo['workflows'].count('stage-codex-bridge.yml'),1)
        claims={'iss':receiver.ISSUER,'aud':receiver.AUDIENCE,'iat':1234,
                'nbf':1234,'exp':2345,'actor_id':'189416996',
                'repository_id':'1433232532','repository':'Softdown-prog/Painel',
                'ref':'refs/heads/main','event_name':'push',
                'workflow_ref':'Softdown-prog/Painel/.github/workflows/stage-codex-bridge.yml@refs/heads/main',
                'sha':SHA,'run_id':'123'}
        self.assertEqual(receiver.validate_claims(claims,policy,'panel-codex','deploy',now=1235)['name'],
                         'Softdown-prog/Painel')
        for key,value in [('actor_id','0'),('workflow_ref','Softdown-prog/Painel/.github/workflows/evil.yml@refs/heads/main'),
                          ('event_name','pull_request'),('ref','refs/heads/feature')]:
            with self.subTest(key=key),self.assertRaises(ValueError):
                receiver.validate_claims(dict(claims,**{key:value}),policy,'panel-codex','deploy',now=1235)

    def test_single_codex_pipeline_and_no_unrelated_auto_redeploy(self):
        workflows=ROOT.parent/'.github'/'workflows'
        stage=(workflows/'stage-codex-bridge.yml').read_text()
        self.assertFalse((workflows/'codex-agents.yml').exists())
        for suite in ('bridge.test.mjs','operations.test.mjs','telemetry.test.mjs','sandbox-smoke.mjs'):
            self.assertIn(suite,stage)
        self.assertIn('PANEL_CODEX_DEPLOY_ENABLED',stage)
        self.assertIn('environment: vps-maintenance',stage)
        self.assertIn('VPS_PROJECT: panel-codex',stage)
        self.assertIn('inputs.activate == true',stage)
        for other in ('deploy-vps.yml','deploy-pages.yml'):
            contents=(workflows/other).read_text()
            self.assertIn('paths:',contents)
            self.assertNotIn("'agents/**'",contents)
            self.assertNotIn('panel-codex',contents)

    def test_no_access_added_to_other_github_repositories(self):
        policy=json.loads((ROOT/'policy.example.json').read_text())
        terrania=policy['repositories']['1438758092']
        self.assertNotIn('panel-codex',terrania['projects'])
        self.assertNotIn('stage-codex-bridge.yml',terrania['workflows'])

    def test_credential_free_candidate_and_executable_image_identity(self):
        project=json.loads((ROOT/'policy.example.json').read_text())['projects']['panel-codex']
        cmd=admission.candidate_command('codex-admission',IMAGE,{'profile':'codex-bridge'},SHA,'fake-secret')
        text=' '.join(cmd)
        for forbidden in ('/var/run/docker.sock','/srv/panel-codex','--publish','--privileged','--env-file'):
            self.assertNotIn(forbidden,text)
        self.assertIn('--network none',text)
        self.assertIn('--read-only',text)
        self.assertIn('setInterval',text)
        with patch.object(admission,'docker',side_effect=[
            b'',b'codex-cli 0.167.0']):
            admission.probe('fake',{'profile':'codex-bridge'},SHA,'fake',{'State':{'Pid':123}})
        self.assertEqual(project['images'][codex.SERVICE]+'@sha256:'+'b'*64,IMAGE)
        with patch.object(admission,'docker',side_effect=[b'',b'codex-cli 0.001.0']):
            with self.assertRaises(ValueError):
                admission.probe('fake',{'profile':'codex-bridge'},SHA,'fake',{'State':{'Pid':123}})


class CodexIsolation(unittest.TestCase):
    def test_deny_insecure_existing_service_configuration(self):
        original=container(codex.CONTAINER)
        codex._assert_container(original)
        for path,value in [(('HostConfig','Privileged'),True),
                           (('HostConfig','ReadonlyRootfs'),False),
                           (('HostConfig','Memory'),512),
                           (('HostConfig','PortBindings'),{'8091/tcp':[{'HostPort':'8091'}]}),
                           (('Config','User'),'root')]:
            bad=copy.deepcopy(original)
            bad[path[0]][path[1]]=value
            with self.subTest(path=path),self.assertRaises(ValueError):
                codex._assert_container(bad)
        bad=copy.deepcopy(original)
        bad['Mounts'].append({'Type':'bind','Source':'/var/run/docker.sock',
                              'Destination':'/var/run/docker.sock','RW':True})
        with self.assertRaises(ValueError):codex._assert_container(bad)

    def test_deny_untrusted_compose_security_change(self):
        config={'services':{codex.SERVICE:{
            'image':IMAGE,'user':'61110:61110','read_only':True,
            'networks':{'proxy':{},'codex_egress':{}},
            'cap_drop':['ALL'],'security_opt':['apparmor=panel-codex',
                     'seccomp=/etc/softload-panel/codex-seccomp.json'],
            'pids_limit':128,
            'volumes':[{'type':'bind','source':src,'target':dst,'read_only':ro}
                       for dst,(src,ro) in codex.BINDS.items()]
        }}}
        with patch.object(codex,'run',return_value=json.dumps(config)):
            codex._check_compose(['docker','compose'],IMAGE)
        bad=copy.deepcopy(config)
        bad['services'][codex.SERVICE]['volumes'].append(
            {'type':'bind','source':'/var/run/docker.sock','target':'/var/run/docker.sock'})
        with patch.object(codex,'run',return_value=json.dumps(bad)),self.assertRaises(ValueError):
            codex._check_compose(['docker','compose'],IMAGE)


class CodexActivation(unittest.TestCase):
    def fixture(self,root,*,fail=False):
        overlay=Path(root)/'compose.install.yaml'
        original={'services':{codex.SERVICE:{'image':OLD}}}
        overlay.write_text(json.dumps(original))
        current={'image':OLD}
        calls=[]
        def mocked_inspect(name):
            return container(name,current['image'])
        def mocked_run(argv,**kwargs):
            calls.append(argv)
            if argv[-3:] == ['config','--format','json']:
                return json.dumps({'services':{codex.SERVICE:{'image':OLD}}})
            if 'up' in argv:
                current['image']=json.loads(overlay.read_text())['services'][codex.SERVICE]['image']
                return b''
            return b''
        def verify(project,args):
            if fail:raise RuntimeError('New image failed verification')
            if current['image']!=IMAGE:raise RuntimeError('Unexpected image')
            return {'services':[{'service':codex.SERVICE,'revision':args['sha']}], 'publicVerified':False}
        return overlay,original,current,calls,mocked_inspect,mocked_run,verify

    def run_case(self,fail=False):
        with tempfile.TemporaryDirectory() as root:
            overlay,original,current,calls,ins,run,verify=self.fixture(root,fail=fail)
            project={'adapter':'codex','containers':{codex.SERVICE:codex.CONTAINER}}
            with patch.object(codex,'inspect',side_effect=ins),\
                 patch.object(codex,'run',side_effect=run),\
                 patch.object(codex,'_compose_args',return_value=(['docker','compose'],overlay)),\
                 patch.object(codex,'_check_compose'),\
                 patch.object(codex,'_other_ids',return_value={'unrelated':'same-id'}),\
                 patch.object(codex,'wait_healthy'),\
                 patch.object(codex,'verify_project',side_effect=verify):
                if fail:
                    with self.assertRaises(RuntimeError):
                        codex.codex_activate(project,SHA,{codex.SERVICE:IMAGE},None)
                    self.assertEqual(current['image'],OLD)
                    self.assertEqual(json.loads(overlay.read_text()),original)
                else:
                    result=codex.codex_activate(project,SHA,{codex.SERVICE:IMAGE},None)
                    self.assertTrue(result['unrelatedServicesPreserved'])
                    self.assertEqual(current['image'],IMAGE)
                    self.assertEqual(json.loads(overlay.read_text())['services'][codex.SERVICE]['image'],IMAGE)
            ups=[argv for argv in calls if 'up' in argv]
            self.assertEqual(len(ups),2 if fail else 1)
            for argv in ups:
                self.assertEqual(argv[-1],codex.SERVICE)
                for guard in ('--no-deps','--no-build','--pull','never'):
                    self.assertIn(guard,argv)
                self.assertNotIn('down',argv)
            return True

    def test_success_replaces_only_codex(self):
        self.run_case(False)

    def test_failed_install_restores_prior_image_and_overlay(self):
        self.run_case(True)

    def test_failed_preflight_does_not_restart_an_active_chat(self):
        with tempfile.TemporaryDirectory() as root:
            overlay,original,current,calls,ins,run,verify=self.fixture(root)
            project={'adapter':'codex','containers':{codex.SERVICE:codex.CONTAINER}}
            with patch.object(codex,'inspect',side_effect=ins),\
                 patch.object(codex,'run',side_effect=run),\
                 patch.object(codex,'_compose_args',return_value=(['docker','compose'],overlay)),\
                 patch.object(codex,'_check_compose',side_effect=[None,ValueError('Unsafe overlay')]),\
                 patch.object(codex,'_other_ids',return_value={'unrelated':'same-id'}),\
                 patch.object(codex,'wait_healthy'),\
                 patch.object(codex,'verify_project',side_effect=verify):
                with self.assertRaises(ValueError):
                    codex.codex_activate(project,SHA,{codex.SERVICE:IMAGE},None)
            self.assertEqual(current['image'],OLD)
            self.assertEqual(json.loads(overlay.read_text()),original)
            self.assertFalse(any('up' in argv for argv in calls))

    def test_opt_in_script_is_syntax_valid_and_no_unsafe_container_commands(self):
        source=(ROOT/'upgrade-vpsops-codex.sh').read_text()
        subprocess.run(['bash','-n',str(ROOT/'upgrade-vpsops-codex.sh')],
                       check=True,capture_output=True)
        self.assertIn('[[ "$EUID" -eq 0',source)
        self.assertIn('os.replace',source)
        self.assertNotIn('docker compose down',source)
        self.assertNotIn('docker restart',source)
        self.assertNotIn('rm -rf /srv/panel-codex',source)



if __name__=='__main__':
    unittest.main()
