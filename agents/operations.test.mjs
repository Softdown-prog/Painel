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
 assert.equal(c.status,'pending');assert.equal(f.responses.length,0);
 f.store.prepare(c.id,{host:'fixture',user:'root',port:22});
 assert.notEqual(c.fingerprint,initial);
 assert.throws(()=>f.store.claim(c.id,initial));
 assert.throws(()=>f.store.prepare(c.id,{host:'other'}));
 f.store.claim(c.id,c.fingerprint);assert.equal(c.status,'running');
 assert.throws(()=>f.store.claim(c.id,c.fingerprint));
 f.store.review(c.id,{success:true,output:'uptime fixture',exitCode:0});
 assert.equal(c.status,'awaiting_output');assert.equal(f.responses.length,0);
 f.store.complete(c.id,c.result);assert.equal(f.responses.length,1);assert.equal(f.responses[0].id,'rpc-test');
 assert.equal(f.responses[0].result.success,true);assert.throws(()=>f.store.complete(c.id,{success:true}));
});
test('wrong context, duplicate call and secret-bearing command are rejected',t=>{
 const f=fixture(t);f.propose();
 assert.throws(()=>f.store.propose({threadId:session.id,turnId:session.turnId,callId:'call-0',tool:'solicitar_comando_vps',arguments:{command:'uptime',reason:'x'}},'rpc',session,f.root));
 assert.throws(()=>f.store.propose({threadId:'other',turnId:session.turnId,callId:'x',tool:'solicitar_comando_vps',arguments:{}},'rpc',session,f.root));
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
