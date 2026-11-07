/** Administrative operations stay in the API. The model only proposes them. */
import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {github,readRepositories,validRepository,validRef} from './github.ts';
import {terminalJobManager} from './terminal-jobs.ts';
import {terminalSshConfig} from './terminal-ssh.ts';

type Binding={repository:string;branch:string};
type Call={id:string;threadId:string;project:string;tool:string;mode:string;status:string;
 fingerprint:string;args:Record<string,any>;expiresAt:number;destination?:Record<string,string|number>};
type Dependencies={dataDir:string;inventory:()=>Promise<unknown>;resources:()=>Promise<unknown>;
 bridge:(path:string,method?:string,body?:object)=>Promise<any>;
 git?:typeof github;jobs?:typeof terminalJobManager;now?:()=>number;enabled?:boolean;host?:()=>{host:string;user:string;port:number;valid:boolean}};
const ID=/^[a-f0-9]{32}$/,HASH=/^[a-f0-9]{64}$/,SHA=/^[a-f0-9]{40}$/;
const slug=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const privateContent=(s:string)=>/-----BEGIN (?:[A-Z ]*PRIVATE KEY)|\b(?:gh[pousr]_|github_pat_|sk-proj-|APP_USR-|cfat_|cfut_|AKIA)[A-Za-z0-9_\/-]{10,}|\bre_[A-Za-z0-9_]{20,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(s);
export function redactAgentOutput(value:string,secrets:string[]=[]):string{
 let text=value.slice(0,64000);
 for(const secret of secrets)if(secret.length>=16)text=text.split(secret).join('[SEGREDO OCULTO]');
 text=text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,'[CHAVE PRIVADA OCULTA]')
  .replace(/\b(?:gh[pousr]_|github_pat_|sk-proj-|APP_USR-|cfat_|cfut_|re_)[A-Za-z0-9_\/-]{10,}/g,'[TOKEN OCULTO]')
  .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[JWT OCULTO]')
  .replace(/\b[a-f0-9]{64}\b/gi,'[VALOR OCULTO]')
  .replace(/((?:password|senha|secret|authorization|api[_-]?key|access[_-]?token)\s*[:=]\s*)[^\r\n]+/gi,'$1[OCULTO]')
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'�');
 return Buffer.from(text).subarray(0,12000).toString('utf8');
}
export function validatePublication(args:Record<string,any>):void{
 if(!SHA.test(args['baseSha'])||typeof args['title']!=='string'||!args['title'].trim()||args['title'].length>120||
  typeof args['description']!=='string'||args['description'].length>4000||privateContent(args['title']+args['description'])||
  !Array.isArray(args['files'])||!args['files'].length||args['files'].length>30)throw Error('Proposta de publicação inválida.');
 let bytes=0;const seen=new Set<string>();
 for(const f of args['files']){
  if(!f||typeof f.path!=='string'||f.path.length>240||/[\x00-\x1f\x7f\\]/.test(f.path)||
   f.path.split('/').some((p:string)=>!p||p==='..'||p==='.git')||
   /(^|\/)(?:\.env(?:\.(?!example$|sample$)[^/]+)?|\.npmrc|id_rsa|id_ed25519|auth\.json)$/.test(f.path)||
   seen.has(f.path)||!['100644','100755'].includes(f.mode)||!(f.content===null||typeof f.content==='string'))throw Error('Arquivo não autorizado.');
  seen.add(f.path);
  if(f.content!==null){bytes+=Buffer.byteLength(f.content);if(privateContent(f.content)||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(f.content))throw Error('Possível segredo ou binário.');}
 }
 if(bytes>128*1024)throw Error('Publicação excede 128 KiB.');
}

export class AgentOperations {
 private readonly d:Dependencies;
 private readonly mappingFile:string;
 private busy=false;
 private readonly effects=new Set<string>();
 private readonly hostJobs=new Map<string,string>();
 private readonly secrets:string[]=[];
 constructor(d:Dependencies){
  this.d=d;this.mappingFile=join(d.dataDir,'agent-projects.json');
  for(const key of ['PANEL_EDGE_KEY_FILE','PANEL_CODEX_AGENT_KEY_FILE','PANEL_GITHUB_TOKEN_FILE','PANEL_TERMINAL_SSH_KEY_FILE']){
   try{const path=process.env[key];if(path)this.secrets.push(readFileSync(path,'utf8').trim());}catch{/* Optional credential absent. */}
  }
 }
 private enabled(){return this.d.enabled??process.env['PANEL_CODEX_OPERATIONS_ENABLED']==='1';}
 private bindings():Record<string,Binding>{
  if(!existsSync(this.mappingFile))return {};
  const value:unknown=JSON.parse(readFileSync(this.mappingFile,'utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Vínculos inválidos.');
  return value as Record<string,Binding>;
 }
 private binding(project:string):Binding{
  const b=this.bindings()[project];
  if(!b||!validRepository(b.repository)||!validRef(b.branch)||!readRepositories(this.d.dataDir).some(r=>r.fullName===b.repository&&r.branch===b.branch))
   throw Error('Conecte o projeto a um repositório autorizado antes de publicar.');
  return b;
 }
 async catalog(){return {bindings:this.bindings(),repositories:readRepositories(this.d.dataDir)};}
 async bind(input:Record<string,unknown>){
  if(!this.enabled())throw Error('Operações do agente não habilitadas.');
  const project=input['project'],repository=input['repository'];
  if(typeof project!=='string'||!slug.test(project)||['Geral','AdministracaoVPS'].includes(project)||!validRepository(repository))throw Error('Projeto inválido.');
  const linked=readRepositories(this.d.dataDir).find(r=>r.fullName===repository);
  const status=await this.d.bridge('/status');
  if(!linked||!status.projects.includes(project))throw Error('Projeto ou repositório não autorizado.');
  const mappings=this.bindings();mappings[project]={repository,branch:linked.branch};
  writeFileSync(this.mappingFile+'.tmp',JSON.stringify(mappings),{mode:0o600});renameSync(this.mappingFile+'.tmp',this.mappingFile);
  return {ok:true};
 }
 private validCall(c:any):c is Call{return c&&ID.test(c.id)&&HASH.test(c.fingerprint)&&typeof c.project==='string'&&slug.test(c.project)&&
  typeof c.threadId==='string'&&c.args&&typeof c.args==='object'&&!Array.isArray(c.args);}
 private async finish(c:Call,result:object,review=false){return this.d.bridge('/tool-calls/'+c.id+(review?'/review':'/result'),'POST',{fingerprint:c.fingerprint,result});}
 private async read(c:Call):Promise<unknown>{
  if(c.tool==='consultar_vps'){
   if(Object.keys(c.args).join(',')!=='consulta')throw Error('Consulta inválida.');
   if(c.args['consulta']==='containers')return this.d.inventory();
   if(c.args['consulta']==='recursos')return this.d.resources();
  }
  if(c.tool==='consultar_github'){
   if(Object.keys(c.args).join(',')!=='consulta')throw Error('Consulta inválida.');
   if(c.args['consulta']==='repositorios')return {repositories:readRepositories(this.d.dataDir).map(r=>({repository:r.fullName,branch:r.branch,workflow:r.workflow}))};
   const b=this.binding(c.project),git=this.d.git??github;
   if(c.args['consulta']==='execucoes'){
    const data=await git('/repos/'+b.repository+'/actions/runs?per_page=10&branch='+encodeURIComponent(b.branch));
    return {runs:(data.workflow_runs??[]).slice(0,10).map((r:any)=>({id:r.id,sha:r.head_sha,status:r.status,conclusion:r.conclusion,url:r.html_url,name:r.name}))};
   }
   if(c.args['consulta']==='pull_requests'){
    const data=await git('/repos/'+b.repository+'/pulls?state=open&per_page=10');
    return {pullRequests:data.slice(0,10).map((r:any)=>({number:r.number,title:r.title,url:r.html_url,draft:r.draft,sha:r.head?.sha}))};
   }
  }
  throw Error('Consulta não autorizada.');
 }
 private destination(c:Call):Record<string,string|number>{
  if(c.tool==='publicar_pull_request'){const b=this.binding(c.project);return {repository:b.repository,branch:b.branch};}
  if(c.tool==='solicitar_comando_vps'&&c.project==='AdministracaoVPS'){
   const settings=(this.d.host??terminalSshConfig)();if(!settings.valid)throw Error('SSH indisponível.');
   return {host:settings.host,user:settings.user,port:settings.port};
  }
  throw Error('Destino não autorizado.');
 }
 async step():Promise<void>{
  if(!this.enabled()||this.busy)return;this.busy=true;
  try{
   const data=await this.d.bridge('/tool-calls');
   for(const c of (Array.isArray(data.calls)?data.calls:[]).slice(0,100)){
    if(!this.validCall(c)||this.effects.has(c.id))continue;
    try{
     if(c.status==='pending'&&c.mode==='approval'&&!c.destination){
      const destination=this.destination(c);await this.d.bridge('/tool-calls/'+c.id+'/prepare','POST',{fingerprint:c.fingerprint,destination});
     }else if(c.status==='pending'&&c.mode==='read'&&['consultar_vps','consultar_github'].includes(c.tool)){
      await this.d.bridge('/tool-calls/'+c.id+'/claim','POST',{fingerprint:c.fingerprint});
      const result=await this.read(c),serialized=JSON.stringify(result);
      if(Buffer.byteLength(serialized)>24000||privateContent(serialized)||this.secrets.some(s=>s.length>=16&&serialized.includes(s)))throw Error('Resposta excede o limite ou contém dados privados.');
      await this.finish(c,{success:true,data:result});
     }else if(c.status==='running'&&c.tool==='solicitar_comando_vps'){
      const id=this.hostJobs.get(c.id);
      if(!id){await this.finish(c,{success:false,message:'A API reiniciou ou não confirmou a execução. Consulte o Terminal VPS antes de reenviar.'});continue;}
      const job=await (this.d.jobs??terminalJobManager)().get(id);
      if(job&&job.state!=='running'){
       await this.finish(c,{success:job.state==='completed'&&job.exitCode===0,exitCode:job.exitCode,state:job.state,
        jobId:job.id,output:redactAgentOutput(job.output,this.secrets),truncated:job.truncated,
        durationMs:job.durationMs,
        warning:'Revise a saída antes de compartilhar com o modelo.'},true);
       this.hostJobs.delete(c.id);
      }
     }else if(c.status==='running'&&c.tool==='publicar_pull_request'){
      await this.finish(c,{success:false,message:'Publicação interrompida; confira branches e PRs no GitHub antes de repetir.'});
     }else if(c.status==='interrupted'&&this.hostJobs.has(c.id)){
      await (this.d.jobs??terminalJobManager)().cancel(this.hostJobs.get(c.id)!);this.hostJobs.delete(c.id);
     }
    }catch{if(c.status==='pending')try{await this.finish(c,{success:false,message:'Consulta ou destino indisponível. Confira o vínculo GitHub ou o SSH. Nenhuma operação foi executada.'});}catch{/* Claim expired or cancelled. */}}
   }
  }catch{/* Agent offline: no action or fallback shell. */}finally{this.busy=false;}
 }
 private async publish(c:Call){
  const registered=this.binding(c.project);validatePublication(c.args);
  if(!c.destination||c.destination['repository']!==registered.repository||c.destination['branch']!==registered.branch)throw Error('Destino alterado.');
  // Freeze the approved destination before any asynchronous GitHub call.
  const b={repository:String(c.destination['repository']),branch:String(c.destination['branch'])};
  const git=this.d.git??github,root='/repos/'+b.repository;
  const repo=await git(root);if(repo.full_name!==b.repository||repo.permissions?.push===false)throw Error('Repositório ou permissão divergente.');
  const base=await git(root+'/git/commits/'+c.args['baseSha']);
  const comparison=await git(root+'/compare/'+c.args['baseSha']+'...'+encodeURIComponent(b.branch));
  if(!['ahead','identical'].includes(comparison.status))throw Error('A base não pertence ao histórico da branch autorizada.');
  const tree=await git(root+'/git/trees','POST',{base_tree:base.tree.sha,tree:c.args['files'].map((f:any)=>
   f.content===null?{path:f.path,mode:f.mode,type:'blob',sha:null}:{path:f.path,mode:f.mode,type:'blob',content:f.content})});
  const commit=await git(root+'/git/commits','POST',{message:c.args['title'],tree:tree.sha,parents:[c.args['baseSha']]});
  const branch='codex/panel-'+c.id;
  await git(root+'/git/refs','POST',{ref:'refs/heads/'+branch,sha:commit.sha});
  const pr=await git(root+'/pulls','POST',{title:c.args['title'],body:c.args['description'],head:branch,base:b.branch,draft:true});
  return {success:true,repository:b.repository,branch,commit:commit.sha,pullRequest:pr.html_url,number:pr.number,draft:true};
 }
 async decide(id:string,action:string,input:Record<string,unknown>){
  if(!this.enabled()||!ID.test(id)||!HASH.test(String(input['fingerprint']??''))||Object.keys(input).join(',')!=='fingerprint')throw Error('Aprovação inválida.');
  if(this.effects.has(id))throw Error('Operação já está sendo processada.');
  this.effects.add(id);
  try{
   const data=await this.d.bridge('/tool-calls/'+id),c=data.call;
   if(!this.validCall(c)||c.id!==id||c.fingerprint!==input['fingerprint']||c.mode!=='approval')throw Error('A proposta mudou ou expirou.');
   if(action==='deny'){
    if(!['pending','awaiting_output'].includes(c.status))throw Error('Operação já enviada. Use interromper para solicitar cancelamento.');
    return this.d.bridge('/tool-calls/'+id+'/deny','POST',input);
   }
   if(action==='release'){
    if(c.status!=='awaiting_output')throw Error('Saída não disponível.');
    return this.d.bridge('/tool-calls/'+id+'/release','POST',input);
   }
   if(action!=='approve'||c.status!=='pending'||(this.d.now??Date.now)()>c.expiresAt)throw Error('Aprovação já utilizada ou expirada.');
   if(!c.destination||JSON.stringify(c.destination)!==JSON.stringify(this.destination(c)))throw Error('O destino foi alterado; gere outra proposta.');
   if(c.tool==='solicitar_comando_vps'){
    if(c.project!=='AdministracaoVPS'||typeof c.args['command']!=='string'||!c.args['command'].trim()||c.args['command'].length>4000||
     /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(c.args['command'])||privateContent(c.args['command'])||
     !(process.env['PANEL_TERMINAL_SSH_ENABLED']==='1'||this.d.jobs))throw Error('Comando ou terminal não autorizado.');
   }else if(c.tool==='publicar_pull_request'){this.binding(c.project);validatePublication(c.args);}
   else throw Error('Operação não autorizada.');
   if(this.secrets.some(s=>s.length>=16&&JSON.stringify(c.args).includes(s)))throw Error('A proposta contém credencial privada.');
   await this.d.bridge('/tool-calls/'+id+'/claim','POST',input);
   try{
    if(c.tool==='solicitar_comando_vps'){
     const job=await (this.d.jobs??terminalJobManager)().start(c.args['command']);
     if(!job)throw Error('Terminal ocupado.');this.hostJobs.set(id,job.id);
     return {ok:true,jobId:job.id};
    }
    const result=await this.publish(c);await this.finish(c,result);return result;
   }catch{await this.finish(c,{success:false,message:'Operação não confirmada. Confira o terminal ou GitHub antes de repetir; não houve tentativa automática.'});
    throw Error('Não foi possível confirmar a operação. Confira o estado antes de reenviar.');}
  }finally{this.effects.delete(id);}
 }
}
