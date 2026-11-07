import {Component,OnInit,OnDestroy,signal} from '@angular/core';
type Status={enabled:boolean;ready:boolean;active?:boolean;projects:string[]};
type Message={role:'user'|'assistant';text:string};
type ThreadSummary={id:string;project:string;title:string;status:string};
type Thread=ThreadSummary&{messages:Message[];reply:string};
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
 private polling:ReturnType<typeof setInterval>|null=null;
 private dead=false;
 private fetchInFlight=false;
 async ngOnInit():Promise<void>{
  this.polling=setInterval(()=>{
   if(this.conversation()?.status==='running')void this.poll();
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
 async create():Promise<void>{
  if(this.busy()||!this.status()?.ready||!this.project())return;
  this.busy.set(true);this.error.set('');
  try{
   const response=await this.api<{thread:Thread}>('/threads','POST',{project:this.project()});
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
   if(!this.dead)this.conversation.set(reply.thread);
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
 private message(e:unknown):string{return e instanceof Error?e.message:'Falha de conexão com o Codex.';}
}
