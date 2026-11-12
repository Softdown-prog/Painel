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
                self.assertIn('--workdir=/work',args)
                self.assertNotIn('--workdir=/work/games/lan_house_simulator',args)
                self.assertIn('--memory=1536m',args)
                self.assertFalse(any('docker.sock' in arg for arg in args))
                self.assertFalse(any('--privileged' in arg for arg in args))
                self.assertFalse(any('--publish' in arg for arg in args))
                self.assertEqual(args[-1],'echo verified')
            run_args=ws.docker_args(path,source=None,phase='npm run build',network='none')
            self.assertIn('--workdir=/work/games/lan_house_simulator',run_args)
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

    def test_real_gameplay_and_browser_are_mandatory_precommit(self):
        profile = ws.PROFILES['lhs-precommit']
        self.assertEqual(ws.IMAGE, 'panel-lhs-qa:node24-pw1.56.1')
        commands = [step[1] for step in profile]
        visual = [step[0] for step in ws.LHS_VISUAL]
        self.assertGreaterEqual(len(visual), 8)
        for step in ('canonical-site', 'site-desktop-mobile',
                     'canvas-desktop-mobile', 'canvas-pixel-cache',
                     'layout-touch-and-save', 'mobile-gameplay',
                     'ps1-integrated', 'ps2-integrated'):
            self.assertIn(step, visual)
            self.assertIn(step, [s[0] for s in profile])
        self.assertTrue(all(s[3] == 'none' for s in profile[2:]))
        self.assertIn('npm test', commands)
        self.assertTrue(all(s[3] == 'none' for s in ws.LHS_VISUAL))
        self.assertEqual(ws.PROFILES['lhs-visual'][-len(ws.LHS_VISUAL):], ws.LHS_VISUAL)
        self.assertEqual(ws.PROFILES['lhs-quick'][-1][0], 'game-smoke')

    def test_legacy_browser_exercises_real_game_before_angular_replaces_dist(self):
        for profile_name in ('lhs-visual','lhs-precommit'):
            steps=ws.PROFILES[profile_name]
            names=[step[0] for step in steps]
            self.assertLess(names.index('build'),names.index('canvas-desktop-mobile'))
            self.assertLess(names.index('canvas-desktop-mobile'),names.index('layout-touch-and-save'))
            self.assertLess(names.index('ps2-integrated'),names.index('canonical-site'))
            self.assertLess(names.index('canonical-site'),names.index('site-desktop-mobile'))
            self.assertEqual(steps[-1][0],'site-desktop-mobile')
            self.assertIn('node scripts/verify_live_site_preview.mjs', steps[-1][1])
        self.assertEqual(ws.LHS_VISUAL, ws.LHS_GAME_BROWSER+ws.LHS_CANONICAL_SITE)

    def test_ps1_and_ps2_video_have_bounded_resources_and_headroom_gate(self):
        with tempfile.TemporaryDirectory() as folder:
            work=Path(folder)
            normal=ws.docker_args(work,source=None,phase='true',video=False)
            video=ws.docker_args(work,source=None,phase='true',video=True)
            self.assertIn('--memory=1536m',normal)
            self.assertIn('--cpus=1.5',normal)
            self.assertIn('--memory=2048m',video)
            self.assertIn('--memory-swap=2048m',video)
            self.assertIn('--cpus=2.0',video)
            self.assertIn('--shm-size=384m',video)
            for step in ws.LHS_GAME_BROWSER:
                if step[0].startswith('ps'):
                    self.assertIn('node scripts/verify_ps',step[1])
        with patch.object(ws.Path,'read_text',return_value='MemTotal: 4194304 kB\\nMemAvailable: 2228224 kB\\n'):
            self.assertFalse(ws.enough_memory_for_video())
        with patch.object(ws.Path,'read_text',return_value='MemAvailable: 5242880 kB\\n'):
            self.assertTrue(ws.enough_memory_for_video())

    def test_video_phase_fails_before_container_when_memory_is_low(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as jobs:
            root,jobs=Path(root),Path(jobs)
            (root/'gh_12_abcdef12').mkdir()
            (jobs/'0123456789abcdef').mkdir()
            ws.write_state(jobs/'0123456789abcdef',project='gh_12_abcdef12',profile='lhs-visual')
            observed=[]
            def stub_run(argv,**kwargs):
                observed.append(argv)
                return subprocess.CompletedProcess(argv,0)
            with patch.object(ws.os,'chown'),patch.object(ws.subprocess,'run',side_effect=stub_run),patch.object(ws,'enough_memory_for_video',return_value=False):
                ws.run_pipeline('0123456789abcdef',root,jobs)
            result=ws.status('0123456789abcdef',jobs)
            self.assertEqual(result['status'],'failed')
            self.assertEqual(result['current'],'ps1-integrated')
            self.assertIn('memória livre insuficiente',result['error'])
            self.assertFalse(any('verify_ps1' in ' '.join(a) for a in observed))

    def test_container_names_are_fixed_for_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder)
            ok='panel-ws-0123456789abcdef-0'
            args = ws.docker_args(work, source=None, phase='node -v', container_name=ok)
            self.assertIn('--name='+ok, args)
            self.assertIn('--shm-size=256m', args)
            for malformed in ('--privileged', 'another-container', 'panel-ws-0123456789abcdef-99-extra'):
                with self.subTest(malformed=malformed), self.assertRaises(ValueError):
                    ws.docker_args(work,source=None,phase='true',container_name=malformed)

    def test_timeout_forces_only_own_disposable_container_offline(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as jobs:
            root,jobs=Path(root),Path(jobs)
            (root/'gh_12_abcdef12').mkdir()
            (jobs/'0123456789abcdef').mkdir()
            ws.write_state(jobs/'0123456789abcdef',
                           project='gh_12_abcdef12',profile='lhs-quick')
            invoked=[]
            def fake_run(argv,**kwargs):
                invoked.append(argv)
                if len(invoked)==2:
                    raise subprocess.TimeoutExpired(argv,timeout=120)
                return subprocess.CompletedProcess(argv,0)
            with patch.object(ws.os,'chown'), patch.object(ws.subprocess,'run',side_effect=fake_run):
                ws.run_pipeline('0123456789abcdef',root,jobs)
            self.assertEqual(invoked[2], ['docker','rm','-f','panel-ws-0123456789abcdef-1'])
            state=ws.status('0123456789abcdef',jobs)
            self.assertFalse(state['success'])
            self.assertEqual(state['current'], 'install')
            self.assertFalse((jobs/'0123456789abcdef'/'source').exists())

    def test_real_visual_artifacts_are_bounded_and_secret_free(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work = root/'source'
            out = work/'games'/'lan_house_simulator'/'out'/'validation'
            out.mkdir(parents=True)
            private = root/'sensitive.env'
            private.write_text('PRIVATE='+'z'*250)
            (out/'desktop.png').write_bytes(b'\\x89PNG'+b'X'*200)
            (out/'mobile.webp').write_bytes(b'RIFF'+b'Y'*200)
            (out/'clips.webm').write_bytes(b'WEBM'+b'Z'*200)
            (out/'secret-link.png').symlink_to(private)
            (out/'private.env').write_bytes(b'X'*200)
            names = ws.collect_visual_artifacts(work,root)
            self.assertEqual(len(names),3)
            self.assertTrue(any(x.endswith('desktop.png') for x in names))
            self.assertTrue(all((root/'artifacts'/x).stat().st_mode & 0o077 == 0 for x in names))
            self.assertEqual((root/'artifacts'/next(x for x in names if x.endswith('desktop.png'))).read_bytes(),b'\\x89PNG'+b'X'*200)
            self.assertFalse(any('private' in x or 'secret' in x for x in names))

    def test_visual_artifacts_do_not_follow_output_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);work=root/'source'
            (work/'games'/'lan_house_simulator'/'out').mkdir(parents=True)
            other=root/'private';other.mkdir()
            (other/'leaked.png').write_bytes(b'X'*200)
            (work/'games'/'lan_house_simulator'/'out'/'validation').symlink_to(other)
            self.assertEqual(ws.collect_visual_artifacts(work,root),[])
            self.assertFalse((root/'artifacts').exists())

    def test_snapshot_shell_command_parses(self):
        subprocess.run(['sh','-n','-c',ws.clean_copy_command()],check=True)


if __name__=='__main__':unittest.main()
