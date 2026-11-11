"""Offline contract tests: no Docker engine, VPS or GitHub access is used."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('workspace_build', Path(__file__).with_name('workspace_build.py'))
ws = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ws)


class WorkspacesTest(unittest.TestCase):
    def test_no_traversal_or_reserved_names(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            (base/'gh_12_abcdef12').mkdir()
            self.assertEqual(ws.project_dir('gh_12_abcdef12', base), base/'gh_12_abcdef12')
            for name in ('../root', '/etc', '--help', 'Geral', 'AdministracaoVPS', 'foo/bar', 'bad name', 'missing'):
                with self.subTest(name=name), self.assertRaises(ValueError):
                    ws.project_dir(name, base)
            (base/'malicious').symlink_to(base/'gh_12_abcdef12')
            with self.assertRaises(ValueError):ws.project_dir('malicious',base)

    def test_docker_argv_is_fixed_and_nonprivileged(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            for network in ('none','bridge'):
                args=ws.docker_args(path,source=path/'src',phase='echo verified',network=network)
                self.assertIn('--rm',args)
                self.assertIn('--read-only',args)
                self.assertIn('--cap-drop=ALL',args)
                self.assertIn('--user=61110:61110',args)
                self.assertIn('--network='+network,args)
                self.assertIn('--memory=1536m',args)
                self.assertFalse(any('docker.sock' in arg for arg in args))
                self.assertFalse(any('--privileged' in arg for arg in args))
                self.assertFalse(any('--publish' in arg for arg in args))
                self.assertEqual(args[-1],'echo verified')
            with self.assertRaises(ValueError): ws.docker_args(path,source=None,phase='true',network='host')

    def test_snapshot_is_offline_and_removes_sensitive_files(self):
        copy = ws.clean_copy_command()
        for name in ('.env', '.env.*', '.npmrc', '.git', 'node_modules'):
            self.assertIn(name, copy)
        self.assertEqual(ws.PROFILES['lhs-quick'][0][3], 'bridge')
        self.assertTrue(all(p[3] == 'none' for p in ws.PROFILES['lhs-quick'][1:]))

    def test_pipeline_runs_docker_only_on_fixed_profiles_and_cleans_files(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as jobs:
            root,jobs=Path(root),Path(jobs)
            (root/'gh_12_abcdef12').mkdir()
            (jobs/'0123456789abcdef').mkdir()
            ws.write_state(jobs/'0123456789abcdef',project='gh_12_abcdef12',profile='lhs-quick')
            calls=[]
            with patch.object(ws.os,'chown'), patch.object(ws.subprocess,'run',side_effect=lambda args,**kw:(calls.append((args,kw)) or subprocess.CompletedProcess(args,0))):
                ws.run_pipeline('0123456789abcdef',root,jobs)
            state=json.loads((jobs/'0123456789abcdef'/'status.json').read_text())
            self.assertEqual(state['status'],'passed')
            self.assertEqual(len(calls),5)
            self.assertIn('--network=none', calls[0][0])
            self.assertIn('--network=bridge', calls[1][0])
            self.assertTrue(all('--network=none' in c[0] for c in calls[2:]))
            self.assertFalse((jobs/'0123456789abcdef'/'source').exists())

    def test_nonzero_step_fails_closed_without_leaving_workspace(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as jobs:
            root,jobs=Path(root),Path(jobs)
            (root/'gh_12_abcdef12').mkdir();(jobs/'0123456789abcdef').mkdir()
            ws.write_state(jobs/'0123456789abcdef',project='gh_12_abcdef12',profile='lhs-quick')
            with patch.object(ws.os,'chown'), patch.object(ws.subprocess,'run',side_effect=[subprocess.CompletedProcess([],0),subprocess.CompletedProcess([],1)]):
                ws.run_pipeline('0123456789abcdef',root,jobs)
            state=ws.status('0123456789abcdef',jobs)
            self.assertFalse(state['success'])
            self.assertEqual(state['status'],'failed')
            self.assertIn('install',state['error'])
            self.assertFalse((jobs/'0123456789abcdef'/'source').exists())

    def test_status_has_bounded_output_and_rejects_traversal(self):
        with tempfile.TemporaryDirectory() as root:
            jobs=Path(root)
            with self.assertRaises(ValueError):ws.status('../../../../etc/passwd',jobs)
            with self.assertRaises(ValueError):ws.status('0'*16,jobs)
            (jobs/'0123456789abcdef').mkdir()
            ws.write_state(jobs/'0123456789abcdef',status='passed',pid=12345)
            (jobs/'0123456789abcdef'/'output.log').write_text('A'*20000)
            result=ws.status('0123456789abcdef',jobs)
            self.assertNotIn('pid',result)
            self.assertLessEqual(len(result['logTail']),4000)
            self.assertEqual(ws.redact('api_key=secret-value'), 'api_key=[OCULTO]')


    def test_start_is_admin_only_and_does_not_execute_build_inline(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as jobs:
            root,jobs=Path(root),Path(jobs)
            (root/'gh_12_abcdef12').mkdir()
            with patch.object(ws.os,'geteuid',return_value=1000):
                with self.assertRaises(PermissionError):
                    ws.start('gh_12_abcdef12','lhs-quick',root,jobs)
            class Child:
                pid=4321
            with patch.object(ws.os,'geteuid',return_value=0), patch.object(ws.secrets,'token_hex',return_value='0123456789abcdef'), patch.object(ws.subprocess,'Popen',return_value=Child()) as proc:
                result=ws.start('gh_12_abcdef12','lhs-quick',root,jobs)
            self.assertEqual(result,'0123456789abcdef')
            self.assertTrue(proc.call_args.kwargs['start_new_session'])
            self.assertEqual(proc.call_args.kwargs['stdin'],subprocess.DEVNULL)
            state=ws.status(result,jobs)
            self.assertEqual(state['status'],'queued')
            self.assertNotIn('pid',state)

    def test_concurrent_job_fails_closed_before_docker(self):
        import fcntl
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as jobs:
            root,jobs=Path(root),Path(jobs)
            (root/'gh_12_abcdef12').mkdir();(jobs/'0123456789abcdef').mkdir()
            ws.write_state(jobs/'0123456789abcdef',project='gh_12_abcdef12',profile='lhs-quick')
            lock=(jobs/'.active.lock');lock.touch()
            with lock.open('r+') as held:
                fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
                with patch.object(ws.subprocess,'run') as runner:
                    ws.run_pipeline('0123456789abcdef',root,jobs)
                runner.assert_not_called()
            self.assertEqual(ws.status('0123456789abcdef',jobs)['status'],'busy')

    def test_smoke_covers_game_systems_not_only_art(self):
        command = ws.PROFILES['lhs-quick'][-1][1]
        self.assertIn('node --test --test-concurrency=2', command)
        self.assertGreaterEqual(len(ws.LHS_SMOKE_TESTS), 30)
        self.assertEqual(len(ws.LHS_SMOKE_TESTS), len(set(ws.LHS_SMOKE_TESTS)))
        for domain in ('simulation', 'historical-economy', 'merchandise',
                       'customer-congestion', 'doorway-recovery', 'ps1-2002',
                       'ps2-integration', 'render-motion', 'local-save-recovery',
                       'angular-ui-foundation', 'services', 'story-events'):
            self.assertIn('tests/'+domain+'.test.mjs', command)
        self.assertNotIn('poster-modules.test.mjs', command)
        self.assertTrue(all(step[3] == 'none' for step in ws.PROFILES['lhs-quick'][1:]))

    def test_default_precommit_requires_full_game_and_angular(self):
        profile = ws.PROFILES['lhs-precommit']
        commands = [step[1] for step in profile]
        for command in ('npm run typecheck', 'npm run build', 'npm test',
                        'npm run lint --prefix frontend-angular',
                        'npm run build --prefix frontend-angular'):
            self.assertIn(command, commands)
        self.assertEqual(sum(1 for c in commands if c == 'npm test'), 1)
        self.assertTrue(all(step[3] == 'none' for step in profile[2:]))
        self.assertNotIn('npx playwright', ' '.join(commands))

    def test_snapshot_shell_command_parses(self):
        subprocess.run(['sh','-n','-c',ws.clean_copy_command()],check=True)


if __name__=='__main__':unittest.main()
