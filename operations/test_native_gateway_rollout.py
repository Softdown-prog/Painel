import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest


class NativeGatewayGuards(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = Path(__file__).parent.parent / 'server' / 'install-native-gateway-7202ad1.py'
        if not source.exists():
            source = Path(__file__).parent / 'panel-native-wake-rollout.py'
        spec = importlib.util.spec_from_file_location('gateway_rollout', source)
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def setUp(self):
        self.api = {'Config': {'Labels': {'org.opencontainers.image.revision': self.module.SHA}},
                    'State': {'Health': {'Status': 'healthy'}}}
        self.gateway = {'Config': {'Labels': {'com.docker.compose.project': 'softload-panel',
                                             'com.docker.compose.service': 'app-wake'}},
                        'State': {'Health': {'Status': 'healthy'}}}
        self.current = Path('/opt/vps-panel/releases') / self.module.SHA / 'server'
        self.files = [str(self.current / 'compose.yaml'), str(self.current / 'compose.install.yaml')]

    def test_only_verified_revision_and_owned_gateway_are_accepted(self):
        self.assertEqual(self.module.validate_sources(self.api, self.gateway, self.current, self.files),
                         self.current / 'compose.install.yaml')
        for container, key, value in [('api', 'org.opencontainers.image.revision', 'a'*40),
                                       ('gateway', 'com.docker.compose.project', 'other-project'),
                                       ('gateway', 'com.docker.compose.service', 'api')]:
            api, gateway = copy.deepcopy(self.api), copy.deepcopy(self.gateway)
            target = api if container == 'api' else gateway
            target['Config']['Labels'][key] = value
            with self.assertRaises(RuntimeError):
                self.module.validate_sources(api, gateway, self.current, self.files)

    def test_unhealthy_or_divergent_release_cannot_be_modified(self):
        for key in ['api', 'gateway']:
            api, gateway = copy.deepcopy(self.api), copy.deepcopy(self.gateway)
            (api if key == 'api' else gateway)['State']['Health']['Status'] = 'unhealthy'
            with self.assertRaises(RuntimeError):
                self.module.validate_sources(api, gateway, self.current, self.files)
        with self.assertRaises(RuntimeError):
            self.module.validate_sources(self.api, self.gateway, self.current.parent, self.files)

    def test_missing_and_foreign_overlays_are_rejected(self):
        for files in [[], self.files[:1], self.files + ['/other/project/compose.yaml']]:
            with self.assertRaises(RuntimeError):
                self.module.validate_sources(self.api, self.gateway, self.current, files)

    def test_atomic_config_write_preserves_private_original_for_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'compose.install.yaml'
            original = b'{"services":{"api":{"image":"existing"}}}\n'
            config.write_bytes(original)
            self.module.write_atomic(config, b'{"services":{"app-wake":{"image":"candidate"}}}\n')
            self.assertNotEqual(config.read_bytes(), original)
            self.module.write_atomic(config, original)
            self.assertEqual(config.read_bytes(), original)
            self.assertFalse(config.with_name(config.name + '.native-next').exists())


if __name__ == '__main__':
    unittest.main()
