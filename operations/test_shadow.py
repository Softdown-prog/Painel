"""Regression tests for the fixed Terrânia Go shadow executor boundary."""
import copy
import json
from io import BytesIO
from pathlib import Path
import time
import unittest
from unittest.mock import patch, call

import receiver
import shadow

POLICY=json.loads((Path(__file__).parent/'policy.example.json').read_text())
SHA='a'*40
IMAGE='ghcr.io/softdown-prog/terrania-go@sha256:'+'b'*64


def terrania_claims(workflow):
    now=time.time()
    return {'iss':receiver.ISSUER,'aud':receiver.AUDIENCE,
            'iat':now-1,'nbf':now-1,'exp':now+300,
            'actor_id':'189416996','repository_id':'1438758092',
            'repository':'Softdown-prog/Terrania','ref':'refs/heads/main',
            'event_name':'workflow_dispatch',
            'workflow_ref':'Softdown-prog/Terrania/.github/workflows/'+workflow+'@refs/heads/main',
            'sha':SHA,'run_id':'42'}


def good_shadow():
    return {
        'Name':'/terrania-go-shadow','Id':'shadow-id','Image':'sha256:image',
        'Config':{'Image':IMAGE,'Labels':{
            'io.softdown.project':'terrania-go-shadow',
            'org.opencontainers.image.source':shadow.SOURCE}},
        'State':{'Running':True,'Health':{'Status':'healthy'}},
        'HostConfig':{'PortBindings':{'8788/tcp':[{'HostIp':'127.0.0.1','HostPort':'18788'}]}},
        'NetworkSettings':{'Networks':{'bridge':{}}}}


class ShadowAuthorization(unittest.TestCase):
    def test_workflows_cannot_cross_deploy_boundaries(self):
        self.assertEqual(receiver.validate_claims(
            terrania_claims('deploy-go-shadow.yml'),POLICY,'terrania-go-shadow','deploy')['name'],
            'Softdown-prog/Terrania')
        for workflow,project in [
            ('deploy-go-shadow.yml','terrania'),
            ('deploy-vps.yml','terrania-go-shadow'),
            ('deploy-go-shadow.yml','panel'),
        ]:
            with self.subTest(workflow=workflow,project=project),self.assertRaises(ValueError):
                receiver.validate_claims(terrania_claims(workflow),POLICY,project,'deploy')
        with self.assertRaises(ValueError):
            receiver.validate_claims(terrania_claims('deploy-go-shadow.yml'),POLICY,'terrania-go-shadow','shell')

    def test_unknown_existing_container_cannot_be_replaced(self):
        victim=good_shadow()
        victim['Config']['Labels']['io.softdown.project']='other'
        with self.assertRaises(ValueError):
            shadow._owned(victim)

    @patch('driver.image_info')
    @patch('shadow.urllib.request.urlopen')
    @patch('shadow._inspect')
    def test_health_requires_sha_loopback_bridge_and_live_node(self, inspect, open_url, image_info):
        project=POLICY['projects']['terrania-go-shadow']
        image_info.return_value={'Config':{'Labels':{
            'org.opencontainers.image.revision':SHA,
            'org.opencontainers.image.source':shadow.SOURCE}}}
        open_url.return_value=BytesIO(json.dumps({'status':'ok','engine':'go','revision':SHA}).encode())
        inspect.side_effect=lambda name: good_shadow() if name==shadow.CONTAINER else {
            'State':{'Running':True,'Health':{'Status':'healthy'}}}
        self.assertTrue(shadow.verify_shadow(project,{'sha':SHA})['loopbackVerified'])
        self.assertEqual(open_url.call_args.args[0].full_url,shadow.HEALTH_URL)
        exposed=good_shadow()
        exposed['HostConfig']['PortBindings']['8788/tcp'][0]['HostIp']='0.0.0.0'
        inspect.side_effect=lambda name: exposed
        with self.assertRaises(RuntimeError):
            shadow.verify_shadow(project,{'sha':SHA})

    @patch('shadow._unrelated',return_value={'node':'original-id'})
    @patch('shadow._wait_shadow',return_value={'loopbackVerified':True})
    @patch('shadow._inspect')
    @patch('shadow._maybe_inspect',return_value=None)
    @patch('shadow._run')
    def test_new_shadow_only_runs_scoped_container(self, run, maybe, inspect, wait, unrelated):
        inspect.return_value={'Id':'original-id','State':{'Running':True,'Health':{'Status':'healthy'}}}
        result=shadow.shadow_activate(POLICY['projects']['terrania-go-shadow'],SHA,
                                      {'engine-go':IMAGE},None)
        self.assertTrue(result['unrelatedContainersPreserved'])
        invocations=[list(c.args) for c in run.call_args_list]
        self.assertEqual(len(invocations),1)
        args=invocations[0]
        self.assertEqual(args[:5],['docker','run','-d','--name','terrania-go-shadow'])
        self.assertEqual(args[-1],IMAGE)
        self.assertIn('127.0.0.1:18788:8788',args)
        self.assertIn('--read-only',args)
        self.assertIn('no-new-privileges:true',args)
        self.assertNotIn('softload_proxy',args)
        self.assertFalse(any('down' in cmd or 'prune' in cmd for cmd in invocations))

    @patch('shadow._unrelated',return_value={})
    @patch('shadow._inspect')
    @patch('shadow._maybe_inspect')
    @patch('shadow._run')
    @patch('shadow._wait_shadow',side_effect=RuntimeError('health failed'))
    def test_existing_shadow_rolls_back_without_touching_node(self, wait, run, maybe, inspect, unrelated):
        old=good_shadow()
        old['Config']['Image']='prior@sha256:'+'c'*64
        old['Id']='old-id'
        node={'Id':'node-id','State':{'Running':True,'Health':{'Status':'healthy'}}}
        inspect.return_value=node
        def existing(name):
            if name==shadow.CONTAINER:return old
            if name==shadow.CONTAINER+'-rollback':return None
            return None
        maybe.side_effect=existing
        with self.assertRaises(RuntimeError):
            shadow.shadow_activate(POLICY['projects']['terrania-go-shadow'],SHA,{'engine-go':IMAGE},None)
        calls=[list(c.args) for c in run.call_args_list]
        self.assertTrue(any(c[:3]==['docker','stop','-t'] for c in calls))
        self.assertIn(['docker','rename','terrania-go-shadow-rollback','terrania-go-shadow'],calls)
        self.assertIn(['docker','start','terrania-go-shadow'],calls)
        self.assertFalse(any('terrania-origins-multiplayer-1' in c for c in calls))


if __name__=='__main__':
    unittest.main()
