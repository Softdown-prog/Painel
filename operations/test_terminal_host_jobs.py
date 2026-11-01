"""Host job supervisor tests: only ephemeral temp dirs, never systemd or root."""
from io import BytesIO, TextIOWrapper
import importlib.util
import json
import os
from pathlib import Path
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
        self.assertIn('--on-active=5400',calls[0])
        self.assertEqual(calls[0][-3:],['/usr/bin/python3',host.SELF,'prune'])
        call=calls[-1]
        self.assertEqual(call[-4:],['/usr/bin/python3',host.SELF,'run',ID])
        self.assertNotIn('printf ready',' '.join(call))
        self.assertIn('--property=RuntimeMaxSec=1800',call)
        self.assertFalse(any('sh -c' in a for a in call))
        self.assertEqual(host.read_meta(ID)['fingerprint'],fingerprint)
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
