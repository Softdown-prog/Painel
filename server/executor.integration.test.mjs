import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ident='a'.repeat(64);
const labels={'com.softload.panel.managed':'true','com.softload.panel.slug':'demo'};
async function exchange(socket,path,method='GET',data) {
  return await new Promise((resolve,reject)=>{
    const body=data===undefined?undefined:JSON.stringify(data);
    const req=http.request({socketPath:socket,path,method,
      headers:body?{'content-type':'application/json','content-length':Buffer.byteLength(body)}:{}},res=>{
      const chunks=[];
      res.on('data',part=>chunks.push(part));
      res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch(error){reject(error);}});
    });
    req.on('error',reject);req.end(body);
  });
}
test('Unix executor rejects forbidden Docker calls and forwards authorized mutations by inspected immutable ID',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'panel-ex-'));
  const executorSocket=join(dir,'executor.sock'),mockSocket=join(dir,'docker.sock');
  const requests=[];
  const daemon=http.createServer((req,res)=>{
    requests.push({path:req.url,method:req.method});
    const reply=(code,data)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(data));};
    if(req.method==='GET' && req.url==='/_ping')return reply(200,{ok:true});
    if(req.method==='GET' && req.url==='/v1.45/containers/softload-app-demo/json')
      return reply(200,{Id:ident,Name:'/softload-app-demo',Config:{Labels:labels},State:{Running:true,Status:'running'}});
    if(req.method==='GET' && req.url==='/v1.45/containers/json?all=1')
      return reply(200,[
        {Names:['/softload-app-demo'],Labels:labels},
        {Names:['/another-project'],Labels:{}},
        {Names:['/softload-vps-app-1'],Labels:{}}
      ]);
    if(req.method==='POST' && req.url==='/v1.45/containers/'+ident+'/stop?t=10')
      return reply(200,{ok:true});
    return reply(404,{error:'no such route'});
  });
  await new Promise(resolve=>daemon.listen(mockSocket,resolve));
  const child=spawn(process.execPath,[fileURLToPath(new URL('./executor.mjs',import.meta.url))],{
    env:{...process.env,NODE_ENV:'test',PANEL_EXECUTOR_SOCKET:executorSocket,
      PANEL_TEST_DOCKER_SOCKET:mockSocket,PANEL_APPS_ALLOWED_IMAGES:'example:1'},
    stdio:['ignore','pipe','pipe']
  });
  let stderr='';
  child.stderr.on('data',chunk=>{stderr+=String(chunk);});
  try{
    let ready=false;
    for(let i=0;i<150;i++){
      if(existsSync(executorSocket)){
        try{if((await exchange(executorSocket,'/_executor/health')).status===200){ready=true;break;}}catch{}
      }
      if(child.exitCode!==null)break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.ok(ready,'Executor did not start: '+stderr);
    const list=await exchange(executorSocket,'/v1.45/containers/json?all=1');
    assert.equal(list.status,200);
    assert.equal(list.data.length,2);
    assert.equal(list.data.some(c=>c.Names.includes('/another-project')),false);
    const forbidden=await exchange(executorSocket,'/v1.45/containers/prune','POST',{});
    assert.equal(forbidden.status,403);
    const badCreate=await exchange(executorSocket,'/v1.45/containers/create?name=softload-app-demo','POST',{
      Image:'example:1',User:'0:0',HostConfig:{Privileged:true}
    });
    assert.equal(badCreate.status,403);
    const stopped=await exchange(executorSocket,'/v1.45/containers/softload-app-demo/stop?t=10','POST');
    assert.equal(stopped.status,200);
    assert.ok(requests.some(r=>r.path==='/v1.45/containers/'+ident+'/stop?t=10'));
    assert.equal(requests.some(r=>r.path.includes('/prune')||r.path.includes('/create?')),false);
  }finally{
    child.kill('SIGTERM');
    await new Promise(resolve=>child.once('exit',resolve));
    await new Promise(resolve=>daemon.close(resolve));
    rmSync(dir,{recursive:true,force:true});
  }
});
