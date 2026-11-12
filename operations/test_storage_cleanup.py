import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cleanup', Path(__file__).with_name('storage_cleanup.py'))
gc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gc)
A, B, C = ['sha256:' + x * 64 for x in 'abc']


def image(identity, ref):
    return {'Id': identity, 'RepoTags': [ref], 'RepoDigests': []}


class StorageCleanupTests(unittest.TestCase):
    def setUp(self):
        self.images = [image(A, 'example/app:current'), image(B, 'example/app:old')]
        self.containers = [{'Image': A, 'State': {'Running': False}}]

    def test_preserves_stopped_and_running_containers(self):
        state, targets = gc.plan(self.images, self.containers, {A: 0, B: 0}, 30000)
        self.assertNotIn(A, state)
        self.assertEqual([x['id'] for x in targets], [B])

    def test_first_observation_is_not_old_image_build_time(self):
        self.images[1]['Created'] = 1
        state, targets = gc.plan(self.images, self.containers, {}, 30000)
        self.assertEqual(state[B], 30000)
        self.assertEqual(targets, [])

    def test_quarantine_recency_future_and_boolean_values(self):
        for stamp in [29999, 40000, True]:
            _, targets = gc.plan(self.images, self.containers, {B: stamp}, 30000)
            self.assertEqual(targets, [])

    def test_stale_foreign_and_old_managed_images_can_be_reclaimed(self):
        self.images.append(image(C, 'other/project:spare'))
        _, targets = gc.plan(self.images, self.containers, {B: 0, C: 0}, 30000,
                             protected_refs=['example/app:old'])
        self.assertEqual([x['id'] for x in targets], [C])
        self.images[1]['RepoTags'].append('unregistered/spare:old')
        self.assertEqual([x['id'] for x in gc.plan(self.images, self.containers, {B: 0, C: 0}, 30000)[1]], [B, C])
        self.containers[0]['Config'] = {'Labels': {'com.softload.panel.managed': 'true'}}
        self.assertEqual([x['id'] for x in gc.plan(self.images, self.containers, {B: 0, C: 0}, 30000)[1]], [B, C])

    def test_pinned_toolbox_and_qa_images_survive_without_containers(self):
        for ref in sorted(gc.PINNED_TOOLBOX_REFS):
            self.images.append(image(C, ref))
            _, targets = gc.plan(self.images, self.containers, {B: 0, C: 0}, 30000)
            self.assertEqual([t['id'] for t in targets], [B])
            self.images.pop()

    def test_untagged_unused_image_is_eligible(self):
        self.images.append({'Id': C, 'RepoTags': [], 'RepoDigests': []})
        _, targets = gc.plan(self.images, self.containers, {B: 0, C: 0}, 30000)
        self.assertEqual([t['id'] for t in targets], [B, C])
        self.assertEqual(targets[-1]['refs'], [])

    def test_recent_imports_are_protected_only_during_staging(self):
        from datetime import datetime, timezone
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory)
            (folder/'image-imports.json').write_text(json.dumps([
                {'repository':'Softdown-prog/Tool', 'digest':'sha256:'+'a'*64,
                 'importedAt':datetime.fromtimestamp(10000,timezone.utc).isoformat()},
                {'repository':'Softdown-prog/Tool', 'digest':'sha256:'+'b'*64,
                 'importedAt':datetime.fromtimestamp(3000,timezone.utc).isoformat()}]))
            with patch.object(gc,'DATA',folder):
                refs=gc.protected_imports(now=11000)
                self.assertEqual(refs,['ghcr.io/softdown-prog/tool@sha256:'+'a'*64])


    def test_registry_port_and_digest_parsing(self):
        self.assertEqual(gc.repository('localhost:5000/shop/app:tag'), 'localhost:5000/shop/app')
        self.assertEqual(gc.repository('ghcr.io/user/app@sha256:abc'), 'ghcr.io/user/app')

    def test_docker_cli_uses_own_writable_config_not_root_home_or_credentials(self):
        with patch.object(gc.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run:
            gc.docker('buildx', 'du')
        environment=run.call_args.kwargs['env']
        self.assertEqual(environment['DOCKER_CONFIG'], str(gc.ROOT / 'docker-config'))
        self.assertEqual(environment['HOME'], str(gc.ROOT))
        self.assertNotIn('REGISTRY_TOKEN', environment)

    def test_reference_repoint_or_new_container_blocks_deletion(self):
        target = {'id': B, 'refs': ['example/app:old']}
        response = SimpleNamespace(returncode=0, stdout=json.dumps([{'Id': A}]))
        with patch.object(gc, 'inventory', return_value=(self.images, self.containers)), \
             patch.object(gc, 'protected_imports', return_value=[]), \
             patch.object(gc, 'docker', return_value=response) as docker:
            self.assertFalse(gc.remove_target(target))
            self.assertFalse(any('rm' in call.args for call in docker.call_args_list))
        with patch.object(gc, 'inventory', return_value=(self.images, [{'Image': B}])), \
             patch.object(gc, 'docker') as docker:
            self.assertFalse(gc.remove_target(target))
            docker.assert_not_called()

    def test_delete_is_nonforced_exact_reference_and_no_parent_prune(self):
        target = {'id': B, 'refs': ['example/app:old']}
        responses = [SimpleNamespace(returncode=0, stdout=json.dumps([{'Id': B}])),
                     SimpleNamespace(returncode=0, stdout=''),
                     SimpleNamespace(returncode=1, stdout='')]
        with patch.object(gc, 'inventory', return_value=(self.images, self.containers)), \
             patch.object(gc, 'protected_imports', return_value=[]), \
             patch.object(gc, 'docker', side_effect=responses) as docker:
            self.assertTrue(gc.remove_target(target))
            self.assertEqual(docker.call_args_list[1].args, ('image', 'rm', '--no-prune', 'example/app:old'))

    def test_untagged_deletion_uses_exact_image_id_without_force(self):
        target={'id':B,'refs':[]}
        replies=[SimpleNamespace(returncode=0,stdout=json.dumps([{'Id':B}])),
                 SimpleNamespace(returncode=0,stdout=''),
                 SimpleNamespace(returncode=1,stdout='')]
        untagged=[self.images[0],{'Id':B,'RepoTags':[],'RepoDigests':[]}]
        with patch.object(gc,'inventory',return_value=(untagged,self.containers)), \
             patch.object(gc,'protected_imports',return_value=[]), \
             patch.object(gc,'docker',side_effect=replies) as docker:
            self.assertTrue(gc.remove_target(target))
            self.assertEqual(docker.call_args_list[1].args,('image','rm','--no-prune',B))

    def test_newly_protected_digest_alias_blocks_stale_tag_deletion(self):
        digest='ghcr.io/demo/app@sha256:'+'e'*64
        self.images[1]['RepoDigests']=[digest]
        target={'id':B,'refs':['example/app:old']}
        with patch.object(gc,'inventory',return_value=(self.images,self.containers)), \
             patch.object(gc,'protected_imports',return_value=[digest]), \
             patch.object(gc,'docker') as docker:
            self.assertFalse(gc.remove_target(target))
            docker.assert_not_called()

    def test_symlink_maintenance_metadata_refused(self):
        import os
        if os.name == 'nt':
            self.skipTest('Linux symlink boundary runs in CI')
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'outside'; target.write_text('{}')
            link = Path(directory) / 'link'; link.symlink_to(target)
            with self.assertRaises(ValueError):
                gc.read_json(link, {})
            with self.assertRaises(ValueError):
                gc.atomic(link, {})

    def test_busy_deployment_lock_refuses_concurrent_acquisition(self):
        import os
        if os.name == 'nt':
            self.skipTest('Real flock boundary runs in Linux CI')
        import fcntl
        from contextlib import ExitStack
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with (root / 'test.lock').open('a') as held:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with patch.object(gc, 'BROKER', root), patch.object(gc, 'deployment_locks', return_value={root / 'test.lock'}):
                    with ExitStack() as stack, self.assertRaises(BlockingIOError):
                        gc.lock_deployments(stack)


if __name__ == '__main__':
    unittest.main()
