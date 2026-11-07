/** Session-protected API bridge. No browser-controlled shell commands or URLs. */
import type {IncomingMessage,ServerResponse} from 'node:http';
import {readFileSync} from 'node:fs';
type Deps={send:(res:ServerResponse,status:number,body:unknown)=>void;
 body:(req:IncomingMessage)=>Promise<Record<string,unknown>>};
export async function handleAgentRoute(req:IncomingMessage,res:ServerResponse,deps:Deps):Promise<boolean>{
 const path=new URL(req.url||'/','http://panel.local').pathname;
 if(!path.startsWith('/agents'))return false;
 const get=req.method==='GET'&&(path==='/agents/status'||path==='/agents/threads'||
  /^\/agents\/threads\/[a-zA-Z0-9_-]{4,128}$/.test(path));
 const post=req.method==='POST'&&(path==='/agents/threads'||
  /^\/agents\/threads\/[a-zA-Z0-9_-]{4,128}\/(turns|cancel)$/.test(path));
 if(!get&&!post){deps.send(res,404,{error:'Rota de agentes não encontrada.'});return true;}
 if(process.env['PANEL_CODEX_AGENTS_ENABLED']!=='1'){
  deps.send(res,path==='/agents/status'?200:503,
   path==='/agents/status'?{enabled:false,ready:false,projects:[]}:{error:'Agentes não habilitados.'});
  return true;
 }
 try{
  const key=readFileSync(process.env['PANEL_CODEX_AGENT_KEY_FILE']||
   '/run/secrets/panel-agent-key','utf8').trim();
  if(key.length<32)throw Error('Missing key');
  const payload=post?await deps.body(req):undefined;
  const target=process.env['PANEL_CODEX_AGENT_URL']||'http://codex-agents:8091';
  const response=await fetch(target+path.slice('/agents'.length),{
   method:req.method,redirect:'error',signal:AbortSignal.timeout(30000),
   headers:{'x-panel-agent-key':key,'content-type':'application/json'},
   ...(payload?{body:JSON.stringify(payload)}:{})
  });
  if(Number(response.headers.get('content-length')||0)>1000000)throw Error('Large response');
  const raw=await response.text();
  if(Buffer.byteLength(raw,'utf8')>1000000)throw Error('Large response');
  const data:unknown=JSON.parse(raw);
  if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Invalid reply');
  deps.send(res,response.status,data);
 }catch{deps.send(res,503,{error:'Agentes indisponíveis. Verifique o Codex na VPS.'});}
 return true;
}
