"""Strict MCP query bridge tests (no VPS, no valid credentials)."""
import copy
from io import BytesIO
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parent))
import mcp_query
import receiver

POLICY=json.loads((Path(__file__).parent/'policy.example.json').read_text())
SHA='a'*40
GOOD={'repo':'Painel','tool':'repo_find_files','query':'executor','limit':10}


def claims(event='issues'):
    return {'iss':receiver.ISSUER,'aud':receiver.AUDIENCE,
            'iat':1000,'nbf':999,'exp':1300,'actor_id':'189416996',
            'repository_id':'1433232532','repository':'Softdown-prog/Painel',
            'ref':'refs/heads/main','event_name':event,
            'workflow_ref':'Softdown-prog/Painel/.github/workflows/vps-command.yml@refs/heads/main',
            'sha':SHA,'run_id':'54321'}


class TestAuthorization(unittest.TestCase):
    def test_main_issue_and_main_dispatch_are_authorized(self):
        for event in ('issues','workflow_dispatch'):
            self.assertEqual(receiver.validate_claims(claims(event),POLICY,'infrastructure','mcp_query',now=1100)['name'],'Softdown-prog/Painel')
    def test_main_only_identity_and_policy(self):
        cases=[
            {'ref':'refs/heads/feat/angular-complete-migration'},
            {'actor_id':'1'},
            {'repository':'evil/Painel'},
            {'repository_id':'1'},
            {'event_name':'push'},
            {'event_name':'pull_request'},
            {'workflow_ref':'Softdown-prog/Painel/.github/workflows/code-mcp-vps.yml@refs/heads/main'},
        ]
        for change in cases:
            with self.subTest(change=change),self.assertRaises(ValueError):
                receiver.validate_claims({**claims(),**change},POLICY,'infrastructure','mcp_query',now=1100)
        with self.assertRaises(ValueError):
            receiver.validate_claims(claims(),POLICY,'terrania','mcp_query',now=1100)
        off=copy.deepcopy(POLICY)
        off['mcp_query']['enabled']=False
        with self.assertRaises(ValueError):
            receiver.validate_claims(claims(),off,'infrastructure','mcp_query',now=1100)


class TestMcpQuery(unittest.TestCase):
    def test_exact_allowed_readonly_methods(self):
        self.assertEqual(mcp_query.validate_args(POLICY,GOOD)[1]['repo'],'Painel')
        for tool in ('repo_list','repo_stats','repo_find_files','repo_find_symbols','repo_search_text','repo_dependencies'):
            args={'repo':'Painel','tool':tool}
            if tool=='repo_dependencies':args['path']='server/api.mjs'
            if tool in ('repo_find_symbols','repo_search_text'):args['query']='api'
            with self.subTest(tool=tool):
                self.assertEqual(mcp_query.validate_args(POLICY,args)[0],tool)
        self.assertEqual(mcp_query.validate_args(POLICY,{'repo':'Painel','tool':'repo_list'}),( 'repo_list', {}))
    def test_rejects_code_read_write_unauthorized_repo_and_unbounded_queries(self):
        invalid=[
            {'repo':'Terrania','tool':'repo_find_files','query':'src'},
            {'repo':'Painel','tool':'repo_read_file','path':'server/api.mjs'},
            {'repo':'Painel','tool':'repo_reindex'},
            {'repo':'Painel','tool':'shell','command':'id'},
            {**GOOD,'limit':999},
            {**GOOD,'limit':True},
            {**GOOD,'query':'x\nTOKEN'},
            {**GOOD,'prefix':'../etc'},
            {**GOOD,'command':'ls -la'},
            {'repo':'Painel','tool':'repo_find_symbols','query':''},
            {'repo':'Painel','tool':'repo_dependencies','path':'../../etc/passwd'},
            {'repo':'Painel','tool':'repo_dependencies','path':'server/api.mjs','query':'x'},
            ['repo','Painel'],
        ]
        for arg in invalid:
            with self.subTest(arg=arg),self.assertRaises(ValueError):
                mcp_query.validate_args(POLICY,arg)
        with self.assertRaises(PermissionError):
            mcp_query.validate_args({},GOOD)
    def test_metadata_only_public_output_never_contains_source_text(self):
        private_marker='SECRET-AUTH-TOKEN-MUST-NOT-LEAK'
        matches={'matches':[{'path':'src/entry.ts','line':7,'preview':private_marker}],
                 'truncated':False,'scannedBytes':123}
        public=mcp_query.safe_result('repo_search_text',matches,'Painel',10)
        self.assertEqual(public['matches'],[{'path':'src/entry.ts','line':7}])
        self.assertNotIn(private_marker,json.dumps(public))
        self.assertNotIn('preview',json.dumps(public))
        self.assertEqual(mcp_query.safe_result('repo_list',['Painel','../../private'],'Painel',10)['repositories'],['Painel'])
    def test_result_sanitization_and_limit(self):
        raw=[{'path':f'src/file{i}.ts','lines':i,'bytes':123,'symbols':1,'text':'private'} for i in range(40)]
        public=mcp_query.safe_result('repo_find_files',raw,'Painel',10)
        self.assertEqual(public['count'],10)
        self.assertNotIn('private',json.dumps(public))
        deps={'path':'src/file1.ts','imports':['SECRET'],'localReferences':[{'specifier':'SECRET','target':'src/file2.ts'}],
              'incoming':['src/from.ts']}
        clean=mcp_query.safe_result('repo_dependencies',deps,'Painel',10)
        self.assertNotIn('SECRET',json.dumps(clean))
    def test_loopback_only_post_token_not_logged(self):
        token='temporary-unit-test-token-with-32-characters'
        result={'jsonrpc':'2.0','id':1,'result':{
            'content':[{'type':'text','text':'["Painel"]'}],'isError':False}}
        class HTTP(BytesIO):
            status=200
        def open_mock(req,timeout=0):
            self.assertEqual(req.full_url,'http://127.0.0.1:8789/mcp')
            self.assertEqual(req.get_method(),'POST')
            self.assertEqual(req.get_header('Authorization'),'Bearer '+token)
            self.assertEqual(req.get_header('User-agent'),'VPS-Operations-MCPQuery/1.0')
            self.assertLessEqual(timeout,12)
            return HTTP(json.dumps(result).encode())
        with patch.object(Path,'read_text',return_value=token),\
             patch.object(mcp_query.urllib.request,'urlopen',side_effect=open_mock):
            self.assertEqual(mcp_query.run_mcp_query(POLICY,{'repo':'Painel','tool':'repo_list'})['mcpQuery']['repositories'],['Painel'])
    def test_rpc_errors_refused(self):
        bad={'jsonrpc':'2.0','id':1,'result':{'isError':True,'content':[{'type':'text','text':'{"error":"no"}'}]}}
        class HTTP(BytesIO):status=200
        with patch.object(Path,'read_text',return_value='a'*40),\
             patch.object(mcp_query.urllib.request,'urlopen',return_value=HTTP(json.dumps(bad).encode())):
            with self.assertRaises(ValueError):
                mcp_query.query_mcp('repo_list',{})


if __name__=='__main__':
    unittest.main()
