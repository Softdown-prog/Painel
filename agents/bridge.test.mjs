import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,symlinkSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validPrompt,projects,createBridge,codexArguments} from './bridge.mjs';
import {EventEmitter,once} from 'node:events';
import {PassThrough,Writable} from 'node:stream';

async function fixture(t,{saved=[],savedCalls=[],operationsEnabled=false}={}){
 const root=mkdtempSync(join(tmpdir(),'agent-protocol-'));
 const workspace=join(root,'workspace'),stateDir=join(root,'state');
 mkdirSync(workspace);mkdirSync(stateDir);mkdirSync(join(workspace,'Painel'));
 if(saved.length)writeFileSync(join(stateDir,'threads.json'),JSON.stringify(saved));
 if(savedCalls.length)writeFileSync(join(stateDir,'tool-calls.json'),JSON.stringify(savedCalls));
 const calls=[],proc=new EventEmitter();
 proc.stdout=new PassThrough();proc.stderr=new PassThrough();
 let nextThread=0;
 const notify=(method,params)=>proc.stdout.write(JSON.stringify({method,params})+'\n');
 proc.stdin=new Writable({write(chunk,_encoding,done){
  const request=JSON.parse(chunk.toString());calls.push(request);
  if(request.id&&request.method){
   const result=request.method==='account/read'?{account:{type:'chatgpt'}}:
    request.method==='thread/start'?{thread:{id:'thread-'+(++nextThread)}}:
    request.method==='turn/start'?{turn:{id:'turn-1'}}:{};
   queueMicrotask(()=>proc.stdout.write(JSON.stringify({id:request.id,result})+'\n'));
  }done();
 }});
 proc.kill=()=>{proc.emit('exit',0);proc.stdin.end();proc.stdout.end();proc.stderr.end();};
 const secret='a'.repeat(64),service=createBridge({secret,workspace,stateDir,spawnCodex:()=>proc,operationsEnabled});
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
 return {request,calls,notify,toolCall:(params,id='tool-rpc-1')=>proc.stdout.write(JSON.stringify({id,method:'item/tool/call',params})+'\n')};
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
 assert.equal(f.calls.filter(x=>x.method==='thread/resume').length,0,
  'fresh threads have no rollout to resume before their first turn');
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

test('restored conversations resume once with the selected project scope',async t=>{
 const f=await fixture(t,{saved:[{id:'saved-thread',project:'Painel',messages:[{role:'user',text:'Leia o README'}]}]});
 const path='/threads/saved-thread';
 assert.equal((await f.request(path+'/turns','POST',{message:'Continue'})).status,202);
 const resume=f.calls.find(x=>x.method==='thread/resume');
 assert.equal(resume.params.permissions,'panel_Painel');
 assert.ok(resume.params.cwd.endsWith('Painel'));
 f.notify('turn/completed',{threadId:'saved-thread',turn:{status:'completed'}});
 assert.equal((await f.request(path+'/turns','POST',{message:'Continue outra vez'})).status,202);
 assert.equal(f.calls.filter(x=>x.method==='thread/resume').length,1);
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
  symlinkSync(join(root,'.secret'),join(root,'outside'),'junction');
  assert.deepEqual(projects(root),['Painel']);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('validates prompts and protects bridge secret',()=>{
 assert.equal(validPrompt('Corrija o compilador'),true);
 for(const s of ['', ' ', 'a'.repeat(4001), '\u0000', null])assert.equal(validPrompt(s),false);
 assert.throws(()=>createBridge({secret:'short',workspace:'/tmp',stateDir:'/tmp'}));
});

test('host proposal acknowledges without execution and survives model turn completion',async t=>{
 const f=await fixture(t,{operationsEnabled:true});
 const status=await(await f.request('/status')).json();assert.ok(status.projects.includes('AdministracaoVPS'));
 const created=await(await f.request('/threads','POST',{project:'AdministracaoVPS'})).json();
 const thread=created.thread;
 assert.equal((await f.request('/threads/'+thread.id+'/turns','POST',{message:'Consulte uptime'})).status,202);
 const start=f.calls.find(x=>x.method==='thread/start');assert.ok(start.params.dynamicTools.some(x=>x.name==='solicitar_comando_vps'));
 f.toolCall({threadId:thread.id,turnId:'turn-1',callId:'call-fixture',tool:'solicitar_comando_vps',arguments:{command:'uptime',reason:'Verificar a carga'}});
 await new Promise(resolve=>setTimeout(resolve,5));
 const list=await(await f.request('/tool-calls')).json();assert.equal(list.calls.length,1);assert.equal(list.calls[0].status,'pending');
 const receipt=f.calls.find(x=>x.id==='tool-rpc-1');assert.equal(receipt.result.success,true);
 assert.equal(JSON.parse(receipt.result.contentItems[0].text).executed,false);
 f.notify('turn/completed',{threadId:thread.id,turn:{status:'completed'}});
 assert.equal((await(await f.request('/tool-calls')).json()).calls[0].status,'pending');
 const c=list.calls[0];
 assert.equal((await f.request('/tool-calls/'+c.id+'/deny','POST',{fingerprint:c.fingerprint})).status,200);
 await new Promise(resolve=>setTimeout(resolve,15));
 assert.equal(f.calls.filter(x=>x.id==='tool-rpc-1').length,1,'never answer an expired RPC again');
 const continuation=f.calls.findLast(x=>x.method==='turn/start');
 assert.equal(continuation.params.permissions,'panel_Geral');
 assert.match(continuation.params.cwd,/-general$/);
 f.toolCall({threadId:thread.id,turnId:'turn-1',callId:'summary-attempt',tool:'solicitar_comando_vps',arguments:{command:'uptime',reason:'should reject'}},'summary-rpc');
 await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(f.calls.find(x=>x.id==='summary-rpc').result.success,false);
});

test('reviewed result resumes after restart once and only in read-only summary mode',async t=>{
 const id='e'.repeat(32),savedCall={id,threadId:'saved-admin',project:'AdministracaoVPS',tool:'solicitar_comando_vps',
  status:'completed',mode:'approval',fingerprint:'f'.repeat(64),args:{command:'uptime'},rpcAnswered:true,
  deliveryState:'pending',summary:JSON.stringify({success:true,exitCode:0,output:'fixture result'})};
 const f=await fixture(t,{operationsEnabled:true,saved:[{id:'saved-admin',project:'AdministracaoVPS',messages:[]}],savedCalls:[savedCall]});
 for(let i=0;i<30&&!f.calls.some(x=>x.method==='turn/start');i++)await new Promise(resolve=>setTimeout(resolve,5));
 const start=f.calls.find(x=>x.method==='turn/start');assert.ok(start);assert.equal(start.params.permissions,'panel_Geral');
 assert.match(start.params.input[0].text,/fixture result/);
 f.notify('turn/completed',{threadId:'saved-admin',turn:{status:'completed'}});
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(f.calls.filter(x=>x.method==='turn/start').length,1);
 const list=(await(await f.request('/tool-calls')).json()).calls;assert.equal(list[0].deliveryState,'delivered');
});
test('large conversation response is bounded without losing the latest message',async t=>{
 const messages=Array.from({length:40},(_,i)=>({role:i%2?'assistant':'user',text:'😀'.repeat(6000)+i}));
 const f=await fixture(t,{saved:[{id:'large-thread',project:'Painel',messages}]});
 const response=await f.request('/threads/large-thread');const raw=await response.text();const data=JSON.parse(raw);
 assert.equal(response.status,200);assert.ok(Buffer.byteLength(raw)<500000);assert.equal(data.thread.historyTruncated,true);
 assert.equal(data.thread.messages.at(-1).text,messages.at(-1).text);
});
