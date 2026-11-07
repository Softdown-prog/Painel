import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AgentOperations,redactAgentOutput,validatePublication} from './agent-operations.ts';
import {ToolCalls} from '../agents/operations.mjs';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'agent-api-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const repo={fullName:'Softdown-prog/Painel',branch:'main',workflow:'deploy-vps.yml'};
 writeFileSync(join(root,'github-repositories.json'),JSON.stringify([repo]));
 writeFileSync(join(root,'agent-projects.json'),JSON.stringify({Painel:{repository:repo.fullName,branch:'main'}}));
 const responses=[],mutations=[],jobsStarted=[],cancelled=[];
 const store=new ToolCalls({stateDir:root,now:()=>1000,respond:(id,result)=>responses.push({id,result})});
 const bridge=async(path,method='GET',body)=>{
  if(path==='/status')return {projects:['Geral','Painel','AdministracaoVPS']};
  if(path==='/tool-calls')return {calls:JSON.parse(JSON.stringify(store.list().map(c=>store.public(c))))};
  const [,id,action]=/^\/tool-calls\/([^/]+)(?:\/([^/]+))?$/.exec(path)||[];
  const c=store.get(id);if(!c)throw Error('Not found');
  if(method==='GET')return {call:JSON.parse(JSON.stringify(store.public(c)))};
  assert.equal(body.fingerprint,c.fingerprint);
  if(action==='prepare')return {call:store.prepare(id,body.destination)};
  if(action==='claim')return {call:store.claim(id,body.fingerprint)};
  if(action==='result')store.complete(id,body.result);
  else if(action==='review')store.review(id,body.result);
  else if(action==='release')store.complete(id,c.result);
  else if(action==='deny')store.complete(id,{success:false,message:'declined'});
  return {ok:true};
 };
 const job={id:'b'.repeat(32),state:'running',exitCode:null,output:'',truncated:false};
 const jobs=()=>({start:async command=>{jobsStarted.push(command);return {...job};},get:async()=>({...job}),cancel:async id=>{cancelled.push(id);return {...job,state:'cancelled'};}});
 const git=async(path,method='GET',payload)=>{
  if(method!=='GET')mutations.push({path,method,payload});
  if(path.endsWith('/Painel'))return {full_name:repo.fullName,permissions:{push:true}};
  if(path.includes('/compare/'))return {status:'ahead'};
  if(path.includes('/git/commits/')&&method==='GET')return {tree:{sha:'c'.repeat(40)}};
  if(path.endsWith('/git/trees'))return {sha:'d'.repeat(40)};
  if(path.endsWith('/git/commits'))return {sha:'e'.repeat(40)};
  if(path.endsWith('/pulls'))return {html_url:'https://github.com/Softdown-prog/Painel/pull/999',number:999};
  return {};
 };
 const controller=new AgentOperations({dataDir:root,bridge,git,jobs,enabled:true,now:()=>1000,
  inventory:async()=>({containers:[{name:'independent',state:'running'}]}),resources:async()=>({source:'fixture',memory:{used:123}}),
  host:()=>({host:'fixture-vps',user:'root',port:22,valid:true})});
 const propose=(tool='solicitar_comando_vps',args={command:'uptime',reason:'diagnóstico'},project='AdministracaoVPS')=>
  store.propose({threadId:'thread-unit',turnId:'turn-unit',callId:'call-'+store.calls.size,tool,arguments:args},'rpc-'+store.calls.size,
   {id:'thread-unit',turnId:'turn-unit',project},root);
 return {root,store,responses,mutations,jobsStarted,cancelled,job,controller,propose};
}

test('background reads return actual data but never execute a pending host command',async t=>{
 const f=fixture(t),command=f.propose();
 const read=f.propose('consultar_vps',{consulta:'containers'},'Geral');
 await f.controller.step();assert.equal(f.jobsStarted.length,0);assert.equal(command.status,'pending');
 assert.deepEqual(command.destination,{host:'fixture-vps',user:'root',port:22});
 assert.equal(read.status,'completed');assert.match(read.summary,/independent/);assert.equal(f.responses.length,2);
});
test('host command is exact, single-use and output is withheld until separately released',async t=>{
 const f=fixture(t),c=f.propose();await f.controller.step();
 await assert.rejects(f.controller.decide(c.id,'approve',{fingerprint:'f'.repeat(64)}));assert.equal(f.jobsStarted.length,0);
 await f.controller.decide(c.id,'approve',{fingerprint:c.fingerprint});assert.deepEqual(f.jobsStarted,['uptime']);
 await assert.rejects(f.controller.decide(c.id,'approve',{fingerprint:c.fingerprint}));assert.equal(f.jobsStarted.length,1);
 f.job.state='completed';f.job.exitCode=0;f.job.output='uptime result\npassword=secret-value\n';
 await f.controller.step();assert.equal(c.status,'awaiting_output');assert.equal(f.responses.length,1);
 assert.doesNotMatch(c.result.output,/secret-value/);
 await f.controller.decide(c.id,'release',{fingerprint:c.fingerprint});assert.equal(f.responses.length,1);assert.match(c.summary,/uptime result/);assert.equal(c.deliveryState,'pending');
});
test('denial, changed destination and project mismatch never start commands',async t=>{
 const f=fixture(t),c=f.propose();await f.controller.step();
 c.destination.host='another-vps';await assert.rejects(f.controller.decide(c.id,'approve',{fingerprint:c.fingerprint}));
 c.destination.host='fixture-vps';c.project='Painel';await assert.rejects(f.controller.decide(c.id,'approve',{fingerprint:c.fingerprint}));
 c.project='AdministracaoVPS';await f.controller.decide(c.id,'deny',{fingerprint:c.fingerprint});
 assert.equal(f.jobsStarted.length,0);assert.equal(c.status,'failed');
});
test('lost in-memory job state is reported as unknown, never resubmitted',async t=>{
 const f=fixture(t),c=f.propose();await f.controller.step();f.store.claim(c.id,c.fingerprint);
 await f.controller.step();assert.equal(f.jobsStarted.length,0);assert.equal(c.status,'failed');assert.match(c.summary,/não confirmou/);
});
test('explicit command cancellation only targets the approved operation job',async t=>{
 const f=fixture(t),c=f.propose();await f.controller.step();
 await f.controller.decide(c.id,'approve',{fingerprint:c.fingerprint});
 await f.controller.decide(c.id,'cancel',{fingerprint:c.fingerprint});
 assert.deepEqual(f.cancelled,[f.job.id]);assert.equal(f.jobsStarted.length,1);
 await assert.rejects(f.controller.decide('f'.repeat(32),'cancel',{fingerprint:c.fingerprint}));
 assert.equal(f.cancelled.length,1);
});
test('GitHub publishing requires linked project, frozen destination and a new draft PR',async t=>{
 const f=fixture(t),c=f.propose();
 c.project='Painel';c.tool='publicar_pull_request';c.args={baseSha:'a'.repeat(40),title:'Fixture change',description:'Teste',files:[{path:'docs/fixture.md',content:'safe fixture\n',mode:'100644'}]};
 await f.controller.step();assert.equal(f.mutations.length,0);assert.equal(c.destination.repository,'Softdown-prog/Painel');
 await f.controller.decide(c.id,'approve',{fingerprint:c.fingerprint});
 assert.equal(c.status,'completed');assert.equal(f.mutations.length,4);
 const ref=f.mutations.find(x=>x.path.endsWith('/git/refs'));assert.equal(ref.payload.ref,'refs/heads/codex/panel-'+c.id);
 const pr=f.mutations.find(x=>x.path.endsWith('/pulls'));assert.equal(pr.payload.base,'main');assert.equal(pr.payload.draft,true);
 assert.ok(f.mutations.every(x=>x.path.startsWith('/repos/Softdown-prog/Painel/')));
 await assert.rejects(f.controller.decide(c.id,'approve',{fingerprint:c.fingerprint}));assert.equal(f.mutations.length,4);
});
test('unregistered repository cannot be bound or published',async t=>{
 const f=fixture(t);await assert.rejects(f.controller.bind({project:'Painel',repository:'Softdown-prog/Other'}));
 const c=f.propose();c.project='Other';c.tool='publicar_pull_request';await f.controller.step();
 assert.equal(c.status,'failed');assert.equal(f.mutations.length,0);
});
test('publication rejects path escapes, private files, duplicate files and secret patterns',()=>{
 const base={baseSha:'a'.repeat(40),title:'safe',description:'fixture',files:[{path:'ok.md',content:'safe',mode:'100644'}]};
 validatePublication(base);
 for(const path of ['../escape','a/../../escape','.git/config','.env','/absolute','a\\b','auth.json'])
  assert.throws(()=>validatePublication({...base,files:[{path,content:'safe',mode:'100644'}]}));
 assert.throws(()=>validatePublication({...base,files:[base.files[0],base.files[0]]}));
 assert.throws(()=>validatePublication({...base,files:[{path:'bad.txt',content:'ghp_'+'x'.repeat(36),mode:'100644'}]}));
});
test('terminal redaction is bounded and masks known secrets, JWTs and private keys',()=>{
 const secret='private-opaque-fixture-123456';
 const text=secret+'\n'+('ghp_'+'a'.repeat(36))+'\npassword=hidden\n-----BEGIN OPENSSH PRIVATE KEY-----\nprivate fixture\n';
 const output=redactAgentOutput(text,[secret]);assert.doesNotMatch(output,/private-opaque|ghp_|=hidden|private fixture/);
 assert.ok(Buffer.byteLength(redactAgentOutput('😀'.repeat(64000)))<=12003);
});
