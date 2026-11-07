import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validPrompt,projects,createBridge,codexArguments} from './bridge.mjs';
import {EventEmitter,once} from 'node:events';
import {PassThrough,Writable} from 'node:stream';

async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'agent-protocol-'));
 const workspace=join(root,'workspace'),stateDir=join(root,'state');
 mkdirSync(workspace);mkdirSync(stateDir);mkdirSync(join(workspace,'Painel'));
 const calls=[],proc=new EventEmitter();
 proc.stdout=new PassThrough();proc.stderr=new PassThrough();
 let nextThread=0;
 const notify=(method,params)=>proc.stdout.write(JSON.stringify({method,params})+'\n');
 proc.stdin=new Writable({write(chunk,_encoding,done){
  const request=JSON.parse(chunk.toString());calls.push(request);
  if(request.id){
   const result=request.method==='account/read'?{account:{type:'chatgpt'}}:
    request.method==='thread/start'?{thread:{id:'thread-'+(++nextThread)}}:
    request.method==='turn/start'?{turn:{id:'turn-1'}}:{};
   queueMicrotask(()=>proc.stdout.write(JSON.stringify({id:request.id,result})+'\n'));
  }done();
 }});
 proc.kill=()=>{proc.emit('exit',0);proc.stdin.end();proc.stdout.end();proc.stderr.end();};
 const secret='a'.repeat(64),service=createBridge({secret,workspace,stateDir,spawnCodex:()=>proc});
 service.start();service.server.listen(0,'127.0.0.1');await once(service.server,'listening');
 const base='http://127.0.0.1:'+service.server.address().port;
 const request=(path,method='GET',body,key=secret)=>fetch(base+path,{method,
  headers:{'x-panel-agent-key':key,'content-type':'application/json'},
  ...(body?{body:JSON.stringify(body)}:{})});
 t.after(async()=>{service.stop();service.server.closeAllConnections();
  await new Promise(resolve=>service.server.close(resolve));rmSync(root,{recursive:true,force:true});});
 for(let i=0;i<20;i++){
  if((await(await request('/status')).json()).ready)break;
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 return {request,calls,notify};
}

test('private bridge rejects wrong and multibyte keys without crashing',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('/status','GET',undefined,'bad')).status,404);
 assert.equal((await f.request('/status','GET',undefined,'é'.repeat(64))).status,404);
 assert.equal((await f.request('/status')).status,200);
});

test('general chat stays read-only while registered project gets its own writable root',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('/threads','POST',{project:'outside'})).status,400);
 const general=await(await f.request('/threads','POST',{project:'Geral'})).json();
 assert.equal((await f.request('/threads/'+general.thread.id+'/turns','POST',{message:'Olá'})).status,202);
 let run=f.calls.findLast(x=>x.method==='turn/start');
 assert.equal(run.params.permissions,'panel_Geral');
 assert.ok(run.params.cwd.endsWith('-general'));
 assert.equal(run.params.sandboxPolicy,undefined);
 f.notify('item/agentMessage/delta',{threadId:general.thread.id,delta:'Olá!'});
 f.notify('turn/completed',{threadId:general.thread.id,turn:{status:'completed'}});
 const reply=await(await f.request('/threads/'+general.thread.id)).json();
 assert.equal(reply.thread.status,'completed');
 assert.equal(reply.thread.messages.at(-1).text,'Olá!');
 const project=await(await f.request('/threads','POST',{project:'Painel'})).json();
 assert.equal((await f.request('/threads/'+project.thread.id+'/turns','POST',{message:'Leia o README'})).status,202);
 run=f.calls.findLast(x=>x.method==='turn/start');
 assert.equal(run.params.permissions,'panel_Painel');
 assert.equal(run.params.sandboxPolicy,undefined);
});

test('pinned CLI uses named permission profiles and hides credentials and other projects',()=>{
 const args=codexArguments('/workspace',['Geral','Painel']);
 const policy=p=>args.find(x=>x.startsWith('permissions.panel_'+p+'.filesystem='));
 assert.ok(policy('Painel').includes('"/workspace"="deny"'));
 assert.ok(policy('Painel').includes(JSON.stringify(join('/workspace','Painel'))+'="write"'));
 assert.ok(policy('Geral').includes('"/workspace-general"="read"'));
 for(const p of ['Geral','Painel']){
  assert.ok(policy(p).includes('"/home/node/.codex"="deny"'));
  assert.ok(policy(p).includes('"/run/secrets"="deny"'));
  assert.ok(args.includes('permissions.panel_'+p+'.network.enabled=false'));
 }
 assert.throws(()=>codexArguments('/workspace',['../outside']));
});

test('only one turn starts under concurrent requests and cancellation reaches Codex',async t=>{
 const f=await fixture(t);
 const thread=await(await f.request('/threads','POST',{project:'Painel'})).json();
 const path='/threads/'+thread.thread.id;
 const responses=await Promise.all([f.request(path+'/turns','POST',{message:'Tarefa A'}),
  f.request(path+'/turns','POST',{message:'Tarefa B'})]);
 assert.deepEqual(responses.map(x=>x.status).sort(),[202,409]);
 assert.equal(f.calls.filter(x=>x.method==='turn/start').length,1);
 assert.equal((await f.request(path+'/cancel','POST',{})).status,200);
 assert.equal(f.calls.findLast(x=>x.method==='turn/interrupt').params.turnId,'turn-1');
 f.notify('turn/completed',{threadId:thread.thread.id,turn:{status:'interrupted'}});
 const stopped=await(await f.request(path)).json();assert.equal(stopped.thread.status,'interrupted');
});

test('account change events reflect logout without restarting the private bridge',async t=>{
 const f=await fixture(t);f.notify('account/updated',{authMode:null});
 const status=await(await f.request('/status')).json();assert.equal(status.ready,false);
 assert.equal((await f.request('/threads','POST',{project:'Painel'})).status,503);
});
test('isolates project folders from symlinks',()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-test-'));
 try{mkdirSync(join(root,'Painel'));mkdirSync(join(root,'.secret'));
  symlinkSync('/etc',join(root,'outside'));
  assert.deepEqual(projects(root),['Painel']);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('validates prompts and protects bridge secret',()=>{
 assert.equal(validPrompt('Corrija o compilador'),true);
 for(const s of ['', ' ', 'a'.repeat(4001), '\u0000', null])assert.equal(validPrompt(s),false);
 assert.throws(()=>createBridge({secret:'short',workspace:'/tmp',stateDir:'/tmp'}));
});
