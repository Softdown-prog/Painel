import test from 'node:test';
import assert from 'node:assert/strict';
import {TerminalJobManager,handleSshTerminalJobRoute,validJobCommand} from './terminal-jobs.ts';

function defer(){
 let resolve, reject;
 const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
}
const tick=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function fakeClient(manager){
 let response;
 const send=(_res,status,data)=>{response={status,data};};
 return async function call(path,method='GET',body={}){
  response=undefined;
  const matched=await handleSshTerminalJobRoute({url:path,method},{},{
   send,body:async()=>body,enabled:true,configured:true,manager
  });
  assert.equal(matched,true);
  return response;
 };
}
test('rejects malformed/oversized multiline payloads before SSH',()=>{
 assert.equal(validJobCommand({command:'echo start\necho fim'}),true);
 for(const input of [{command:''},{command:' '},{command:'echo \u0000'},
                     {command:'z'.repeat(4*1024*1024+1)},
                     {command:'uptime',password:'secret'}]){
  assert.equal(validJobCommand(input),false);
 }
});
test('non-object command bodies always fail closed without exceptions',()=>{
  for(const body of [null,undefined,false,0,'uptime',[],['uptime'],{}]){
    assert.equal(validJobCommand(body),false);
  }
  assert.equal(validJobCommand({command:'uptime'}),true);
});
test('job responds immediately and streams progress without 18-second cutoff',async()=>{
 const pending=defer();let push;
 const manager=new TerminalJobManager(async (_command,onData)=>{push=onData;return pending.promise;});
 const call=fakeClient(manager);
 const started=await call('/terminal/ssh/jobs','POST',{command:'printf pronto'});
 assert.equal(started.status,202);
 assert.match(started.data.job.id,/^[a-f0-9]{32}$/);
 await tick();
 push('primeira linha\n');
 const live=await call('/terminal/ssh/jobs/current');
 assert.equal(live.status,200);
 assert.equal(live.data.job.state,'running');
 assert.equal(live.data.job.output,'primeira linha\n');
 const second=await call('/terminal/ssh/jobs','POST',{command:'uptime'});
 assert.equal(second.status,429);
 pending.resolve(0);
 await tick();
 const ended=await call('/terminal/ssh/jobs/'+started.data.job.id);
 assert.equal(ended.status,200);
 assert.equal(ended.data.job.state,'completed');
 assert.equal(ended.data.job.exitCode,0);
 assert.equal(ended.data.job.fingerprint.length,16);
 assert.equal(Object.hasOwn(ended.data.job,'command'),false);
});
test('bounded output truncates without killing the running command',async()=>{
 let emit;const pending=defer();
 const manager=new TerminalJobManager(async (_command,onData)=>{emit=onData;return pending.promise;});
 const started=manager.start('echo data');assert.ok(started);
 await tick();
 emit('x'.repeat(120000));
 const status=manager.current();
 assert.equal(status.state,'running');
 assert.equal(status.truncated,true);
 assert.equal(status.output.length,64000);
 pending.resolve(0);await tick();
 assert.equal(manager.current().state,'completed');
});
test('cancel only known job and surface remote-process limitation',async()=>{
 let aborted=false;
 const manager=new TerminalJobManager((_command,_onData,signal)=>
   new Promise((_resolve,reject)=>{
     signal.addEventListener('abort',()=>{aborted=true;reject(new Error('cancel'));},{once:true});
   }));
 const call=fakeClient(manager);
 const start=await call('/terminal/ssh/jobs','POST',{command:'sleep 30'});
 const other=await call('/terminal/ssh/jobs/'+'a'.repeat(32)+'/cancel','POST');
 assert.equal(other.status,404);
 const cancelled=await call('/terminal/ssh/jobs/'+start.data.job.id+'/cancel','POST');
 assert.equal(cancelled.status,200);
 assert.match(cancelled.data.warning,/não garante/);
 await tick();
 assert.equal(aborted,true);
 assert.equal(manager.current().state,'cancelled');
});
test('max runtime applies to jobs, not the HTTP request',async()=>{
 const manager=new TerminalJobManager((_command,_onData,signal)=>
  new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('timed out')),{once:true})),15);
 const job=manager.start('sleep 100');assert.ok(job);
 await new Promise(r=>setTimeout(r,40));
 await tick();
 assert.equal(manager.get(job.id).state,'timed_out');
});
test('routes require opt-in and reject unknown methods and missing jobs',async()=>{
 const manager=new TerminalJobManager(async()=>0);
 const call=fakeClient(manager);
 assert.equal((await call('/terminal/ssh/jobs','GET')).status,405);
 assert.equal((await call('/terminal/ssh/jobs/'+ 'a'.repeat(32))).status,404);
 assert.equal((await call('/terminal/ssh/jobs','POST',{command:'sh',token:'bad'})).status,400);
 let reply;
 const matches=await handleSshTerminalJobRoute({url:'/terminal/ssh/jobs',method:'POST'},{},{
  send:(_r,status,data)=>{reply={status,data}},body:async()=>({command:'date'}),enabled:false,configured:true,manager
 });
 assert.equal(matches,true);assert.equal(reply.status,403);
 assert.equal(await handleSshTerminalJobRoute({url:'/unrelated',method:'GET'},{},{
  send:()=>{},body:async()=>({}),enabled:true,configured:true,manager
 }),false);
});
