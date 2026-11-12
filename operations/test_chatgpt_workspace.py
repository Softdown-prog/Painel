"""Offline authorization and status-privacy tests; no VPS or Docker required."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import receiver
import chatgpt_workspace as chat

POLICY = json.loads((Path(__file__).parent / 'policy.example.json').read_text())
ENABLED = copy.deepcopy(POLICY)
ENABLED['workspace']['enabled'] = True
SHA = 'a'*40
VALID = {'action':'start','project':'terrania','profile':'terrania-precommit','sha':SHA}


def claims():
    return {'iss':receiver.ISSUER,'aud':receiver.AUDIENCE,'iat':1000,'nbf':999,'exp':1300,
            'actor_id':'189416996','repository_id':'1433232532',
            'repository':'Softdown-prog/Painel','ref':'refs/heads/main',
            'event_name':'issues','sha':SHA,'run_id':'12345',
            'workflow_ref':'Softdown-prog/Painel/.github/workflows/vps-command.yml@refs/heads/main'}


class BridgeAuthorization(unittest.TestCase):
    def test_off_by_default_and_exact_game_profiles(self):
        with self.assertRaises(PermissionError):
            chat.authorize(POLICY, VALID)
        self.assertEqual(chat.authorize(ENABLED, VALID), ('start','terrania'))
        self.assertEqual(chat.authorize(ENABLED, {'action':'check'}), ('check',None))
        self.assertEqual(chat.authorize(ENABLED, {'action':'status','jobId':'f'*16}), ('status',None))

    def test_reject_shell_arbitrary_repositories_traversal_and_refs(self):
        bad = [
            {**VALID,'command':'id'},
            {**VALID,'project':'other'},
            {**VALID,'project':'lhs'},
            {**VALID,'profile':'terrania-core'},
            {**VALID,'sha':'main'},
            {**VALID,'sha':'a'*39},
            {**VALID,'sha':'a'*40+';echo'},
            {**VALID,'sha':True},
            {**VALID,'profile':['terrania-precommit']},
            {'action':'status','jobId':'../etc/passwd'},
            {'action':'status','jobId':'a'*16,'command':'id'},
            {'action':'check','project':'lhs'},
            {'action':'deploy'},
        ]
        for args in bad:
            with self.subTest(args=args),self.assertRaises((ValueError,PermissionError)):
                chat.authorize(ENABLED,args)

    def test_only_owner_oidc_on_approved_issue_can_submit(self):
        self.assertEqual(receiver.validate_claims(claims(),ENABLED,'infrastructure','workspace',now=1100)['name'],
                         'Softdown-prog/Painel')
        bad = [
            {'actor_id':'1'},
            {'event_name':'workflow_dispatch'},
            {'event_name':'pull_request'},
            {'repository':'evil/Painel'},
            {'repository_id':'1438758092'},
            {'ref':'refs/heads/feature'},
            {'workflow_ref':'Softdown-prog/Painel/.github/workflows/evil.yml@refs/heads/main'},
        ]
        for change in bad:
            with self.subTest(change=change),self.assertRaises(ValueError):
                receiver.validate_claims({**claims(),**change},ENABLED,'infrastructure','workspace',now=1100)
        with self.assertRaises(ValueError):
            receiver.validate_claims(claims(),POLICY,'infrastructure','workspace',now=1100)

    def test_git_subprocess_has_no_shell_and_silences_errors(self):
        with patch.object(chat.subprocess,'run') as proc:
            proc.return_value.returncode=0
            proc.return_value.stdout=b'a'*40
            self.assertEqual(chat.git(['rev-parse','HEAD'],Path('/tmp')),SHA)
            self.assertEqual(proc.call_args.args[0],['/usr/bin/git','rev-parse','HEAD'])
            self.assertEqual(proc.call_args.kwargs['env']['GIT_TERMINAL_PROMPT'],'0')
            self.assertEqual(proc.call_args.kwargs['stderr'],chat.subprocess.DEVNULL)
            self.assertNotIn('shell',proc.call_args.kwargs)
            proc.return_value.returncode=1
            with self.assertRaises(RuntimeError):
                chat.git(['fetch'],Path('/tmp'))

    def test_fixed_public_repository_selection(self):
        self.assertEqual(chat.PROJECTS['lhs'],('Softdown-prog/A7-forge-2D-','lhs-precommit'))
        self.assertEqual(chat.PROJECTS['terrania'],('Softdown-prog/Terrania','terrania-precommit'))


class StatusPrivacy(unittest.TestCase):
    def test_unregistered_jobs_rejected(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(chat,'STATE',Path(folder)), \
             patch.object(chat,'supervisor',return_value=object()):
            with self.assertRaises(ValueError):
                chat.run_workspace(ENABLED,{'action':'status','jobId':'f'*16})

    def test_status_binds_job_identity_and_never_exposes_private_logs(self):
        class Stub:
            PROFILES={'terrania-precommit':[('terrania-build','npm run build',900,'none')]}
            def status(self, jid):
                return {'project':'cg_terrania_aaaaaaaaaaaaaaaa','profile':'terrania-precommit',
                        'status':'failed','current':'terrania-build','success':False,
                        'logTail':'SECRET-PRIVATE-TOKEN','error':'password=SECRET-PRIVATE-TOKEN'}
        with tempfile.TemporaryDirectory() as folder,patch.object(chat,'STATE',Path(folder)), \
             patch.object(chat,'supervisor',return_value=Stub()):
            path=Path(folder)/('job-'+'f'*16+'.json')
            path.write_text(json.dumps({'project':'terrania','sha':SHA,'profile':'terrania-precommit',
                                        'workspace':'cg_terrania_aaaaaaaaaaaaaaaa'}))
            result=chat.run_workspace(ENABLED,{'action':'status','jobId':'f'*16})
            self.assertEqual(result['step'],'terrania-build')
            self.assertEqual(result['diagnostic'],'inspect-private-job-logs')
            self.assertFalse(result['passed'])
            self.assertNotIn('SECRET',json.dumps(result))
            self.assertNotIn('logTail',result)

    def test_check_readonly(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(chat,'STATE',Path(folder)), \
             patch.object(chat,'supervisor',return_value=object()):
            result=chat.run_workspace(ENABLED,{'action':'check'})
            self.assertFalse(result['changed'])
            self.assertEqual(len(result['profiles']),2)


if __name__=='__main__':
    unittest.main()
