import copy
from io import BytesIO
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import admission as gate
import driver
import receiver
import importlib.util

SHA = 'a' * 40
REF = 'ghcr.io/example/service@sha256:' + 'b' * 64


def project():
    return {'adapter': 'compose', 'repository': 'example/service', 'images': {'app': 'ghcr.io/example/service'},
            'containers': {'app': 'independent-app'}, 'admission': {'version': 1, 'services': {
                'app': {'profile': 'http-json', 'port': 8787, 'path': '/health', 'revisionField': 'revision'}}}}


def isolated():
    return {'Config': {'User': '65534:65534'}, 'State': {'Running': True, 'Pid': 123},
            'Mounts': [], 'HostConfig': {'NetworkMode': 'none', 'ReadonlyRootfs': True,
            'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges:true'], 'Memory': 192 * 1024 ** 2,
            'MemorySwap': 192 * 1024 ** 2, 'NanoCpus': 500000000, 'PidsLimit': 64}}


class Contract(unittest.TestCase):
    def test_exact_variable_services_two_independent_projects(self):
        p = project()
        self.assertEqual(gate.contract(p)['services']['app']['port'], 8787)
        other = copy.deepcopy(p)
        other['repository'] = 'other/project'
        other['containers']['jobs'] = 'other-jobs'
        other['images']['jobs'] = 'ghcr.io/other/jobs'
        other['admission']['services']['jobs'] = {'profile': 'panel-executor'}
        self.assertEqual(len(gate.contract(other)['services']), 2)
        self.assertEqual(len(gate.contract(p)['services']), 1)

    def test_missing_contract_unknown_profile_and_removed_service_fail_closed(self):
        for transform in [lambda p: p.pop('admission'),
                          lambda p: p['admission'].update(version=2),
                          lambda p: p['admission']['services']['app'].update(profile='bash'),
                          lambda p: p['admission']['services'].update(agent={'profile': 'panel-executor'})]:
            p = project(); transform(p)
            with self.assertRaises(gate.AdmissionRejected) as error:
                gate.contract(p)
            self.assertEqual(error.exception.receipt['checks'][-1]['check'], 'contract')

    def test_no_repo_supplied_shell_env_mount_or_unbounded_probe(self):
        for field, value in [('command', 'sudo bash'), ('env', {'TOKEN': 'secret'}),
                             ('path', 'http://example.test'), ('port', 80), ('port', True),
                             ('timeout', 9999), ('revisionField', '../../secret')]:
            p = project(); p['admission']['services']['app'][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(gate.AdmissionRejected):
                gate.contract(p)

    def test_all_example_projects_have_server_contracts(self):
        p = json.loads((Path(__file__).parent / 'policy.example.json').read_text())
        for value in p['projects'].values():
            gate.contract(value)

    def test_candidate_no_production_network_data_socket_or_environment(self):
        for profile in ('panel-api', 'panel-executor', 'panel-web', 'http-json'):
            rule = dict(project()['admission']['services']['app'], profile=profile)
            argv = gate.candidate_command('vps-admission-test', REF, rule, SHA, 'synthetic')
            self.assertEqual(argv[argv.index('--network') + 1], 'none')
            self.assertIn('--read-only', argv)
            self.assertIn('65534:65534', argv)
            self.assertNotIn('--mount', argv)
            self.assertNotIn('--publish', argv)
            self.assertNotIn('--env-file', argv)
            self.assertNotIn('/var/run/docker.sock', ' '.join(argv))
            self.assertIn('--pids-limit', argv)
            self.assertIn('--memory-swap', argv)

    def test_inspection_catches_mounts_network_or_privilege_regression(self):
        self.assertTrue(gate.isolation(isolated()))
        for field, value in [('NetworkMode', 'host'), ('Privileged', True), ('Memory', 0),
                             ('Binds', ['/var/run/docker.sock:/socket']), ('CapAdd', ['SYS_ADMIN'])]:
            candidate = isolated(); candidate['HostConfig'][field] = value
            self.assertFalse(gate.isolation(candidate))
        candidate = isolated(); candidate['Mounts'] = [{'Type': 'volume', 'Destination': '/data'}]
        self.assertFalse(gate.isolation(candidate))


class Gate(unittest.TestCase):
    def fake_docker(self, argv, **kwargs):
        self.calls.append(argv)
        if argv[:2] == ['image', 'inspect']:
            return json.dumps([{'Config': {'Labels': {'org.opencontainers.image.revision': SHA,
                'org.opencontainers.image.source': 'https://github.com/example/service'}}}]).encode()
        if argv[0] == 'inspect':
            return json.dumps([isolated()]).encode()
        return b''

    def setUp(self):
        self.calls = []

    def test_success_and_temporary_container_removed(self):
        with patch.object(gate, 'docker', side_effect=self.fake_docker), patch.object(gate, 'probe'):
            receipt = gate.admit(project(), SHA, {'app': REF})
        self.assertEqual(receipt['status'], 'passed')
        self.assertEqual(self.calls[-1][:2], ['rm', '-f'])
        self.assertTrue(self.calls[-1][2].startswith('vps-admission-'))
        self.assertFalse(any('independent-app' in call for call in self.calls))

    def test_failed_candidate_or_timeout_never_reaches_activation(self):
        for failure in (subprocess.TimeoutExpired('probe', 1), subprocess.CalledProcessError(1, 'probe')):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory, \
                 patch.object(driver, 'prepare_images', return_value={'app': REF}), \
                 patch.object(gate, 'docker', side_effect=self.fake_docker), \
                 patch.object(gate, 'probe', side_effect=failure), patch.object(gate.time, 'sleep'), \
                 patch.object(gate.time, 'monotonic', side_effect=[0, 0, 0, 40]), \
                 patch.object(driver, 'compose_activate') as activate:
                with self.assertRaises(gate.AdmissionRejected) as error:
                    driver.deploy(project(), {'sha': SHA}, 'secret-registry-token', Path(directory))
                activate.assert_not_called()
                self.assertEqual(error.exception.receipt['status'], 'rejected')
                self.assertIs(error.exception.receipt['productionChanged'], False)
                self.assertNotIn('secret-registry-token', json.dumps(error.exception.receipt))
                self.assertEqual(self.calls[-1][:2], ['rm', '-f'])

    def test_missing_contract_blocks_before_any_download(self):
        p = project(); p.pop('admission')
        with tempfile.TemporaryDirectory() as directory, patch.object(driver, 'prepare_images') as images:
            with self.assertRaises(gate.AdmissionRejected):
                driver.deploy(p, {'sha': SHA}, 'token', Path(directory))
            images.assert_not_called()

    def test_wrong_source_sha_or_digest_never_starts_container(self):
        for ref, labels in [(REF + 'bad', {}), (REF, {}), (REF, {
                'org.opencontainers.image.revision': SHA, 'org.opencontainers.image.source': 'evil'})]:
            with patch.object(gate, 'docker', return_value=json.dumps([{'Config': {'Labels': labels}}]).encode()) as dock:
                with self.assertRaises(gate.AdmissionRejected):
                    gate.admit(project(), SHA, {'app': ref})
                self.assertFalse(any(call.args[0][0] == 'create' for call in dock.call_args_list))

    def test_image_declared_volume_rejected_before_docker_creates_anonymous_volume(self):
        image = {'Config': {'Labels': {'org.opencontainers.image.revision': SHA,
                 'org.opencontainers.image.source': 'https://github.com/example/service'}, 'Volumes': {'/data': {}}}}
        with patch.object(gate, 'docker', return_value=json.dumps([image]).encode()) as dock:
            with self.assertRaises(gate.AdmissionRejected):
                gate.admit(project(), SHA, {'app': REF})
            self.assertEqual(dock.call_count, 1)

    def test_cannot_promote_if_cleanup_fails(self):
        def fail_cleanup(argv, **kwargs):
            if argv[0] == 'rm':
                raise subprocess.CalledProcessError(1, 'docker')
            return self.fake_docker(argv, **kwargs)
        with patch.object(gate, 'docker', side_effect=fail_cleanup), patch.object(gate, 'probe'):
            with self.assertRaises(gate.AdmissionRejected) as error:
                gate.admit(project(), SHA, {'app': REF})
            self.assertEqual(error.exception.receipt['checks'][-1]['check'], 'cleanup')

    def test_success_receipt_is_in_real_deploy_result(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(driver, 'prepare_images', return_value={'app': REF}), \
             patch.object(driver, 'admit', return_value={'status': 'passed'}) as admit, \
             patch.object(driver, 'compose_activate', return_value={'services': []}) as activate:
            result = driver.deploy(project(), {'sha': SHA}, 'token', Path(directory))
            admit.assert_called_once()
            activate.assert_called_once()
            self.assertEqual(result['admission']['status'], 'passed')


class Installer(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('admission_installer', Path(__file__).with_name('install-admission-vps.py'))
        self.installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.installer)

    def test_preserves_local_adapters_and_places_gate_before_every_activation(self):
        source = '''import os
def deploy(project, args, token, state):
    with open('log', 'ab') as log:
        try:
            images = prepare_images(project, args, token, log)
            if project['adapter'] == 'shadow':
                from shadow import shadow_activate
                return shadow_activate(project, sha, images, log)
            return compose_activate(project, sha, images, log)
        except BaseException:
            raise
'''
        result = self.installer.patch_driver(source)
        self.assertIn('from shadow import shadow_activate', result)
        self.assertIn('return dict((shadow_activate(project, sha, images, log)), admission=admission)', result)
        self.assertLess(result.index('contract(project)'), result.index('prepare_images'))
        self.assertLess(result.index('admit(project, sha, images)'), result.index('return dict'))
        with self.assertRaises(ValueError):
            self.installer.patch_driver(result)
        with self.assertRaises(ValueError):
            self.installer.patch_driver('unknown = True')

    def test_receiver_keeps_identity_checks_and_failed_duplicate_exit(self):
        source = (Path(__file__).parent / 'receiver.py').read_text(encoding='utf-8')
        # Compare with the actual pre-upgrade source to prevent permissive replacement.
        source = source.replace('\nfrom admission import AdmissionRejected', '')
        source = source.replace("        print(json.dumps(dict(previous, duplicate=True)))\n        sys.exit(previous['exitCode'])",
                                '        print(json.dumps(dict(previous, duplicate=True))); return')
        source = source.replace("        if isinstance(error, AdmissionRejected):\n            result['error'] = 'Versão rejeitada pelos testes de entrada; produção preservada.'\n            result['admission'] = error.receipt\n", '')
        result = self.installer.patch_receiver(source)
        self.assertIn("sys.exit(previous['exitCode'])", result)
        self.assertIn("args.get('sha') != claims['sha']", result)
        self.assertIn('result[\'admission\'] = error.receipt', result)


class HttpContract(unittest.TestCase):
    def test_session_auth_and_edge_checks_use_only_disposable_identity(self):
        import admission_probe
        class Response:
            def __init__(self, status, body): self.status, self.body = status, body
            def read(self, maximum): return json.dumps(self.body).encode()
            def getheader(self, header): return None
        class Connection:
            replies = []
            def __init__(self, host, port, timeout):
                assert host == '127.0.0.1' and port == 8080
            def request(self, *args): pass
            def getresponse(self): return self.replies.pop(0)
            def close(self): pass
        Connection.replies = [Response(200, {'revision': SHA, 'authenticated': False, 'setupRequired': True}),
                              Response(401, {}), Response(401, {}), Response(404, {})]
        with patch.object(admission_probe.http.client, 'HTTPConnection', Connection):
            admission_probe.test_contract({'profile': 'panel-api'}, SHA, 'synthetic')
        Connection.replies = [Response(200, {'revision': SHA, 'authenticated': False, 'setupRequired': True}), Response(200, {})]
        with patch.object(admission_probe.http.client, 'HTTPConnection', Connection), self.assertRaises(ValueError):
            admission_probe.test_contract({'profile': 'panel-api'}, SHA, 'synthetic')


if __name__ == '__main__':
    unittest.main()
