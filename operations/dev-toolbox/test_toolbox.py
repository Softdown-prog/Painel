"""Static opt-in toolbox safety contracts; real container checks run in Actions."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = (ROOT / 'operations' / 'dev-toolbox.Dockerfile').read_text()
SMOKE = (ROOT / 'operations' / 'dev-toolbox' / 'smoke.sh').read_text()
WORKFLOW = (ROOT / '.github' / 'workflows' / 'dev-toolbox-tests.yml').read_text()
REQUIREMENTS = (ROOT / 'operations' / 'dev-toolbox' / 'python-requirements.in').read_text()

class ToolboxPolicyTest(unittest.TestCase):
    def test_base_version_families_and_compatibility(self):
        for required in ('ubuntu:24.04', 'node:24-bookworm-slim',
                         'python:3.13-slim-bookworm', 'golang:1.26-bookworm',
                         'rust:1.97-slim-bookworm', 'PLAYWRIGHT_VERSION=1.56.1'):
            self.assertIn(required, DOCKERFILE)
        for command in ('npm install --global', 'pnpm@', 'yarn@',
                        'typescript@', 'python3 --version', 'playwright install --with-deps chromium'):
            self.assertIn(command, DOCKERFILE)
        for name in ('node:24-bookworm-slim', 'python:3.13-slim-bookworm',
                     'golang:1.26-bookworm', 'rust:1.97-slim-bookworm',
                     'ubuntu:24.04'):
            self.assertRegex(DOCKERFILE, name.replace('.', r'\\.')+r'@sha256:[a-f0-9]{64}')
        self.assertIn("PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers", DOCKERFILE)
        self.assertIn("playwright --version | grep '1.56.1'", SMOKE)

    def test_layers_are_explicit_not_daemon_or_agent_replacement(self):
        for target in ('core', 'languages', 'browser', 'full'):
            self.assertIn(' AS '+target, DOCKERFILE)
        self.assertLess(DOCKERFILE.index(' AS core'),DOCKERFILE.index(' AS languages'))
        self.assertLess(DOCKERFILE.index(' AS languages'),DOCKERFILE.index(' AS browser'))
        self.assertLess(DOCKERFILE.index(' AS browser'),DOCKERFILE.index(' AS full'))
        self.assertNotIn('docker.sock', DOCKERFILE)
        self.assertNotIn('ENTRYPOINT', DOCKERFILE)
        self.assertNotIn('supervisord', DOCKERFILE)
        self.assertIn('FROM browser AS default', DOCKERFILE)
        self.assertIn('CMD ["bash"]', DOCKERFILE)

    def test_no_real_deployment_from_ci(self):
        for action in ('--target core', '--target browser', '--target full'):
            self.assertIn(action, WORKFLOW)
        for boundary in ('--network none', '--read-only', '--cap-drop ALL',
                         '--user 61110:61110', '--memory 2048m'):
            self.assertIn(boundary, WORKFLOW)
        self.assertIn("inputs.full == true", WORKFLOW)
        self.assertNotIn('runs-on: self-hosted', WORKFLOW)
        self.assertNotIn('docker compose up', WORKFLOW)
        self.assertNotIn('docker compose down', WORKFLOW)
        self.assertNotIn('docker system prune', WORKFLOW)
        self.assertNotIn('docker.sock', WORKFLOW)
        self.assertNotIn('deployment', WORKFLOW)

    def test_full_python_requirements_are_bounded_but_not_misrepresented_as_lock(self):
        self.assertIn('not a frozen lock', REQUIREMENTS)
        packages=[x for x in REQUIREMENTS.splitlines() if x and not x.startswith('#')]
        self.assertGreaterEqual(len(packages), 18)
        for spec in packages:
            self.assertIn('>=', spec)
            self.assertIn('<', spec)
        self.assertIn('pytest', REQUIREMENTS)
        self.assertIn('scikit-learn', REQUIREMENTS)
        self.assertIn('python-pptx', REQUIREMENTS)

    def test_image_installer_is_explicit_and_does_not_touch_running_services(self):
        install=(ROOT/'operations'/'install-dev-toolbox-vps.sh').read_text()
        self.assertIn('"$1" != check && "$1" != apply',install)
        self.assertIn('if [[ "$mode" == check ]]; then',install)
        self.assertLess(install.index('if [[ "$mode" == check ]]; then'),
                        install.index('docker build --pull'))
        self.assertIn('docker run --rm --init --read-only --cap-drop ALL --network none',install)
        self.assertIn('find "$file" -maxdepth 0 -perm /022',install)
        self.assertIn('flock -n 9',install)
        self.assertIn('.active.lock',install)
        self.assertIn('dirty; no image was built',install)
        self.assertNotIn('docker compose down',install)
        self.assertNotIn('docker system prune',install)
        self.assertNotIn('docker.sock',install)
        self.assertNotIn('systemctl',install)
        self.assertNotIn('panel-lhs-qa:',install)

    def test_real_browser_and_canvas_are_tested(self):
        for s in ('chromium.launch(', "getContext('2d')",
                  'getImageData(1,1,1,1)', 'PASS: real Chromium and Canvas pixel',
                  "process.versions.node", '(3,13)'):
            self.assertIn(s, SMOKE)
        self.assertIn('if [ "$target" = full ]; then', SMOKE)

if __name__ == '__main__':
    unittest.main()
