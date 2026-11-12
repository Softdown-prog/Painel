/** Administrative operations stay in the API. The model only proposes them. */
import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {github,readRepositories,validRepository,validRef} from './github.ts';
import {terminalJobManager} from './terminal-jobs.ts';
import {terminalSshConfig} from './terminal-ssh.ts';
import {AgentGitHub,agentRepository} from './agent-github.ts';
import {agentBridgeUpload} from './agents.ts';

type Binding={repository:string;branch:string};
type Call={id:string;threadId:string;project:string;tool:string;mode:string;status:string;
 fingerprint:string;args:Record<string,any>;expiresAt:number;destination?:Record<string,string|number>};
type Dependencies={dataDir:string;inventory:()=>Promise<unknown>;resources:()=>Promise<unknown>;
 bridge:(path:string,method?:string,body?:object)=>Promise<any>;
 git?:typeof github;jobs?:typeof terminalJobManager;now?:()=>number;enabled?:boolean;host?:()=>{host:string;user:string;port:number;valid:boolean}};
const ID=/^[a-f0-9]{32}$/,HASH=/^[a-f0-9]{64}$/,SHA=/^[a-f0-9]{40}$/;
const slug=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WORKSPACE_SCRIPT='/usr/local/lib/panel-workspaces/workspace_build.py';
const WORKSPACE_ID=/^[a-f0-9]{16}$/;
const WORKSPACE_REPOSITORY_PROFILES:Record<string,ReadonlySet<string>>={
 'Softdown-prog/A7-forge-2D-':new Set(['lhs-quick','lhs-core','lhs-angular','lhs-visual','lhs-precommit']),
 'Softdown-prog/Terrania':new Set(['terrania-core','terrania-precommit']),
};
const WORKSPACE_PROFILES=new Set(Object.values(WORKSPACE_REPOSITORY_PROFILES).flatMap(set=>[...set]));
/** Constructs only allowlisted commands: neither the model nor the browser supplies shell text. */
export function workspaceCommand(action:'start'|'status',project:string,parameter:unknown):string{
 if(!slug.test(project)||['Geral','AdministracaoVPS'].includes(project))throw Error('Workspace inválido.');
 if(action==='start'&&typeof parameter==='string'&&WORKSPACE_PROFILES.has(parameter))
  return 'python3 '+WORKSPACE_SCRIPT+' start '+project+' '+parameter;
 if(action==='status'&&typeof parameter==='string'&&WORKSPACE_ID.test(parameter))
  return 'python3 '+WORKSPACE_SCRIPT+' status '+parameter;
 throw Error('Ação do workspace não autorizada.');
}

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
 readonly account:AgentGitHub;
 private readonly d:Dependencies;
 private readonly mappingFile:string;
 private busy=false;
 private readonly effects=new Set<string>();
 private readonly hostJobs=new Map<string,string>();
 private readonly secrets:string[]=[];
 constructor(d:Dependencies){
  this.d=d;this.mappingFile=join(d.dataDir,'agent-projects.json');
  this.account=new AgentGitHub({dataDir:d.dataDir,...(d.git?{git:d.git}:{}),bridge:d.bridge,upload:agentBridgeUpload});
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
  if(!b||!agentRepository(b.repository)||!validRef(b.branch)||!(readRepositories(this.d.dataDir).some(r=>r.fullName===b.repository&&r.branch===b.branch)||this.account.allows(b.repository)))
   throw Error('Conecte o projeto a um repositório autorizado antes de publicar.');
  return b;
 }
 async catalog(){return {bindings:this.bindings(),repositories:readRepositories(this.d.dataDir)};}
 async openProject(input:Record<string,unknown>){
  if(!this.enabled())throw Error('Operações não habilitadas.');
  const repository=input['repository'];await this.account.resolve(repository);
  const mappings=this.bindings(),status=await this.d.bridge('/status');
  const saved=Object.entries(mappings).find(([p,b])=>b.repository===repository&&(!input['branch']||b.branch===input['branch'])&&status.projects?.includes(p));
  if(saved)return {project:saved[0],...saved[1],reused:true};
  const result=await this.account.prepare(input);
  const latest=this.bindings();latest[result.project]={repository:result.repository,branch:result.branch};
  writeFileSync(this.mappingFile+'.tmp',JSON.stringify(latest),{mode:0o600});renameSync(this.mappingFile+'.tmp',this.mappingFile);
  return result;
 }
 /** Read-only live GitHub probe; confirms credentials and registered repositories independently of Codex. */
 async githubStatus(){
  if(!this.enabled())return {enabled:false,authenticated:false,repositories:[],workspaces:[]};
  const registered=readRepositories(this.d.dataDir).slice(0,12);
  let authenticated=false;
  const git=this.d.git??github;
  try{const user=await git('/user');
   authenticated=typeof user?.login==='string'&&user.login.length>0;
  }catch{/* Missing/expired token or provider offline. Do not disclose credential details. */}
  const repositories=[];
  for(const repo of registered){
   let readable=false,canPush=false;
   if(authenticated){
    try{
     const data=await git('/repos/'+repo.fullName);
     readable=data?.full_name===repo.fullName;
     canPush=readable&&data.permissions?.push===true;
    }catch{/* fail closed, no private response body */}
   }
   repositories.push({name:repo.fullName,branch:repo.branch,readable,canPush});
  }
  let workspaces:{project:string;repository:string;workspaceAvailable:boolean}[]=[];
  try{
   const response=await this.d.bridge('/status');
   const allowed=new Set(Array.isArray(response.projects)?response.projects:[]);
   const bindings=this.bindings();
   workspaces=Object.entries(bindings).filter(([name,b])=>slug.test(name)&&
    b&&typeof b==='object'&&typeof b.repository==='string').slice(0,50).map(([name,b])=>({
     project:name,repository:b.repository,workspaceAvailable:allowed.has(name)
   }));
  }catch{/* Bridge is not currently connected; do not assert workspace access. */}
  return {enabled:true,authenticated,repositories,workspaces,
   note:'Conectividade API GitHub e cadastro de cópias; não prova que o Codex executou um commit ou PR.'};
 }
 async bind(input:Record<string,unknown>){
  if(!this.enabled())throw Error('Operações do agente não habilitadas.');
  const project=input['project'],repository=input['repository'];
  if(typeof project!=='string'||!slug.test(project)||['Geral','AdministracaoVPS'].includes(project)||!validRepository(repository))throw Error('Projeto inválido.');
  const linked=readRepositories(this.d.dataDir).find(r=>r.fullName===repository);
  const status=await this.d.bridge('/status');
  if(!linked||!status.projects.includes(project))throw Error('Projeto ou repositório não autorizado.');
  if(project.startsWith('gh_')){
   const origin=(await this.d.bridge('/workspaces')).workspaces?.[project];
   if(!origin||origin.repository!==linked.fullName||origin.branch!==linked.branch)throw Error('A cópia pertence a outro repositório. Abra o projeto correto.');
  }
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
   if(c.args['consulta']==='repositorios'){
    if((await this.account.check().catch(()=>null))?.active){const result=await this.account.list();return {repositories:result.repositories.slice(0,50).map(r=>({repository:r.fullName,branch:r.branch})),hasMore:result.hasMore||result.repositories.length>50};}
    return {repositories:readRepositories(this.d.dataDir).map(r=>({repository:r.fullName,branch:r.branch,workflow:r.workflow}))};
   }
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
 private workspaceBinding(c:Call):Binding{
  const linked=this.binding(c.project);
  const profiles=WORKSPACE_REPOSITORY_PROFILES[linked.repository];
  if(!profiles)throw Error('Repositório não autorizado para compilação de workspace.');
  if(c.tool==='validar_workspace'&&!profiles.has(String(c.args['perfil']??'')))
   throw Error('Perfil não autorizado para o repositório vinculado.');
  return linked;
 }
 private destination(c:Call):Record<string,string|number>{
  if(c.tool==='publicar_pull_request'){const b=this.binding(c.project);return {repository:b.repository,branch:b.branch};}
  if(c.tool==='validar_workspace'){
   const b=this.workspaceBinding(c),settings=(this.d.host??terminalSshConfig)();
   if(!settings.valid)throw Error('Executor SSH indisponível.');
   workspaceCommand('start',c.project,c.args['perfil']);
   return {repository:b.repository,branch:b.branch,project:c.project,
    host:settings.host,user:settings.user,port:settings.port};
  }
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
     }else if(c.status==='pending'&&c.mode==='read'&&c.tool==='consultar_workspace'){
      this.workspaceBinding(c);
      const command=workspaceCommand('status',c.project,c.args['jobId']);
      await this.d.bridge('/tool-calls/'+c.id+'/claim','POST',{fingerprint:c.fingerprint});
      const job=await (this.d.jobs??terminalJobManager)().start(command);
      if(!job)throw Error('Terminal ocupado.');
      this.hostJobs.set(c.id,job.id);
     }else if(c.status==='pending'&&c.mode==='read'&&['consultar_vps','consultar_github'].includes(c.tool)){
      await this.d.bridge('/tool-calls/'+c.id+'/claim','POST',{fingerprint:c.fingerprint});
      const result=await this.read(c),serialized=JSON.stringify(result);
      if(Buffer.byteLength(serialized)>24000||privateContent(serialized)||this.secrets.some(s=>s.length>=16&&serialized.includes(s)))throw Error('Resposta excede o limite ou contém dados privados.');
      await this.finish(c,{success:true,data:result});
     }else if(c.status==='running'&&c.tool==='consultar_workspace'){
      const id=this.hostJobs.get(c.id);
      if(!id){await this.finish(c,{success:false,message:'Consulta interrompida, não repetida.'});continue;}
      const job=await (this.d.jobs??terminalJobManager)().get(id);
      if(job&&job.state!=='running'){
       this.hostJobs.delete(c.id);
       try{
        if(job.state!=='completed'||job.exitCode!==0||job.truncated)throw Error('Consulta SSH incompleta.');
        const parsed=JSON.parse(job.output);
        if(!parsed||parsed.project!==c.project||!['queued','running','passed','failed','busy'].includes(parsed.status))
         throw Error('Resposta inválida ou de outro projeto.');
        const binding=this.workspaceBinding(c);
        if(!WORKSPACE_REPOSITORY_PROFILES[binding.repository]?.has(String(parsed.profile??'')))
         throw Error('Perfil do job não pertence ao repositório autorizado.');
        const data={jobId:c.args['jobId'],profile:String(parsed.profile??''),
         status:parsed.status,passed:parsed.status==='passed'&&parsed.success===true,
         finished:parsed.status==='passed'||parsed.status==='failed'||parsed.status==='busy',
         current:String(parsed.current??''),error:String(parsed.error??'').slice(0,400),
         logTail:redactAgentOutput(String(parsed.logTail??''),this.secrets)};
        await this.finish(c,{success:true,data});
       }catch{
        await this.finish(c,{success:false,message:'Não foi possível validar o estado do job; nenhum teste foi considerado aprovado.'});
       }
      }
     }else if(c.status==='running'&&c.tool==='validar_workspace'){
      const id=this.hostJobs.get(c.id);
      if(!id){await this.finish(c,{success:false,message:'Inicialização não confirmada; não repetir automaticamente.'});continue;}
      const job=await (this.d.jobs??terminalJobManager)().get(id);
      if(job&&job.state!=='running'){
       this.hostJobs.delete(c.id);
       try{
        if(job.state!=='completed'||job.exitCode!==0||job.truncated)throw Error('Inicialização remota não confirmada.');
        const receipt=JSON.parse(job.output);
        if(!receipt||!WORKSPACE_ID.test(receipt.jobId)||receipt.status!=='queued')
         throw Error('Recibo inválido.');
        await this.finish(c,{success:true,accepted:true,jobId:receipt.jobId,status:'queued',
         passed:false,finished:false,message:'Apenas enfileirado. Consulte o resultado antes de considerar os testes aprovados.'});
       }catch{
        await this.finish(c,{success:false,message:'Inicialização não comprovada. Confira a VPS antes de repetir.'});
       }
      }
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
  if(this.account.allows(registered.repository))await this.account.assertAccount();
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
   if(action==='cancel'){
    const jobId=this.hostJobs.get(id);
    if(c.tool!=='solicitar_comando_vps'||c.status!=='running'||!jobId)throw Error('Execução não confirmada; consulte o Terminal VPS.');
    await (this.d.jobs??terminalJobManager)().cancel(jobId);
    return {ok:true,warning:'Interrupção solicitada. Processos remotos desvinculados podem continuar; confira o estado.'};
   }
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
   }else if(c.tool==='validar_workspace'){
    this.workspaceBinding(c);
    workspaceCommand('start',c.project,c.args['perfil']);
    if(!(process.env['PANEL_TERMINAL_SSH_ENABLED']==='1'||this.d.jobs))
     throw Error('Executor SSH não autorizado.');
   }else if(c.tool==='publicar_pull_request'){this.binding(c.project);validatePublication(c.args);}
   else throw Error('Operação não autorizada.');
   if(this.secrets.some(s=>s.length>=16&&JSON.stringify(c.args).includes(s)))throw Error('A proposta contém credencial privada.');
   await this.d.bridge('/tool-calls/'+id+'/claim','POST',input);
   try{
    if(c.tool==='validar_workspace'){
     const command=workspaceCommand('start',c.project,c.args['perfil']);
     const job=await (this.d.jobs??terminalJobManager)().start(command);
     if(!job)throw Error('Terminal ocupado.');
     this.hostJobs.set(id,job.id);
     return {ok:true,status:'starting',passed:false,jobId:null,
      message:'Executor autorizado. Aguardando recibo; nenhum teste foi aprovado ainda.'};
    }
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
