import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {handleAgentRoute,agentBridge} from './agents.ts';

test('one authenticated bridge transport powers internal calls and chat with preserved HTTP statuses',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'panel-agent-transport-'));
 const secret='test-secret-'.padEnd(64,'a'),secretFile=join(dir,'bridge-secret');
 writeFileSync(secretFile,secret);
 const prior={key:process.env.PANEL_CODEX_AGENT_KEY_FILE,
   enable:process.env.PANEL_CODEX_AGENTS_ENABLED,
   url:process.env.PANEL_CODEX_AGENT_URL,fetch:globalThis.fetch};
 process.env.PANEL_CODEX_AGENT_KEY_FILE=secretFile;
 process.env.PANEL_CODEX_AGENTS_ENABLED='1';
 process.env.PANEL_CODEX_AGENT_URL='http://bridge.test:8091';
 const upstream=[];
 globalThis.fetch=async(url,options)=>{
  upstream.push({url,method:options.method,headers:options.headers,body:options.body});
  assert.equal(options.headers['x-panel-agent-key'],secret);
  if(url.endsWith('/denied'))return Response.json({error:'Permissão necessária'},{status:403});
  if(url.endsWith('/status'))return Response.json({enabled:true,ready:true});
  return Response.json({error:'Quota indisponível'},{status:429});
 };
 const restore=()=>{
  globalThis.fetch=prior.fetch;
  for(const [k,v] of [['PANEL_CODEX_AGENT_KEY_FILE',prior.key],
   ['PANEL_CODEX_AGENTS_ENABLED',prior.enable],['PANEL_CODEX_AGENT_URL',prior.url]]){
    if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
  rmSync(dir,{recursive:true,force:true});
 };
 const server=createServer((req,res)=>{
  void handleAgentRoute(req,res,{
   send:(reply,status,obj)=>{reply.writeHead(status,{'content-type':'application/json'});reply.end(JSON.stringify(obj));},
   body:async request=>{let raw='';for await(const chunk of request)raw+=chunk;return JSON.parse(raw);}
  });
 });
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));restore();});
 const base='http://127.0.0.1:'+server.address().port;
 assert.equal((await agentBridge('/status')).ready,true);
 await assert.rejects(()=>agentBridge('/denied'),/Bridge rejected request/);
 const api=await prior.fetch(base+'/agents/status');
 assert.equal(api.status,200);
 const status=await api.json();assert.equal(status.enabled,true);
 const quota=await prior.fetch(base+'/agents/usage');
 assert.equal(quota.status,429);assert.equal((await quota.json()).error,'Quota indisponível');
 const turn=await prior.fetch(base+'/agents/threads/thread-1234/turns',{method:'POST',
  headers:{'content-type':'application/json'},body:JSON.stringify({message:'Revisar código'})});
 assert.equal(turn.status,429);
 assert.equal(JSON.parse(upstream.at(-1).body).message,'Revisar código');
 assert.equal(upstream.at(-1).url,'http://bridge.test:8091/threads/thread-1234/turns');
 assert.equal((await prior.fetch(base+'/agents/unknown')).status,404);
 assert.equal(upstream.length,5);
 assert.doesNotMatch(JSON.stringify(await (await prior.fetch(base+'/agents/status')).json()),/test-secret/);
});
