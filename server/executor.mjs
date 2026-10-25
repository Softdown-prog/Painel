import http from 'node:http';
import net from 'node:net';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { authorize, visibleContainers } from './executor-policy.ts';

const socket = process.env.PANEL_EXECUTOR_SOCKET || '/run/panel-executor/docker.sock';
const dockerSocket = '/var/run/docker.sock';
const images = (process.env.PANEL_APPS_ALLOWED_IMAGES || '').split(',').map(s=>s.trim()).filter(Boolean);
const ghcrOwner = process.env.PANEL_GHCR_ALLOWED_OWNER || 'Softdown-prog';
const maxJson = 32 * 1024;
function audit(method, path, code, reason) {
  // Never log Authorization, X-Registry-Auth, request body or credentials.
  console.log(JSON.stringify({at:new Date().toISOString(),service:'docker-executor',method,
    operation:path.split('?')[0].slice(0,180),status:code,reason}));
}
async function dockerInspect(id) {
  return new Promise((resolve,reject)=>{
    const req=http.request({socketPath:dockerSocket,
      path:'/v1.45/containers/'+encodeURIComponent(id)+'/json',method:'GET',timeout:12000},response=>{
      if(response.statusCode===404){response.resume();resolve(null);return;}
      if(response.statusCode!==200){response.resume();reject(new Error('Inspect failed'));return;}
      const chunks=[];let size=0;
      response.on('data',part=>{size+=part.length;if(size>1048576)req.destroy(new Error('Oversized inspect'));else chunks.push(part);});
      response.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(e){reject(e);}});
    });
    req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Docker inspect timeout')));req.end();
  });
}
async function body(req) {
  if(req.method!=='POST' || req.url?.includes('/images/create')) return undefined;
  const chunks=[];let size=0;
  for await(const chunk of req) {
    size+=chunk.length;
    if(size>maxJson) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if(!size)return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function json(res,status,value) {
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(value));
}
function proxy(req,res,payload,decision) {
  const isPull=req.url?.startsWith('/v1.45/images/create?');
  const data=payload===undefined?undefined:Buffer.from(JSON.stringify(payload));
  const headers=data?{'content-type':'application/json','content-length':String(data.length)}:{};
  if(isPull&&typeof req.headers['x-registry-auth']==='string'){
    if(req.headers['x-registry-auth'].length>8192)return json(res,400,{error:'Registry auth too large'});
    headers['x-registry-auth']=req.headers['x-registry-auth'];
  }
  // Forward by the immutable Docker ID resolved by the policy, never by a mutable alias.
  const upstreamPath=decision.targetId
    ? (req.url||'').replace(/^\/v1\.45\/containers\/[^/?]+/, '/v1.45/containers/'+encodeURIComponent(decision.targetId))
    : req.url;
  const upstream=http.request({socketPath:dockerSocket,path:upstreamPath,method:req.method,headers,
    timeout:isPull?600000:25000},response=>{
    const responseHeaders={'content-type':response.headers['content-type']||'application/json','cache-control':'no-store'};
    if(decision.filterList&&response.statusCode===200){
      let chunks=[],size=0;
      response.on('data',part=>{size+=part.length;if(size>2000000)response.destroy(new Error('Container list too large'));else chunks.push(part);});
      response.on('end',()=>{try{
        const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(!Array.isArray(result))throw new Error('Bad list');
        json(res,200,visibleContainers(result));
      }catch{if(!res.headersSent)json(res,502,{error:'Docker list malformed'});}});
      response.on('error',()=>{if(!res.headersSent)json(res,502,{error:'Docker list failed'});});
    }else{
      res.writeHead(response.statusCode||502,responseHeaders);
      response.pipe(res);
    }
  });
  upstream.on('timeout',()=>upstream.destroy(new Error('Docker request timed out')));
  upstream.on('error',error=>{
    console.error('Docker executor upstream failure:',error.message);
    if(!res.headersSent)json(res,502,{error:'Docker backend unavailable'});else res.end();
  });
  req.on('aborted',()=>upstream.destroy(new Error('Client disconnected')));
  upstream.end(data);
}
const server=http.createServer(async(req,res)=>{
  if(req.url==='/_executor/health'&&req.method==='GET')return json(res,200,{ok:true});
  try{
    const payload=await body(req);
    const decision=await authorize({method:req.method||'',url:req.url||'',payload,
      inspect:dockerInspect,images,ghcrOwner});
    audit(req.method||'',req.url||'',decision.ok?200:403,decision.reason);
    if(!decision.ok)return json(res,403,{error:'Docker operation denied by executor'});
    proxy(req,res,payload,decision);
  }catch(error){
    console.error('Executor error:',error instanceof Error?error.message:'unknown');
    if(!res.headersSent)json(res,502,{error:'Docker executor failed'});
  }
});
mkdirSync(dirname(socket),{recursive:true,mode:0o700});
if(existsSync(socket)){
  const check=net.connect(socket);
  check.once('connect',()=>{console.error('Executor socket already active');process.exit(1);});
  check.once('error',()=>{check.destroy();unlinkSync(socket);listen();});
}else listen();
function listen(){
  server.listen(socket,()=>{chmodSync(socket,0o660);console.log('Docker executor listening on internal unix socket');});
}
