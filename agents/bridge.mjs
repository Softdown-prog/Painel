import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFileSync,readdirSync,existsSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {timingSafeEqual} from 'node:crypto';
const slug=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const threadId=/^[a-zA-Z0-9_-]{4,128}$/;
export const validPrompt=s=>typeof s==='string'&&s.trim().length>0&&s.length<=4000&&
 !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s);
export function projects(dir){return existsSync(dir)?readdirSync(dir,{withFileTypes:true})
 .filter(d=>d.isDirectory()&&slug.test(d.name)).map(d=>d.name).sort():[];}
export const permissionName=project=>'panel_'+project;
export function codexArguments(workspace,registered,codexHome='/home/node/.codex'){
 const args=['app-server','--listen','stdio://','-c','default_permissions="panel_Geral"'];
 for(const project of registered){
  if(!slug.test(project))throw Error('Invalid project');
  const prefix='permissions.'+permissionName(project);
  const rules={':root':'read',[workspace]:'deny',[codexHome]:'deny',
   '/run/secrets':'deny','/state':'deny',[join(workspace,project)]:project==='Geral'?'read':'write'};
  const filesystem=Object.entries(rules).map(([path,access])=>JSON.stringify(path)+'='+JSON.stringify(access)).join(',');
  args.push('-c',prefix+'.filesystem={'+filesystem+'}');
  args.push('-c',prefix+'.network.enabled=false');
 }
 return args;
}
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json',
 'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
async function input(req){let n=0,s='';for await(const c of req){n+=c.length;
 if(n>8192)throw Error('Large input');s+=c.toString('utf8');}
 const v=JSON.parse(s);if(!v||Array.isArray(v)||typeof v!=='object')throw Error('Bad JSON');return v;}
export function createBridge({secret,workspace,stateDir,spawnCodex=spawn}){
 if(typeof secret!=='string'||secret.length<32)throw Error('Missing bridge secret');
 mkdirSync(join(workspace,'Geral'),{recursive:true,mode:0o700});
 const stateFile=join(stateDir,'threads.json'),sessions=new Map();
 if(existsSync(stateFile)){const saved=JSON.parse(readFileSync(stateFile,'utf8'));
  if(!Array.isArray(saved))throw Error('Invalid state file');
  for(const s of saved.slice(-100))if(threadId.test(s.id)&&slug.test(s.project))
   sessions.set(s.id,{id:s.id,project:s.project,title:String(s.title||s.project).slice(0,80),
    messages:(Array.isArray(s.messages)?s.messages:[]).filter(m=>['user','assistant'].includes(m.role)&&
     typeof m.text==='string').slice(-40),status:'idle',reply:'',turnId:null});
 }
 function save(){writeFileSync(stateFile+'.tmp',JSON.stringify([...sessions.values()].map(s=>({
  id:s.id,project:s.project,title:s.title,messages:s.messages.slice(-40)}))),{mode:0o600});
  renameSync(stateFile+'.tmp',stateFile);}
 let proc,ready=false,authenticated=false,active=null,seq=0,registered=[];const requests=new Map();
 function rpc(method,params){if(!proc?.stdin.writable)return Promise.reject(Error('Codex offline'));
  const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{
   requests.delete(id);reject(Error('Codex timeout'));},25000);requests.set(id,{resolve,reject,timer});
   proc.stdin.write(JSON.stringify({id,method,params})+'\n',error=>{
    if(error&&requests.has(id)){clearTimeout(timer);requests.delete(id);reject(Error('Codex disconnected'));}});
  });}
 function finish(s,status){s.status=status;if(s.reply)s.messages.push({role:'assistant',text:s.reply});
  s.messages=s.messages.slice(-40);s.reply='';s.turnId=null;active=null;save();}
 function dispatch(x){
  if(x.method==='account/updated'){
   authenticated=Boolean(x.params?.authMode);return;}
  if(typeof x.id==='number'&&!x.method){const q=requests.get(x.id);if(!q)return;
   clearTimeout(q.timer);requests.delete(x.id);if(x.error)q.reject(Error('Codex rejected request'));else q.resolve(x.result);return;}
  if(typeof x.id==='number'&&typeof x.method==='string'){
   // Fail closed for all privilege escalation/approval requests.
   const result=x.method==='item/permissions/requestApproval'?{permissions:{}}:
    x.method==='mcpServer/elicitation/request'?{action:'decline',content:null}:
    x.method.includes('requestApproval')?{decision:'decline'}:null;
   proc.stdin.write(JSON.stringify(result?{id:x.id,result}:{id:x.id,error:{code:-32601,message:'Unsupported'}})+'\n');return;}
  const s=sessions.get(x.params?.threadId);if(!s||active!==s.id)return;
  if(x.method==='item/agentMessage/delta'&&typeof x.params.delta==='string')
   s.reply=(s.reply+x.params.delta).slice(0,24000);
  if(x.method==='item/completed'&&x.params.item?.type==='agentMessage'&&!s.reply&&
   typeof x.params.item.text==='string')s.reply=x.params.item.text.slice(0,24000);
  if(x.method==='turn/completed')finish(s,x.params.turn?.status==='completed'?'completed':
   x.params.turn?.status==='interrupted'?'interrupted':'failed');
 }
 function start(){registered=projects(workspace);
  proc=spawnCodex('codex',codexArguments(workspace,registered,process.env.CODEX_HOME||'/home/node/.codex'),
  {cwd:workspace,stdio:['pipe','pipe','pipe'],env:process.env});proc.stderr.resume();
  createInterface({input:proc.stdout}).on('line',line=>{if(line.length>1000000)return;
   try{dispatch(JSON.parse(line));}catch{/* malformed event */}});
  const down=()=>{ready=false;authenticated=false;for(const q of requests.values()){
   clearTimeout(q.timer);q.reject(Error('Disconnected'));}requests.clear();
   if(active){const s=sessions.get(active);if(s)finish(s,'interrupted');}};
  proc.on('error',down);proc.on('exit',down);
  rpc('initialize',{clientInfo:{name:'softdown_panel',title:'Painel Agentes',version:'0.1.0'},
   capabilities:{experimentalApi:true}})
   .then(async()=>{proc.stdin.write('{"method":"initialized","params":{}}\n');ready=true;
    const auth=await rpc('account/read',{refreshToken:false});authenticated=Boolean(auth?.account);
   })
   .catch(()=>{ready=false;});
 }
 const server=createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/health')return json(res,ready?200:503,{ok:ready});
  const candidate=req.headers['x-panel-agent-key'];
  if(typeof candidate!=='string'||Buffer.byteLength(candidate)!==Buffer.byteLength(secret)||
   !timingSafeEqual(Buffer.from(candidate),Buffer.from(secret)))return json(res,404,{error:'Not found'});
  const path=new URL(req.url||'/','http://agent.local').pathname;
  if(path==='/status'&&req.method==='GET')return json(res,200,
   {enabled:true,ready:ready&&authenticated,projects:registered,active:!!active});
  if(path==='/threads'&&req.method==='GET')return json(res,200,
   {threads:[...sessions.values()].map(s=>({id:s.id,project:s.project,title:s.title,status:s.status})).reverse()});
  const m=/^\/threads\/([a-zA-Z0-9_-]{4,128})(?:\/(turns|cancel))?$/.exec(path);
  const s=m&&sessions.get(m[1]);
  if(s&&req.method==='GET'&&!m[2])return json(res,200,{thread:{
   id:s.id,project:s.project,title:s.title,messages:s.messages,status:s.status,reply:s.reply}});
  if(req.method==='POST'&&(!ready||!authenticated))return json(res,503,{error:'Codex não autenticado. Faça login no servidor e reinicie o serviço.'});
  try{
   if(path==='/threads'&&req.method==='POST'){
    if(sessions.size>=100)return json(res,409,{error:'Limite de conversas atingido.'});
    const b=await input(req);if(typeof b.project!=='string'||!slug.test(b.project)||
     !registered.includes(b.project))return json(res,400,{error:'Projeto não autorizado.'});
    const result=await rpc('thread/start',{cwd:join(workspace,b.project),
     permissions:permissionName(b.project),approvalPolicy:'never',serviceName:'softdown_panel'});
    const id=result?.thread?.id;if(typeof id!=='string'||!threadId.test(id))throw Error('Bad thread ID');
    const created={id,project:b.project,title:b.project,messages:[],status:'idle',reply:'',turnId:null};
    sessions.set(id,created);save();return json(res,201,{thread:created});
   }
   if(s&&m[2]==='turns'&&req.method==='POST'){
    if(active)return json(res,409,{error:'Outra tarefa ainda está em execução.'});
    if(!registered.includes(s.project)||!projects(workspace).includes(s.project))return json(res,409,{error:'Projeto indisponível.'});
    const b=await input(req);if(!validPrompt(b.message))return json(res,400,
     {error:'Mensagem inválida (até 4.000 caracteres).'});
    if(active)return json(res,409,{error:'Outra tarefa ainda está em execução.'});
    s.messages.push({role:'user',text:b.message.trim()});s.messages=s.messages.slice(-40);
    s.status='running';s.reply='';active=s.id;save();
    try{await rpc('thread/resume',{threadId:s.id,excludeTurns:true,permissions:permissionName(s.project)});
     const run=await rpc('turn/start',{threadId:s.id,input:[{type:'text',text:b.message.trim()}],
      cwd:join(workspace,s.project),approvalPolicy:'never',permissions:permissionName(s.project)});
     if(active===s.id)s.turnId=run?.turn?.id||null;return json(res,202,{ok:true});
    }catch{if(active===s.id)finish(s,'failed');
     return json(res,502,{error:'Falha ao iniciar a tarefa.'});}
   }
   if(s&&m[2]==='cancel'&&req.method==='POST'){
    if(active!==s.id||!s.turnId)return json(res,409,{error:'Nenhuma tarefa ativa.'});
    await rpc('turn/interrupt',{threadId:s.id,turnId:s.turnId});return json(res,200,{ok:true});
   }
  }catch{return json(res,502,{error:'Falha ao comunicar com o Codex.'});}
  return json(res,404,{error:'Recurso não encontrado.'});
 });
 return {server,start,stop:()=>proc?.kill('SIGTERM')};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 const service=createBridge({secret:readFileSync(process.env.PANEL_AGENT_KEY_FILE||
  '/run/secrets/panel-agent-key','utf8').trim(),
  workspace:process.env.PANEL_AGENT_WORKSPACE||'/workspace',
  stateDir:process.env.PANEL_AGENT_STATE_DIR||'/state'});
 service.start();service.server.listen(Number(process.env.PORT||8091),'0.0.0.0');
}
