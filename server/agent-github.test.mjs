import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentGitHub} from './agent-github.ts';
import {githubArchive} from './github.ts';

function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'account-repos-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let id=12;const calls=[],uploads=[];
 const d={dataDir:dir,git:async path=>{calls.push(path);
  if(path==='/user')return {id,login:'Owner'};
  if(path.startsWith('/user/repos?'))return [{full_name:'Owner/Private',default_branch:'trunk',private:true,permissions:{push:true}},
   {full_name:'Other/Repo',default_branch:'main',permissions:{push:true}}];
  if(path==='/repos/Owner/Private')return {id:99,full_name:'Owner/Private',default_branch:'trunk'};
  if(path==='/repos/Owner/Private/commits/trunk')return {sha:'a'.repeat(40)};
  throw Error('Unexpected '+path);
 },archive:async(repo,sha)=>{assert.equal(repo,'Owner/Private');assert.equal(sha,'a'.repeat(40));return new Response('archive');},
 bridge:async()=>({workspaces:{}}),upload:async(response,meta)=>{uploads.push(meta);return {ok:true};}};
 return {dir,calls,uploads,access:new AgentGitHub(d),identity:()=>{id=13;}};
}
test('one account authorization discovers private repositories without registering each or mutating deploy permissions',async t=>{
 const f=fixture(t);writeFileSync(join(f.dir,'github-repositories.json'),'[]');
 assert.equal((await f.access.check()).active,false);
 await assert.rejects(f.access.list());
 assert.equal((await f.access.enable({mode:'account'})).active,true);
 const list=await f.access.list();assert.equal(list.repositories.length,1);
 assert.equal(list.repositories[0].fullName,'Owner/Private');assert.equal(list.repositories[0].private,true);
 assert.equal(readFileSync(join(f.dir,'github-repositories.json'),'utf8'),'[]');
 assert.equal(f.uploads.length,0,'listing must not download repos');
 await assert.rejects(f.access.resolve('Other/Repo'));
 await assert.rejects(f.access.list(-1));
});
test('identity change revokes account operations and caller cannot select arbitrary account',async t=>{
 const f=fixture(t);await f.access.enable({mode:'account'});
 await assert.rejects(f.access.enable({mode:'account',owner:'Other'}));
 f.identity();assert.equal((await f.access.check()).active,false);
 await assert.rejects(f.access.list());await assert.rejects(f.access.prepare({repository:'Owner/Private'}));
});
test('opening selected repository pins real commit and transports only source archive metadata',async t=>{
 const f=fixture(t);await f.access.enable({mode:'account'});
 const result=await f.access.prepare({repository:'Owner/Private'});
 assert.match(result.project,/^gh_99_[a-f0-9]{8}$/);assert.equal(result.branch,'trunk');
 assert.equal(result.sourceSha,'a'.repeat(40));assert.equal(f.uploads.length,1);
 assert.deepEqual(Object.keys(f.uploads[0]).sort(),['branch','project','repository','sourceSha']);
 await assert.rejects(f.access.prepare({repository:'Owner/Private',url:'https://evil.invalid'}));
});
test('disabling broad scope leaves existing copies and linked repository registry intact',async t=>{
 const f=fixture(t);await f.access.enable({mode:'account'});assert.equal(f.access.allows('Owner/Private'),true);
 await f.access.enable({mode:'registered'});assert.equal(f.access.allows('Owner/Private'),false);
 assert.deepEqual(f.uploads,[]);
});
test('archive token stays on GitHub API and is never forwarded to a download redirect',async t=>{
 const f=fixture(t),key=join(f.dir,'token');writeFileSync(key,'fixture-private-token-not-a-real-credential');
 const previous={fetch:globalThis.fetch,file:process.env.PANEL_GITHUB_TOKEN_FILE};
 process.env.PANEL_GITHUB_TOKEN_FILE=key;
 t.after(()=>{globalThis.fetch=previous.fetch;if(previous.file===undefined)delete process.env.PANEL_GITHUB_TOKEN_FILE;else process.env.PANEL_GITHUB_TOKEN_FILE=previous.file;});
 const seen=[];let hostile=false;
 globalThis.fetch=async(url,init)=>{
  seen.push({url:String(url),headers:init.headers});
  if(String(url).startsWith('https://api.github.com/'))return new Response(null,{status:302,headers:{location:hostile?'https://evil.invalid/steal':'https://codeload.github.com/Owner/Private/legacy.tar.gz/'+'a'.repeat(40)}});
  return new Response('archive');
 };
 const archive=await githubArchive('Owner/Private','a'.repeat(40));await archive.body.cancel();
 assert.ok(seen[0].headers.authorization);
 assert.equal(seen[1].headers.authorization,undefined);
 hostile=true;await assert.rejects(githubArchive('Owner/Private','a'.repeat(40)));
 assert.equal(seen.length,3);
});
