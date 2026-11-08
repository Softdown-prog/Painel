import {Component,OnInit,OnDestroy,signal,computed} from '@angular/core';
import {availablePercent,quotaCountdown,type CodexQuotaWindow} from './codex-quota';
type Status={enabled:boolean;ready:boolean;active?:boolean;projects:string[];operationsEnabled?:boolean;
 features?:{modelSelection?:boolean;quotaWindows?:boolean;historySearch?:boolean;accountRepositories?:boolean}};
type Message={role:'user'|'assistant';text:string;source?:'operation'};
type Model={id:string;label:string;efforts:string[];defaultEffort:string|null;isDefault:boolean};
type AccountScope={mode:string;owner:string;active:boolean};
type AccountRepo={fullName:string;branch:string;private:boolean;readOnly:boolean};
type QuotaWindow=CodexQuotaWindow;
type Usage={checkedAt:string;quota:{available:boolean;resetCreditsAvailable?:number|null;ordinaryUsageAllowed?:boolean|null;
 buckets:{id:string;label:string;primary:QuotaWindow|null;secondary:QuotaWindow|null}[]};
 tokens:{available:boolean;lifetimeTokens:number|null;daily:{date:string;tokens:number}[]}};
type ThreadTokens={totalTokens:number|null;inputTokens:number|null;outputTokens:number|null;cachedInputTokens:number|null};
type ThreadSummary={id:string;project:string;title:string;status:string;createdAt?:string|null;updatedAt?:string|null;
 model?:string|null;effort?:string|null;messageCount?:number};
type Action={id:string;fingerprint:string;mode:string;tool:string;status:string;deliveryState?:string;destination?:{repository?:string;branch?:string;host?:string;user?:string};
 args:{command?:string;reason?:string;title?:string;description?:string;baseSha?:string;diff?:string;files?:{path:string;content:string|null}[]};
 result?:{output?:string;exitCode?:number;state?:string;warning?:string}};
type Thread=ThreadSummary&{messages:Message[];reply:string;actions?:Action[];historyTruncated?:boolean;effectiveModel?:string|null;usage?:ThreadTokens|null};
type Catalog={bindings:Record<string,{repository:string;branch:string}>;repositories:{fullName:string;branch:string}[]};
type GithubCheck={enabled:boolean;authenticated:boolean;repositories:{name:string;branch:string;readable:boolean;canPush:boolean}[];
 workspaces:{project:string;repository:string;workspaceAvailable:boolean}[];note:string};
@Component({selector:'panel-agents',standalone:true,
 templateUrl:'./agents.component.html',styleUrl:'./agents.component.css'})
export class AgentsComponent implements OnInit,OnDestroy {
 readonly status=signal<Status|null>(null);
 readonly threads=signal<ThreadSummary[]>([]);
 readonly conversation=signal<Thread|null>(null);
 readonly project=signal('');
 readonly prompt=signal('');
 readonly busy=signal(false);
 readonly loading=signal(false);
 readonly error=signal('');
 readonly copyFeedback=signal('');
 readonly catalog=signal<Catalog>({bindings:{},repositories:[]});
 readonly repository=signal('');
 readonly models=signal<Model[]>([]);
 readonly modelsSupported=signal(false);
 readonly configuredModel=signal<string|null>(null);
 readonly configuredEffort=signal<string|null>(null);
 readonly model=signal('');
 readonly effort=signal('');
 readonly reasoningModel=computed(()=>this.models().find(m=>m.id===(this.model()||this.configuredModel()))??
  (!this.model()?this.models().find(m=>m.isDefault):undefined));
 readonly accountScope=signal<AccountScope|null>(null);
 readonly accountRepos=signal<AccountRepo[]>([]);
 readonly accountRepo=signal('');
 readonly accountQuery=signal('');
 readonly accountBusy=signal(false);
 readonly accountError=signal('');
 readonly accountHasMore=signal(false);
 private accountPage=0;
 readonly filteredAccountRepos=computed(()=>this.accountRepos().filter(r=>r.fullName.toLocaleLowerCase().includes(this.accountQuery().trim().toLocaleLowerCase())));
 readonly titleDraft=signal('');
 readonly historyQuery=signal('');
 readonly visibleThreads=computed(()=>{
  const query=this.historyQuery().trim().toLocaleLowerCase('pt-BR');
  const all=this.threads();
  return query?all.filter(t=>(t.title+' '+t.project).toLocaleLowerCase('pt-BR').includes(query)):all;
 });
 readonly usage=signal<Usage|null>(null);
 readonly clock=signal(Date.now());
 readonly metadataError=signal('');
 readonly metadataBusy=signal(false);
 readonly githubCheck=signal<GithubCheck|null>(null);
 readonly githubBusy=signal(false);
 readonly githubError=signal('');
 private polling:ReturnType<typeof setInterval>|null=null;
 private lastMetadataCheck=0;
 private dead=false;
 private fetchInFlight=false;
 private selectionSequence=0;
 async ngOnInit():Promise<void>{
  this.polling=setInterval(()=>{
   const now=Date.now();
   if(now-this.clock()>=30000)this.clock.set(now);
   if(this.status()?.ready&&now-this.lastMetadataCheck>=60000)void this.refreshMetadata();
   const c=this.conversation();
   if(c&&(c.status==='running'||c.actions?.some(a=>['pending','running','awaiting_output'].includes(a.status)||['pending','delivering'].includes(a.deliveryState??''))))void this.poll();
  },2500);
  await this.refresh();
 }
 ngOnDestroy():void{
  this.dead=true;if(this.polling!==null)clearInterval(this.polling);
  this.polling=null;
 }
 private async api<T>(path:string,method='GET',data?:object):Promise<T>{
  const response=await fetch('/api/agents'+path,{method,
   credentials:'same-origin',cache:'no-store',redirect:'error',
   headers:data?{'content-type':'application/json'}:{accept:'application/json'},
   ...(data?{body:JSON.stringify(data)}:{})});
  let value:unknown;try{value=await response.json();}
  catch{throw Error('A VPS respondeu com dados inválidos.');}
  if(!value||typeof value!=='object'||Array.isArray(value))
   throw Error('Resposta inesperada da API.');
  if(!response.ok){const e=(value as {error?:unknown}).error;
   throw Error(typeof e==='string'?e:'Falha na conexão com os agentes.');}
  return value as T;
 }
 async refresh():Promise<void>{
  if(this.loading()||this.dead)return;
  this.loading.set(true);this.error.set('');
  try{
   const st=await this.api<Status>('/status');
   if(this.dead)return;
   this.status.set(st);
   if(!st.enabled)return;
   if(st.operationsEnabled)this.catalog.set(await this.api<Catalog>('/projects'));
   if(st.features?.accountRepositories)void this.refreshAccount();
   if(st.ready)void this.refreshMetadata();
   const firstProject=st.projects[0];
   if(firstProject&&!st.projects.includes(this.project()))this.project.set(firstProject);
   const result=await this.api<{threads:ThreadSummary[]}>('/threads');
   if(this.dead)return;
   this.threads.set(result.threads);
   if(this.conversation())await this.open(this.conversation()!.id);
   else if(result.threads[0])await this.open(result.threads[0].id);
  }catch(e){if(!this.dead)this.error.set(this.message(e));}
  finally{this.loading.set(false);}
 }
 chooseProject(event:Event):void{
  const el=event.target;
  if(el instanceof HTMLSelectElement&&this.status()?.projects.includes(el.value))
   this.project.set(el.value);
 }
 updatePrompt(event:Event):void{
  const el=event.target;if(el instanceof HTMLTextAreaElement)this.prompt.set(el.value.slice(0,4000));
 }
 setHistoryQuery(event:Event):void{
  const el=event.target;if(el instanceof HTMLInputElement)this.historyQuery.set(el.value.slice(0,80));
 }
 setTitle(event:Event):void{
  const el=event.target;if(el instanceof HTMLInputElement)this.titleDraft.set(el.value.slice(0,80));
 }
 selectModel(event:Event):void{
  const el=event.target;if(!(el instanceof HTMLSelectElement))return;
  if(!el.value||this.models().some(m=>m.id===el.value)){
   this.model.set(el.value);
   this.effort.set('');
  }
 }
 selectEffort(event:Event):void{
  const el=event.target;if(!(el instanceof HTMLSelectElement))return;
  if(!el.value||this.reasoningModel()?.efforts.includes(el.value))
   this.effort.set(el.value);
 }
 private selection():{model:string|null;effort:string|null}{return {
  model:this.model()||(this.effort()?this.reasoningModel()?.id:null)||null,effort:this.effort()||null};}
 effortLabel(value:string):string{return ({none:'Sem raciocínio adicional',minimal:'Mínimo',low:'Baixo',medium:'Médio',high:'Alto',xhigh:'Muito alto',max:'Máximo'} as Record<string,string>)[value]??value;}
 async refreshAccount():Promise<void>{
  if(this.dead||this.accountBusy())return;this.accountBusy.set(true);this.accountError.set('');
  try{const scope=await this.api<AccountScope>('/github');if(this.dead)return;this.accountScope.set(scope);
   if(scope.active)await this.loadAccountPage(1);else this.accountRepos.set([]);
  }catch(e){if(!this.dead)this.accountError.set(this.message(e));}finally{this.accountBusy.set(false);}
 }
 async authorizeAccount():Promise<void>{
  if(this.accountBusy()||this.busy())return;this.accountBusy.set(true);this.accountError.set('');
  try{const scope=await this.api<AccountScope>('/github','POST',{mode:'account'});if(this.dead)return;this.accountScope.set(scope);await this.loadAccountPage(1);
  }catch(e){if(!this.dead)this.accountError.set(this.message(e));}finally{this.accountBusy.set(false);}
 }
 private async loadAccountPage(page:number):Promise<void>{
  const result=await this.api<{repositories:AccountRepo[];hasMore:boolean}>('/github/repositories?page='+page);
  if(this.dead)return;this.accountPage=page;this.accountHasMore.set(result.hasMore);
  const all=page===1?result.repositories:[...this.accountRepos(),...result.repositories];
  this.accountRepos.set([...new Map(all.map(r=>[r.fullName,r])).values()]);
 }
 async moreAccountRepos():Promise<void>{
  if(this.accountBusy())return;this.accountBusy.set(true);
  try{await this.loadAccountPage(this.accountPage+1);}catch(e){if(!this.dead)this.accountError.set(this.message(e));}finally{this.accountBusy.set(false);}
 }
 chooseAccountRepo(event:Event):void{const el=event.target;if(el instanceof HTMLSelectElement)this.accountRepo.set(el.value);}
 searchAccountRepos(event:Event):void{const el=event.target;if(el instanceof HTMLInputElement)this.accountQuery.set(el.value.slice(0,100));}
 async openAccountRepo():Promise<void>{
  if(this.accountBusy()||this.busy()||!this.accountRepo())return;this.busy.set(true);this.accountError.set('');
  try{
   const result=await this.api<{project:string}>('/projects/open','POST',{repository:this.accountRepo()});
   if(this.dead)return;
   for(let i=0;i<12;i++){
    const st=await this.api<Status>('/status');if(this.dead)return;this.status.set(st);
    if(st.ready)break;await new Promise(resolve=>setTimeout(resolve,500));
   }
   this.catalog.set(await this.api<Catalog>('/projects'));this.project.set(result.project);
   this.busy.set(false);await this.create();
  }catch(e){if(!this.dead)this.accountError.set(this.message(e));}finally{this.busy.set(false);}
 }
 async refreshMetadata():Promise<void>{
  if(this.dead||this.metadataBusy()||!this.status()?.ready)return;
  this.metadataBusy.set(true);this.metadataError.set('');this.lastMetadataCheck=Date.now();
  try{
   const result=await this.api<{supported:boolean;models:Model[];configuredModel?:string|null;configuredEffort?:string|null}>('/models');
   if(this.dead)return;
   this.models.set(result.models);this.modelsSupported.set(result.supported);
   this.configuredModel.set(result.configuredModel??null);
   this.configuredEffort.set(result.configuredEffort??null);
  }catch{if(!this.dead)this.metadataError.set('Catálogo de modelos não disponível nesta versão do Codex.');}
  try{
   const result=await this.api<Usage>('/usage');
   if(!this.dead)this.usage.set(result);
  }catch{if(!this.dead){this.usage.set(null);
   this.metadataError.set('Os dados de modelos ou uso da conta estão indisponíveis. O chat continua utilizável.');}}
  finally{this.metadataBusy.set(false);}
 }
 async saveSettings():Promise<void>{
  const t=this.conversation();
  if(!t||this.busy()||t.status==='running'||!this.status()?.ready)return;
  this.busy.set(true);this.error.set('');
  try{
   await this.api('/threads/'+encodeURIComponent(t.id)+'/settings','POST',
    this.selection());
   await this.open(t.id);
  }catch(e){if(!this.dead)this.error.set(this.message(e));}
  finally{this.busy.set(false);}
 }
 async rename():Promise<void>{
  const t=this.conversation(),name=this.titleDraft().trim();
  if(!t||!name||name.length>80||this.busy())return;
  this.busy.set(true);this.error.set('');
  try{
   await this.api('/threads/'+encodeURIComponent(t.id)+'/title','POST',{title:name});
   await this.open(t.id);
   const result=await this.api<{threads:ThreadSummary[]}>('/threads');
   if(!this.dead)this.threads.set(result.threads);
  }catch(e){if(!this.dead)this.error.set(this.message(e));}
  finally{this.busy.set(false);}
 }
 formatNumber(n:number|null|undefined):string{
  return n===null||n===undefined?'Não informado':n.toLocaleString('pt-BR');
 }
 formatTime(epoch:number|null|undefined):string{
  if(!epoch)return 'Não informado';
  return new Date(epoch*1000).toLocaleString('pt-BR');
 }
 remaining(window:QuotaWindow):string{
  const percent=availablePercent(window);
  return percent===null?'Restante não informado':percent+'% disponível';
 }
 resetCountdown(window:QuotaWindow):string{
  return quotaCountdown(window,this.clock());
 }
 formatDate(value:string|null|undefined):string{
  if(!value)return 'Data anterior não registrada';
  const date=new Date(value);return Number.isNaN(date.getTime())?'Não informado':date.toLocaleString('pt-BR');
 }
 windowLabel(window:QuotaWindow):string{
  const mins=window.windowDurationMins;
  if(mins===10080)return 'Janela de 7 dias';
  if(mins===null)return 'Janela sem duração informada';
  if(mins%1440===0)return 'Janela de '+(mins/1440)+' dia(s)';
  if(mins%60===0)return 'Janela de '+(mins/60)+' hora(s)';
  return 'Janela de '+mins+' minuto(s)';
 }
 async create():Promise<void>{
  if(this.busy()||!this.status()?.ready||!this.project())return;
  this.busy.set(true);this.error.set('');
  try{
   const response=await this.api<{thread:Thread}>('/threads','POST',{project:this.project(),...this.selection()});
   if(this.dead)return;
   await this.open(response.thread.id);
   const list=await this.api<{threads:ThreadSummary[]}>('/threads');
   if(!this.dead)this.threads.set(list.threads);
  }catch(e){if(!this.dead)this.error.set(this.message(e));}
  finally{this.busy.set(false);}
 }
 async open(id:string):Promise<void>{
  if(this.dead)return;
  const sequence=++this.selectionSequence;
  try{
   const reply=await this.api<{thread:Thread}>('/threads/'+encodeURIComponent(id));
   if(!this.dead&&sequence===this.selectionSequence){this.conversation.set(reply.thread);this.project.set(reply.thread.project);
    this.model.set(reply.thread.model??'');this.effort.set(reply.thread.effort??'');
    this.titleDraft.set(reply.thread.title);}
  }catch(e){if(!this.dead&&sequence===this.selectionSequence)this.error.set(this.message(e));}
 }
 async poll():Promise<void>{
  const selected=this.conversation();
  if(!selected||this.fetchInFlight||this.dead)return;
  this.fetchInFlight=true;
  try{
   const data=await this.api<{thread:Thread}>('/threads/'+encodeURIComponent(selected.id));
   if(this.dead||this.conversation()?.id!==selected.id)return;
   this.conversation.set(data.thread);
   if(selected.status==='running'&&data.thread.status!=='running'){
    const list=await this.api<{threads:ThreadSummary[]}>('/threads');
    if(!this.dead)this.threads.set(list.threads);
   }
  }catch(e){if(!this.dead)this.error.set(this.message(e));}
  finally{this.fetchInFlight=false;}
 }
 async submit(event:Event):Promise<void>{
  event.preventDefault();
  const t=this.conversation(),text=this.prompt().trim();
  if(!t||!text||text.length>4000||this.busy()||t.status==='running'||!this.status()?.ready)return;
  this.busy.set(true);this.error.set('');
  try{
   await this.api<{ok:boolean}>('/threads/'+encodeURIComponent(t.id)+'/turns',
    'POST',{message:text});
   if(this.dead)return;
   this.prompt.set('');
   await this.open(t.id);
  }catch(e){if(!this.dead)this.error.set(this.message(e));}
  finally{this.busy.set(false);}
 }
 async cancel():Promise<void>{
  const t=this.conversation();if(!t||t.status!=='running'||this.busy())return;
  this.busy.set(true);this.error.set('');
  try{await this.api('/threads/'+encodeURIComponent(t.id)+'/cancel','POST');
   if(!this.dead)await this.poll();
  }catch(e){if(!this.dead)this.error.set(this.message(e));}
  finally{this.busy.set(false);}
 }
 async decide(action:Action,decision:'approve'|'deny'|'release'|'cancel'):Promise<void>{
  if(this.busy()||!this.conversation()?.actions?.some(a=>a.id===action.id&&a.fingerprint===action.fingerprint))return;
  this.busy.set(true);this.error.set('');
  try{await this.api('/actions/'+action.id+'/'+decision,'POST',{fingerprint:action.fingerprint});
   if(!this.dead)await this.poll();
  }catch(e){if(!this.dead)this.error.set(this.message(e));}finally{this.busy.set(false);}
 }
 chooseRepository(event:Event):void{const el=event.target;if(el instanceof HTMLSelectElement)this.repository.set(el.value);}
 async verifyGithub():Promise<void>{
  if(this.dead||this.githubBusy()||!this.status()?.operationsEnabled)return;
  this.githubBusy.set(true);this.githubError.set('');
  try{const result=await this.api<GithubCheck>('/projects/check');
   if(!this.dead)this.githubCheck.set(result);
  }catch{if(!this.dead){this.githubCheck.set(null);
    this.githubError.set('Não foi possível confirmar a conexão do GitHub da VPS.');}}
  finally{this.githubBusy.set(false);}
 }
 async bind():Promise<void>{
  const project=this.project(),repository=this.repository();
  if(this.busy()||!repository||['Geral','AdministracaoVPS'].includes(project))return;
  this.busy.set(true);this.error.set('');
  try{await this.api('/projects','POST',{project,repository});const result=await this.api<Catalog>('/projects');if(!this.dead)this.catalog.set(result);
  }catch(e){if(!this.dead)this.error.set(this.message(e));}finally{this.busy.set(false);}
 }
 async copy(text:string):Promise<void>{
  this.copyFeedback.set('');
  try{await navigator.clipboard.writeText(text);if(!this.dead)this.copyFeedback.set('Texto copiado.');}
  catch{if(!this.dead)this.copyFeedback.set('Não foi possível copiar. Selecione o texto para copiar manualmente.');}
 }
 private message(e:unknown):string{return e instanceof Error?e.message:'Falha de conexão com o Codex.';}
}
