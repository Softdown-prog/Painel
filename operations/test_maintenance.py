"""Regression tests for the existing broker's protected maintenance operations."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import maintenance
import receiver

POLICY=json.loads((Path(__file__).parent/'policy.example.json').read_text())

def claims():
    import time
    t=time.time()
    return {'iss':receiver.ISSUER,'aud':receiver.AUDIENCE,'iat':t-1,'nbf':t-1,'exp':t+300,
            'actor_id':'189416996','repository_id':'1433232532',
            'repository':'Softdown-prog/Painel','ref':'refs/heads/main',
            'event_name':'workflow_dispatch','environment':'vps-maintenance',
            'workflow_ref':'Softdown-prog/Painel/.github/workflows/vps-maintenance.yml@refs/heads/main',
            'sha':'a'*40,'run_id':'321'}

class MaintenanceAuth(unittest.TestCase):
    def test_only_approved_main_actor_workflow_environment(self):
        self.assertEqual(receiver.validate_claims(claims(),POLICY,'infrastructure','maintain')['name'],'Softdown-prog/Painel')
        for field,value in (
            ('actor_id','1'),('repository_id','111'),('ref','refs/heads/pr/3'),
            ('event_name','issues'),('environment','other'),
            ('workflow_ref','Softdown-prog/Painel/.github/workflows/vps-command.yml@refs/heads/main')
        ):
            with self.subTest(field=field),self.assertRaises(ValueError):
                receiver.validate_claims(dict(claims(),**{field:value}),POLICY,'infrastructure','maintain')
        with self.assertRaises(ValueError):
            receiver.validate_claims(claims(),POLICY,'panel','maintain')
        with self.assertRaises(ValueError):
            receiver.validate_claims(claims(),{**POLICY,'maintenance':{}},'infrastructure','maintain')

    def test_no_freeform_commands(self):
        allowed={'action':'host_summary','target':'host','confirm':''}
        self.assertEqual(maintenance.check_args(allowed),('host_summary','host'))
        invalid=[
            {**allowed,'command':'sudo rm -rf /'},
            {'action':'shell','target':'host','confirm':''},
            {'action':'host_summary','target':'panel-api','confirm':''},
            {'action':'container_status','target':'panel-api','confirm':'yes'},
            {'action':'restart_container','target':'panel-api','confirm':''},
            {'action':'restart_container','target':'panel-api','confirm':'RESTART:terrania-multiplayer'},
            {'action':'restart_container','target':'vps-postgres','confirm':'RESTART:vps-postgres'},
            {'action':'restart_container','target':'../../../etc/passwd','confirm':'anything'},
        ]
        for case in invalid:
            with self.subTest(case=case),self.assertRaises(ValueError):
                maintenance.check_args(case)
        self.assertEqual(maintenance.check_args({
            'action':'restart_container','target':'panel-web','confirm':'RESTART:panel-web'
        }),('restart_container','panel-web'))

class MaintenanceExecution(unittest.TestCase):
    def test_host_report_is_fixed_fields_and_no_shell(self):
        with patch('maintenance.host_summary',return_value={'disk':{'freeBytes':100}}),patch('maintenance.subprocess.check_output') as command:
            result=maintenance.run_maintenance(POLICY,{'action':'host_summary','target':'host','confirm':''},Path('/tmp'))
        self.assertEqual(result['host']['disk']['freeBytes'],100)
        self.assertFalse(result['changed'])
        command.assert_not_called()

    def test_status_checks_compose_ownership(self):
        name='softload-panel-web'
        obj={'Image':'sha256:test','State':{'Status':'running','Health':{'Status':'healthy'}},
             'Config':{'Labels':{'com.docker.compose.project':'softload-panel','com.docker.compose.service':'panel-web'}},
             'HostConfig':{'Memory':134217728,'NanoCpus':500000000}}
        image={'Config':{'Labels':{'org.opencontainers.image.revision':'a'*40}}}
        with patch('maintenance.inspect',return_value=obj),patch('maintenance.image_info',return_value=image):
            result=maintenance.container_status(POLICY,'panel-web')
            self.assertEqual(result['container'],name)
            self.assertEqual(result['revision'],'a'*40)
        bad=json.loads(json.dumps(obj))
        bad['Config']['Labels']['com.docker.compose.service']='api'
        with patch('maintenance.inspect',return_value=bad),self.assertRaises(ValueError):
            maintenance.container_status(POLICY,'panel-web')

    def test_restart_only_approved_container_and_reverify(self):
        expected={'target':'panel-web','container':'softload-panel-web','status':'running',
                  'health':'healthy','revision':'a'*40,'imageId':'sha256:test'}
        with tempfile.TemporaryDirectory() as tmp,patch('maintenance.container_status',return_value=expected),patch('maintenance.subprocess.check_output',return_value=b'ok') as command:
            result=maintenance.run_maintenance(POLICY,{
                'action':'restart_container','target':'panel-web','confirm':'RESTART:panel-web'
            },Path(tmp))
            self.assertTrue((Path(tmp)/'panel-web.lock').exists())
        self.assertTrue(result['changed'])
        command.assert_called_once_with(
            ['docker','restart','--time','20','softload-panel-web'],
            stderr=maintenance.subprocess.STDOUT,timeout=75
        )

    def test_unknown_registry_cannot_be_controlled(self):
        with self.assertRaises(ValueError):
            maintenance.validate_target({**POLICY,'maintenance':{'targets':{}}},'panel-web')
