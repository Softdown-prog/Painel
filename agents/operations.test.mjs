import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {ToolCalls,toolsFor,ADMIN_PROJECT,workspaceChanges} from './operations.mjs';

const session={id:'thread-unit-1',turnId:'turn-unit-1',project:ADMIN_PROJECT};
function fixture(t){const root=mkdtempSync(join(tmpdir(),'agent-operations-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const responses=[];let now=1000;const store=new ToolCalls({stateDir:root,respond:(id,result)=>responses.push({id,result}),now:()=>now});
 const propose=(tool='solicitar_comando_vps',args={command:'uptime',reason:'Consultar a carga'},s=session)=>
  store.propose({threadId:s.id,turnId:s.turnId,callId:'call-'+store.calls.size,tool,arguments:args},'rpc-test',s,root);
 return {root,store,responses,propose,advance:()=>{now+=16*60_000;}};}

test('tool capabilities separate chat, project editing and host administration',()=>{
 assert.equal(toolsFor('Geral').some(x=>x.name==='solicitar_comando_vps'),false);
 assert.equal(toolsFor('Painel').some(x=>x.name==='solicitar_comando_vps'),false);
 assert.equal(toolsFor(ADMIN_PROJECT).some(x=>x.name==='publicar_pull_request'),false);
 assert.equal(toolsFor('Painel').some(x=>x.name==='publicar_pull_request'),true);
});
test('approval binds destination and exact payload; execution/result need separate decisions',t=>{
 const f=fixture(t),c=f.propose(),initial=c.fingerprint;
 assert.equal(c.status,'pending');assert.equal(f.responses.length,1);
 assert.equal(JSON.parse(f.responses[0].result.contentItems[0].text).executed,false);
 f.store.prepare(c.id,{host:'fixture',user:'root',port:22});
 assert.notEqual(c.fingerprint,initial);
 assert.throws(()=>f.store.claim(c.id,initial));
 assert.throws(()=>f.store.prepare(c.id,{host:'other'}));
 f.store.claim(c.id,c.fingerprint);assert.equal(c.status,'running');
 assert.throws(()=>f.store.claim(c.id,c.fingerprint));
 f.store.review(c.id,{success:true,output:'uptime fixture',exitCode:0});
 assert.equal(c.status,'awaiting_output');assert.equal(f.responses.length,1);
 f.store.complete(c.id,c.result);assert.equal(f.responses.length,1);assert.equal(c.deliveryState,'pending');
 assert.equal(f.store.nextDelivery().id,c.id);f.store.delivery(c.id,'delivering');f.store.delivery(c.id,'delivered');
 assert.equal(f.store.nextDelivery(),undefined);assert.throws(()=>f.store.complete(c.id,{success:true}));
});
test('wrong context, duplicate call and secret-bearing command are rejected',t=>{
 const f=fixture(t),first=f.propose();
 assert.throws(()=>f.store.propose({threadId:session.id,turnId:session.turnId,callId:'call-0',tool:'solicitar_comando_vps',arguments:{command:'uptime',reason:'x'}},'rpc',session,f.root));
 assert.throws(()=>f.store.propose({threadId:'other',turnId:session.turnId,callId:'x',tool:'solicitar_comando_vps',arguments:{}},'rpc',session,f.root));
 f.store.complete(first.id,{success:false,message:'fixture denied'});
 assert.throws(()=>f.propose('solicitar_comando_vps',{command:'echo '+('ghp_'+'a'.repeat(36)),reason:'test'}));
 assert.throws(()=>f.propose('solicitar_comando_vps',{command:'uptime',reason:'x'},{...session,project:'Geral'}));
});
test('pending requests expire and restart never reauthorizes saved commands',t=>{
 const f=fixture(t),c=f.propose();f.advance();assert.equal(f.store.get(c.id).status,'expired');assert.equal(f.responses.length,1);
 assert.throws(()=>f.store.claim(c.id,c.fingerprint));
 const next=f.propose(),restored=new ToolCalls({stateDir:f.root,respond:()=>assert.fail('restart must not execute')});
 assert.equal(restored.get(next.id).status,'interrupted');assert.throws(()=>restored.claim(next.id,next.fingerprint));
 assert.equal(JSON.parse(readFileSync(join(f.root,'tool-calls.json'))).every(x=>!('rpcId'in x)),true);
});
test('reviewed JSON remains complete while worker polling omits large history payloads',t=>{
 const f=fixture(t),c=f.propose();f.store.claim(c.id,c.fingerprint);
 const result={success:true,exitCode:0,output:'\\'.repeat(10000)};
 f.store.review(c.id,result);f.store.complete(c.id,result);
 assert.deepEqual(JSON.parse(c.summary),result);
 const compact=f.store.public(c,{compact:true});assert.equal(compact.summary,undefined);assert.deepEqual(compact.args,{});
 assert.ok(Buffer.byteLength(JSON.stringify(compact))<2000);
});


test('LHS workspace tools validate profiles, ids and project scope before requesting host action',t=>{
 const f=fixture(t),project={...session,project:'Painel'};
 assert.equal(toolsFor('Geral').some(x=>x.name==='validar_workspace'),false);
 assert.equal(toolsFor(ADMIN_PROJECT).some(x=>x.name==='validar_workspace'),false);
 assert.equal(toolsFor('Painel').some(x=>x.name==='validar_workspace'),true);
 assert.equal(toolsFor('Painel').some(x=>x.name==='consultar_workspace'),true);
 assert.throws(()=>f.propose('validar_workspace',{perfil:'shell'},project));
 assert.throws(()=>f.propose('validar_workspace',{perfil:'lhs-quick',command:'docker ps'},project));
 assert.throws(()=>f.propose('consultar_workspace',{jobId:'../../etc/shadow'},project));
 assert.throws(()=>f.propose('consultar_workspace',{jobId:'123456789abcdef0',extra:'x'},project));
 const c=f.propose('validar_workspace',{perfil:'lhs-precommit'},project);
 assert.equal(c.mode,'approval');assert.equal(c.status,'pending');
 assert.equal(JSON.parse(f.responses.at(-1).result.contentItems[0].text).executed,false);
 f.store.complete(c.id,{success:false});
 const read=f.propose('consultar_workspace',{jobId:'0123456789abcdef'},project);
 assert.equal(read.mode,'read');assert.equal(read.status,'pending');
 f.store.complete(read.id,{success:false});
 assert.throws(()=>f.store.propose({threadId:project.id,turnId:project.turnId,
   callId:'wrong-origin',tool:'validar_workspace',arguments:{perfil:'lhs-core'}},
   'rpc',project,f.root,{repository:'Softdown-prog/Other'}));
});


test('Terrania tool proposals accept only Terrania profiles and reject cross-project requests',t=>{
 const f=fixture(t),project={...session,project:'Painel'};
 const origin={repository:'Softdown-prog/Terrania'};
 assert.throws(()=>f.store.propose({threadId:project.id,turnId:project.turnId,callId:'bad-profile',
   tool:'validar_workspace',arguments:{perfil:'lhs-precommit'}},'rpc',project,f.root,origin));
 const c=f.store.propose({threadId:project.id,turnId:project.turnId,callId:'terrania-profile',
   tool:'validar_workspace',arguments:{perfil:'terrania-precommit'}},'rpc',project,f.root,origin);
 assert.equal(c.status,'pending');
 f.store.complete(c.id,{success:false});
 const read=f.store.propose({threadId:project.id,turnId:project.turnId,callId:'terrania-read',
   tool:'consultar_workspace',arguments:{jobId:'0123456789abcdef'}},'rpc',project,f.root,origin);
 assert.equal(read.mode,'read');
 f.store.complete(read.id,{success:false});
 assert.throws(()=>f.store.propose({threadId:project.id,turnId:project.turnId,callId:'other-repository',
   tool:'consultar_workspace',arguments:{jobId:'0123456789abcdef'}},'rpc',project,f.root,
   {repository:'Softdown-prog/Other'}));
});


function repository(t){const root=mkdtempSync(join(tmpdir(),'agent-git-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const run=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 run(['init','-q']);run(['config','user.email','fixture@example.invalid']);run(['config','user.name','Fixture']);
 writeFileSync(join(root,'existing.txt'),'before\n');run(['add','.']);run(['commit','-qm','fixture']);return {root,run};}
test('Git publication snapshot captures actual changed/new/deleted UTF-8 files',t=>{
 const {root,run}=repository(t);writeFileSync(join(root,'existing.txt'),'depois\n');writeFileSync(join(root,'new.txt'),'Olá\n');
 const data=workspaceChanges(root);assert.match(data.baseSha,/^[a-f0-9]{40}$/);assert.equal(data.files.length,2);
 assert.equal(data.files.find(x=>x.path==='new.txt').content,'Olá\n');assert.match(data.diff,/depois/);
 run(['rm','-f','existing.txt']);assert.equal(workspaceChanges(root).files.find(x=>x.path==='existing.txt').content,null);
});
test('Git snapshot rejects symlink escapes, private files and secret content',t=>{
 const {root}=repository(t);const outside=mkdtempSync(join(tmpdir(),'agent-outside-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
 writeFileSync(join(outside,'secret.txt'),'private-fixture');symlinkSync(outside,join(root,'escape'),'junction');
 assert.throws(()=>workspaceChanges(root));rmSync(join(root,'escape'),{recursive:true,force:true});
 writeFileSync(join(root,'.env'),'PRIVATE=fixture');assert.throws(()=>workspaceChanges(root));rmSync(join(root,'.env'));
 writeFileSync(join(root,'token.txt'),'ghp_'+'x'.repeat(36));assert.throws(()=>workspaceChanges(root));
});
test('trusted Git snapshot disables repository fsmonitor hooks',t=>{
 const {root,run}=repository(t),marker=join(root,'hook-executed');
 writeFileSync(join(root,'hook.sh'),'#!/bin/sh\ntouch '+JSON.stringify(marker)+'\n',{mode:0o755});
 run(['config','core.fsmonitor',join(root,'hook.sh')]);writeFileSync(join(root,'existing.txt'),'changed');
 const data=workspaceChanges(root);assert.ok(data.files.length);assert.equal(existsSync(marker),false);
});
