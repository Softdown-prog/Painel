import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PersistentTerminalJobManager} from './terminal-persistent.ts';
import {handleSshTerminalJobRoute} from './terminal-jobs.ts';

const id='d'.repeat(32);
const job={
 id,state:'running',startedAt:'2026-11-01T00:00:00.000Z',
 finishedAt:null,exitCode:null,output:'working\n',truncated:false,
 durationMs:20000,error:null,fingerprint:'b'.repeat(16)
};
test('persistent manager survives API-manager recreation and tracks host-owned job',async()=>{
 let running=true;
 const calls=[];
 const host=async (action,ref,command)=>{
  calls.push({action,ref,command});
  if(action==='start')return {job:{...job,id:ref}};
  if(action==='current'||action==='status')return {job:{...job,state:running?'running':'completed',
    finishedAt:running?null:'2026-11-01T00:00:20.000Z',exitCode:running?null:0}};
  if(action==='cancel'){running=false;return {job:{...job,state:'cancelled',finishedAt:job.startedAt}};}
  throw Error('unexpected');
 };
 const first=new PersistentTerminalJobManager(host);
 const started=await first.start('sleep 30');
 assert.match(started.id,/^[a-f0-9]{32}$/);
 const rebuilt=new PersistentTerminalJobManager(host);
 assert.equal((await rebuilt.get(started.id)).state,'running');
 assert.equal((await rebuilt.current()).state,'running');
 assert.equal((await rebuilt.cancel(started.id)).state,'cancelled');
 assert.deepEqual(calls.map(c=>c.action),['start','status','current','cancel']);
});
test('persistent bridge fails closed on invalid payload and never auto-retries uncertain writes',async()=>{
 let calls=0;
 const bad=new PersistentTerminalJobManager(async()=>{
  calls++;
  return {job:{...job,id:'../../etc/passwd'}};
 });
 await assert.rejects(()=>bad.current(),/estado inválido/i);
 assert.equal(calls,1);
 const network=new PersistentTerminalJobManager(async()=>{
  calls++;
  throw Error('host unreachable');
 });
 await assert.rejects(()=>network.start('echo private'),/host unreachable/);
 assert.equal(calls,2);
});
test('protected API route maps host supervisor loss to 503 instead of pretending task ended',async()=>{
 const manager=new PersistentTerminalJobManager(async()=>{throw Error('host unreachable secret');});
 let actual;
 const matched=await handleSshTerminalJobRoute({url:'/terminal/ssh/jobs/current',method:'GET'},{},{
  send:(_res,status,data)=>{actual={status,data}},
  enabled:true,configured:true,manager,body:async()=>({})
 });
 assert.equal(matched,true);
 assert.equal(actual.status,503);
 assert.doesNotMatch(JSON.stringify(actual),/host unreachable secret/);
});
test('source sends script over SSH stdin, not command line or journald',()=>{
 const adapter=readFileSync(new URL('./terminal-persistent.ts',import.meta.url),'utf8');
 const host=readFileSync(new URL('../operations/terminal_host_jobs.py',import.meta.url),'utf8');
 assert.match(adapter,/child\.stdin\.end\(command\?\?''\)/);
 assert.match(adapter,/StrictHostKeyChecking=yes/);
 assert.match(adapter,/UserKnownHostsFile=/);
 assert.match(host,/subprocess\.Popen\(\['\/bin\/sh',str\(script\)\]/);
 assert.match(host,/MAX_RUNTIME = 1800/);
 assert.match(host,/MAX_AGE = 3600/);
 assert.match(host,/os\.O_NOFOLLOW/);
 assert.match(host,/--property=RuntimeMaxSec=1800/);
 assert.doesNotMatch(host,/shell=True/);
});
