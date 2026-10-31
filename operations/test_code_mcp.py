"""MCP broker permission and Docker command boundary tests: never touch real host."""
import json
from pathlib import Path
import re
import sys
import unittest
from unittest.mock import patch, call

sys.path.insert(0,str(Path(__file__).resolve().parent))
import code_mcp

GOOD_SHA='a'*40
GOOD_IMAGE='ghcr.io/softdown-prog/painel-code-mcp@sha256:'+'b'*64
ARGS={'action':'install','image':GOOD_IMAGE,'sha':GOOD_SHA,'confirm':'INSTALL:code-mcp'}

class TestCodeMcp(unittest.TestCase):
    def test_exact_payload_only(self):
        self.assertEqual(code_mcp.check_args(ARGS,GOOD_SHA),'install')
        self.assertEqual(code_mcp.check_args({'action':'status','image':'','sha':'','confirm':''},GOOD_SHA),'status')
        invalid=[
          {**ARGS,'image':'docker.io/library/ubuntu:latest'},
          {**ARGS,'image':'ghcr.io/softdown-prog/painel-code-mcp:latest'},
          {**ARGS,'image':GOOD_IMAGE+';sh'},
          {**ARGS,'sha':'b'*40},
          {**ARGS,'confirm':'INSTALL:anything'},
          {**ARGS,'command':'sudo docker run'},
          {'action':'status','image':GOOD_IMAGE,'sha':'','confirm':''},
          {'action':'restart','image':'','sha':'','confirm':''},
        ]
        for args in invalid:
            with self.subTest(args=args),self.assertRaises(ValueError):
                code_mcp.check_args(args,GOOD_SHA)
    def test_policy_blocks_uninstalled_upgrade(self):
        with self.assertRaises(PermissionError):
            code_mcp.run_code_mcp({},ARGS,{'sha':GOOD_SHA},'token')
        with patch.object(code_mcp,'status',return_value={'installed':False}):
            actual=code_mcp.run_code_mcp({'code_mcp':{'enabled':True}},
                 {'action':'status','image':'','sha':'','confirm':''},{'sha':GOOD_SHA},None)
            self.assertEqual(actual['installed'],False)
    def test_install_uses_only_fixed_restricted_docker_args(self):
        fake={'Config':{'Labels':{'com.softdown.code-mcp.managed':'true'}},
              'State':{'Status':'running','Health':{'Status':'healthy'}}}
        with patch.object(code_mcp,'status',return_value={'installed':False}),\
             patch.object(code_mcp,'pull_image') as pull,\
             patch.object(code_mcp,'verify_image',return_value='sha256:'+('c'*64)),\
             patch.object(code_mcp,'create_token',return_value=False),\
             patch.object(code_mcp,'inspect',return_value=fake),\
             patch.object(code_mcp,'docker',return_value='') as docker:
            result=code_mcp.install(GOOD_IMAGE,GOOD_SHA,'ephemeral')
        self.assertTrue(result['changed'])
        pull.assert_called_once_with(GOOD_IMAGE,'ephemeral')
        command=docker.call_args_list[0].args
        self.assertEqual(command[0:2],('create','--name'))
        self.assertIn('--read-only',command)
        self.assertIn('127.0.0.1:8789:8789',command)
        self.assertIn('65534:65534',command)
        self.assertIn('--cap-drop',command)
        self.assertNotIn('--privileged',command)
        self.assertNotIn('docker.sock',' '.join(command))
        self.assertEqual(docker.call_args_list[1].args,('start','vps-code-mcp'))
    def test_cannot_replace_reserved_container(self):
        with patch.object(code_mcp,'status',return_value={'installed':True}):
            with self.assertRaisesRegex(ValueError,'already installed'):
                code_mcp.install(GOOD_IMAGE,GOOD_SHA,'token')
    def test_status_rejects_ownership_spoofing(self):
        foreign={'Config':{'Labels':{'com.softdown.code-mcp.managed':'false'}},'State':{'Status':'running'}}
        with patch.object(code_mcp,'docker',return_value=json.dumps([foreign])):
            with self.assertRaisesRegex(RuntimeError,'different owner'):
                code_mcp.status()
    def test_image_source_revision_and_digest_must_match(self):
        config={'Config':{'Labels':{
            'org.opencontainers.image.source':'https://github.com/Softdown-prog/Painel',
            'org.opencontainers.image.revision':GOOD_SHA}},
            'RepoDigests':[GOOD_IMAGE],'Id':'sha256:'+'c'*64}
        with patch.object(code_mcp,'docker',return_value=json.dumps([config])):
            self.assertEqual(code_mcp.verify_image(GOOD_IMAGE,GOOD_SHA),config['Id'])
        config['Config']['Labels']['org.opencontainers.image.revision']='0'*40
        with patch.object(code_mcp,'docker',return_value=json.dumps([config])):
            with self.assertRaises(ValueError):code_mcp.verify_image(GOOD_IMAGE,GOOD_SHA)

if __name__=='__main__':unittest.main()
