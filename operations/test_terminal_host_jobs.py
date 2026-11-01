"""Host job supervisor tests: only ephemeral temp dirs, never systemd or root."""
from io import BytesIO, TextIOWrapper
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock

SCRIPT=Path(__file__).parent/'terminal_host_jobs.py'
spec=importlib.util.spec_from_file_location('terminal_host_jobs',SCRIPT)
host=importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)

ID='a'*32
FP='2c4f72b013ab008b'  # actual digest computed per test


class TestHostTerminalJobs(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='terminal-host-test-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.patch_root=patch.object(host,'ROOT',self.root)
        self.patch_root.start()
        self.addCleanup(self.patch_root.stop)
    def test_rejects_path_traversal_and_untrusted_ids(self):
        for bad in ['../../etc/passwd', 'a'*31, 'A'*32, 'a'*32+'.service', '']:
            with self.subTest(bad=bad),self.assertRaises(ValueError):
                host.check_id(bad)
        self.assertEqual(host.unit(ID),'vps-panel-terminal-'+ID+'.service')
    def test_start_persists_private_script_without_shell_data_in_unit_args(self):
        import hashlib
        command=b'printf ready\n'
        fingerprint=hashlib.sha256(command).hexdigest()[:16]
        fake_stdin=TextIOWrapper(BytesIO(command))
        calls=[]
        def run_spy(argv,**kwargs):
            calls.append(argv)
            return MagicMock(returncode=0)
        with patch.object(sys,'stdin',fake_stdin),patch.object(host.subprocess,'run',side_effect=run_spy):
            first=host.start(ID,fingerprint)
        self.assertEqual(first['job']['state'],'running')
        script=self.root/('script-'+ID+'.sh')
        self.assertTrue(script.exists())
        self.assertEqual(script.stat().st_mode&0o777,0o600)
        self.assertEqual(script.read_bytes(),command+b'\n')
        self.assertEqual(len(calls),2)
        self.assertEqual(calls[0],['systemctl','is-active','--quiet','vps-panel-terminal-gc.timer'])
        call=calls[1]
        self.assertEqual(call[-4:],['/usr/bin/python3',host.SELF,'run',ID])
        self.assertNotIn('printf ready',' '.join(call))
        self.assertIn('--property=RuntimeMaxSec=1800',call)
        self.assertFalse(any('sh -c' in a for a in call))
        self.assertEqual(host.read_meta(ID)['fingerprint'],fingerprint)
    def test_inactive_cleanup_timer_rejects_start_without_storing_script(self):
        import hashlib
        command=b'echo no-secret-leak'
        fingerprint=hashlib.sha256(command).hexdigest()[:16]
        stdin=TextIOWrapper(BytesIO(command))
        with patch.object(sys,'stdin',stdin),patch.object(host.subprocess,'run',
            return_value=MagicMock(returncode=3)):
            with self.assertRaisesRegex(RuntimeError,'cleanup timer'):
                host.start(ID,fingerprint)
        self.assertEqual(list(self.root.glob('script-*.sh')),[])
        self.assertEqual(list(self.root.glob('job-*.json')),[])

    def test_new_interpreter_rehydrates_running_job_after_api_restart(self):
        host.save({'id':ID,'fingerprint':'a'*16,'state':'running','startedAt':host.now(),
                   'finishedAt':None,'exitCode':None,'error':None,
                   'truncated':False,'cancelRequested':False})
        # This subprocess has a fresh Python interpreter and a new module instance.
        # It only inspects files in a disposable test directory; never calls systemd.
        script="""import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('host',sys.argv[1])
host=importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
host.ROOT=Path(sys.argv[2])
host.systemd_state=lambda _id: ('active','success')
print(host.public(host.prune()[0])['state'])
"""
        result=subprocess.run([sys.executable,'-c',script,str(SCRIPT),str(self.root)],
                              check=True,capture_output=True,text=True,timeout=5)
        self.assertEqual(result.stdout.strip(),'running')

    def test_reboot_reconciliation_fails_closed_and_erases_orphaned_script(self):
        from datetime import datetime,timedelta,timezone
        old=(datetime.now(timezone.utc)-timedelta(minutes=5)).isoformat()
        host.save({'id':ID,'fingerprint':'a'*16,'state':'running','startedAt':old,
                   'finishedAt':None,'exitCode':None,'error':None,
                   'truncated':False,'cancelRequested':False})
        (self.root/('script-'+ID+'.sh')).write_bytes(b'old secret')
        with patch.object(host,'systemd_state',return_value=('unknown','unknown')):
            entry=host.prune()[0]
        self.assertEqual(entry['state'],'failed')
        self.assertIsNone(entry['exitCode'])
        self.assertFalse((self.root/('script-'+ID+'.sh')).exists())

    def test_reboot_detection_is_independent_of_systemd_availability(self):
        from datetime import datetime,timedelta,timezone
        old=(datetime.now(timezone.utc)-timedelta(minutes=2)).isoformat()
        host.save({'id':ID,'fingerprint':'a'*16,'state':'running','startedAt':old,
                   'finishedAt':None,'exitCode':None,'error':None,
                   'truncated':False,'cancelRequested':False,'bootId':'old-boot'})
        (self.root/('script-'+ID+'.sh')).write_bytes(b'discard after reboot')
        with patch.object(host,'host_boot_id',return_value='new-boot'),\
             patch.object(host,'systemd_state',side_effect=AssertionError('should not query systemd')):
            latest=host.reconcile(host.read_meta(ID))
        self.assertEqual(latest['state'],'failed')
        self.assertIsNone(latest['exitCode'])
        self.assertIn('reiniciou',latest['error'])
        self.assertFalse((self.root/('script-'+ID+'.sh')).exists())

    def test_transient_systemd_query_failure_does_not_allow_duplicate_command(self):
        from datetime import datetime,timedelta,timezone
        old=(datetime.now(timezone.utc)-timedelta(minutes=2)).isoformat()
        host.save({'id':ID,'fingerprint':'a'*16,'state':'running','startedAt':old,
                   'finishedAt':None,'exitCode':None,'error':None,
                   'truncated':False,'cancelRequested':False,'bootId':None})
        with patch.object(host,'systemd_state',return_value=('unavailable','unknown')):
            self.assertEqual(host.prune()[0]['state'],'running')
            self.assertEqual(host.start('b'*32,'c'*16),{'busy':True})
        self.assertEqual(host.read_meta(ID)['state'],'running')

    def test_systemd_nonzero_exit_is_not_construed_as_finished(self):
        with patch.object(host.subprocess,'run',return_value=MagicMock(returncode=1,stdout='')):
            self.assertEqual(host.systemd_state(ID),('unavailable','unknown'))
        with patch.object(host.subprocess,'run',return_value=MagicMock(
            returncode=0,stdout='LoadState=not-found\\nActiveState=inactive\\nResult=success\\n')):
            self.assertEqual(host.systemd_state(ID),('not-found','unknown'))

    def test_run_writes_output_and_erases_stored_command(self):
        import hashlib
        command=b'printf hello-from-host'
        fingerprint=hashlib.sha256(command).hexdigest()[:16]
        self.root.joinpath('script-'+ID+'.sh').write_bytes(command)
        host.save({'id':ID,'fingerprint':fingerprint,'state':'running','startedAt':host.now(),
                   'finishedAt':None,'exitCode':None,'error':None,
                   'truncated':False,'cancelRequested':False})
        self.assertEqual(host.run(ID),0)
        self.assertFalse(self.root.joinpath('script-'+ID+'.sh').exists())
        self.assertEqual(host.read_meta(ID)['state'],'completed')
        self.assertEqual(host.public(host.read_meta(ID))['output'],'hello-from-host')
        self.assertEqual(self.root.joinpath('output-'+ID+'.txt').stat().st_mode&0o777,0o600)
    def test_restart_simulation_reads_saved_status_without_original_process(self):
        host.save({'id':ID,'fingerprint':'a'*16,'state':'running','startedAt':host.now(),
                   'finishedAt':None,'exitCode':None,'error':None,
                   'truncated':False,'cancelRequested':False})
        with patch.object(host,'systemd_state',return_value=('active','success')):
            self.assertEqual(host.prune()[0]['state'],'running')
        later=host.read_meta(ID)
        later['state']='completed'
        later['finishedAt']=host.now()
        later['exitCode']=0
        host.save(later)
        self.assertEqual(host.prune()[0]['state'],'completed')
    def test_no_concurrent_jobs_even_across_host_helper_processes(self):
        host.save({'id':ID,'fingerprint':'a'*16,'state':'running','startedAt':host.now(),
                   'finishedAt':None,'exitCode':None,'error':None,
                   'truncated':False,'cancelRequested':False})
        with patch.object(host,'systemd_state',return_value=('active','success')):
            self.assertEqual(host.start('b'*32,'c'*16),{'busy':True})
    def test_cancel_stops_only_fixed_unit_and_does_not_expose_output(self):
        host.save({'id':ID,'fingerprint':'a'*16,'state':'running','startedAt':host.now(),
                   'finishedAt':None,'exitCode':None,'error':None,
                   'truncated':False,'cancelRequested':False})
        with patch.object(host,'systemd_state',return_value=('active','success')),\
             patch.object(host.subprocess,'run',return_value=MagicMock()) as cmd:
            result=host.cancel(ID)
        self.assertEqual(result['job']['id'],ID)
        self.assertTrue(host.read_meta(ID)['cancelRequested'])
        self.assertEqual(cmd.call_args.args[0],['systemctl','stop','--no-block',host.unit(ID)])
    def test_large_output_is_truncated_without_killing_process(self):
        command=b'head -c 90000 /dev/zero | tr "\\\\000" x'
        self.root.joinpath('script-'+ID+'.sh').write_bytes(command)
        host.save({'id':ID,'fingerprint':'a'*16,'state':'running','startedAt':host.now(),
                   'finishedAt':None,'exitCode':None,'error':None,
                   'truncated':False,'cancelRequested':False})
        host.run(ID)
        self.assertEqual(host.read_meta(ID)['state'],'completed')
        self.assertTrue(host.read_meta(ID)['truncated'])
        self.assertEqual(len((self.root/('output-'+ID+'.txt')).read_bytes()),host.MAX_OUTPUT)
    def test_retention_removes_old_sensitive_artifacts(self):
        from datetime import datetime,timedelta,timezone
        old=(datetime.now(timezone.utc)-timedelta(hours=2)).isoformat()
        host.save({'id':ID,'fingerprint':'a'*16,'state':'completed','startedAt':old,
                   'finishedAt':old,'exitCode':0,'error':None,
                   'truncated':False,'cancelRequested':False})
        (self.root/('output-'+ID+'.txt')).write_bytes(b'private')
        self.assertEqual(host.prune(),[])
        self.assertFalse((self.root/('output-'+ID+'.txt')).exists())


if __name__=='__main__':
    unittest.main()
