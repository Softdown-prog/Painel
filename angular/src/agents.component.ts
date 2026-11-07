import {Component,OnInit,OnDestroy,signal,computed} from '@angular/core';
type Status={enabled:boolean;ready:boolean;active?:boolean;projects:string[];operationsEnabled?:boolean};
type Message={role:'user'|'assistant';text:string;source?:'operation'};
type Model={id:string;label:string;efforts:string[];defaultEffort:string|null;isDefault:boolean};
type QuotaWindow={usedPercent:number|null;windowDurationMins:number|null;resetsAt:number|null};
type Usage={checkedAt:string;quota:{available:boolean;buckets:{id:string;label:string;primary:QuotaWindow|null;secondary:QuotaWindow|null}[]};
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
 readonly catalog=signal<Catalog>({bindings:{},repositories:[]});
 readonly repository=signal('');
 readonly models=signal<Model[]>([]);
 readonly modelsSupported=signal(false);
 readonly configuredModel=signal<string|null>(null);
 readonly configuredEffort=signal<string|null>(null);
 readonly model=signal('');
 readonly effort=signal('');
 readonly titleDraft=signal('');
 readonly historyQuery=signal('');
 readonly visibleThreads=computed(()=>{
  const query=this.historyQuery().trim().toLocaleLowerCase('pt-BR');
  const all=this.threads();
  return query?all.filter(t=>(t.title+' '+t.project).toLocaleLowerCase('pt-BR').includes(query)):all;
 });
 readonly usage=signal<Usage|null>(null);
 readonly metadataError=signal('');
 readonly metadataBusy=signal(false);
 readonly githubCheck=signal<GithubCheck|null>(null);
 readonly githubBusy=signal(false);
 readonly githubError=signal('');
 private polling:ReturnType<typeof setInterval>|null=null;
 private dead=false;
 private fetchInFlight=false;
 async ngOnInit():Promise<void>{
  this.polling=setInterval(()=>{
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
  if(!el.value||this.models().find(m=>m.id===this.model())?.efforts.includes(el.value))
   this.effort.set(el.value);
 }
 async refreshMetadata():Promise<void>{
  if(this.dead||this.metadataBusy()||!this.status()?.ready)return;
  this.metadataBusy.set(true);this.metadataError.set('');
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
    {model:this.model()||null,effort:this.effort()||null});
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
   const response=await this.api<{thread:Thread}>('/threads','POST',{project:this.project(),
    model:this.model()||null,effort:this.effort()||null});
   if(this.dead)return;
   await this.open(response.thread.id);
   const list=await this.api<{threads:ThreadSummary[]}>('/threads');
   if(!this.dead)this.threads.set(list.threads);
  }catch(e){if(!this.dead)this.error.set(this.message(e));}
  finally{this.busy.set(false);}
 }
 async open(id:string):Promise<void>{
  if(this.dead)return;
  try{
   const reply=await this.api<{thread:Thread}>('/threads/'+encodeURIComponent(id));
   if(!this.dead){this.conversation.set(reply.thread);this.project.set(reply.thread.project);
    this.model.set(reply.thread.model??'');this.effort.set(reply.thread.effort??'');
    this.titleDraft.set(reply.thread.title);}
  }catch(e){if(!this.dead)this.error.set(this.message(e));}
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
 async copy(text:string):Promise<void>{try{await navigator.clipboard.writeText(text);}catch{this.error.set('Não foi possível copiar. Selecione a saída para copiar manualmente.');}}
 private message(e:unknown):string{return e instanceof Error?e.message:'Falha de conexão com o Codex.';}
}
