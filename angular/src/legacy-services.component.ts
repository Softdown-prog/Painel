import {Component,OnInit,signal} from '@angular/core';
type ServiceId='app'|'agent'|'caddy';
type Action='start'|'stop'|'restart';
type Service={id:ServiceId;name:string;state:string;status:string;image:string|null;controllable:boolean};
type Pending={id:'app'|'agent';action:Action;name:string};
const IDS=new Set(['app','agent','caddy']);
const ACTIONS=new Set(['start','stop','restart']);
function valid(item:unknown):item is Service{
 if(!item||typeof item!=='object'||Array.isArray(item))return false;
 const v=item as Partial<Service>;
 return typeof v.id==='string'&&IDS.has(v.id)&&typeof v.name==='string'&&
   typeof v.state==='string'&&typeof v.status==='string'&&
   typeof v.controllable==='boolean'&&(v.image===null||typeof v.image==='string');
}
@Component({selector:'panel-legacy-services',standalone:true,
 templateUrl:'./legacy-services.component.html',styleUrl:'./legacy-services.component.css'})
export class LegacyServicesComponent implements OnInit {
 readonly services=signal<Service[]>([]);
 readonly selected=signal<ServiceId|null>(null);
 readonly logs=signal('');
 readonly loading=signal(false);
 readonly logsLoading=signal(false);
 readonly working=signal(false);
 readonly error=signal('');
 readonly notice=signal('');
 readonly pending=signal<Pending|null>(null);
 readonly typedName=signal('');
 ngOnInit():void{void this.refresh();}
 private async api<T>(path:string,method='GET'):Promise<T>{
  const response=await fetch('/api'+path,{method,credentials:'same-origin',cache:'no-store',
    redirect:'error',headers:{accept:'application/json'}});
  let data:unknown;try{data=await response.json();}catch{throw Error('Resposta inesperada da API.');}
  if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Dados inválidos da API.');
  if(!response.ok){
    const msg=(data as {error?:unknown}).error;
    throw Error(typeof msg==='string'?msg:'API indisponível (HTTP '+response.status+').');
  }
  return data as T;
 }
 async refresh():Promise<void>{
  if(this.loading()||this.working())return;
  this.loading.set(true);this.error.set('');
  try{
   const response=await this.api<{services?:unknown}>('/services');
   if(!Array.isArray(response.services)||!response.services.every(valid))
     throw Error('A API não confirmou o inventário de serviços gerenciáveis.');
   this.services.set(response.services);
   const chosen=this.selected();
   if(chosen&&!response.services.some(s=>s.id===chosen)){this.selected.set(null);this.logs.set('');}
  }catch(e){this.services.set([]);this.error.set(this.msg(e));}
  finally{this.loading.set(false);}
 }
 async openLogs(service:Service):Promise<void>{
   if(this.logsLoading()||this.working()||!this.services().some(s=>s.id===service.id))return;
   const id=service.id;
   this.selected.set(id);this.logs.set('');this.logsLoading.set(true);this.error.set('');
   try{
     const response=await this.api<{lines?:unknown}>('/services/'+id+'/logs?tail=200');
     if(this.selected()===id)this.logs.set(typeof response.lines==='string'&&response.lines?
       response.lines.slice(-100000):'Nenhum registro encontrado.');
   }catch(e){if(this.selected()===id)this.error.set(this.msg(e));}
   finally{this.logsLoading.set(false);}
 }
 closeLogs():void{this.selected.set(null);this.logs.set('');}
 allowed(service:Service):Action[]{
   if(!service.controllable||!['app','agent'].includes(service.id))return [];
   if(service.state==='running')return ['restart','stop'];
   if(service.state==='exited'||service.state==='created')return ['start'];
   return [];
 }
 prepare(service:Service,action:Action):void{
   if(this.working()||this.loading()||!ACTIONS.has(action)||!this.allowed(service).includes(action)||
      !this.services().some(s=>s.id===service.id&&s.name===service.name))return;
   if(service.id!=='app'&&service.id!=='agent')return;
   this.pending.set({id:service.id,action,name:service.name});this.typedName.set('');
   this.error.set('');this.notice.set('');
 }
 cancel():void{this.pending.set(null);this.typedName.set('');}
 async confirm():Promise<void>{
   const job=this.pending();
   if(!job||this.working()||this.loading()||this.typedName()!==job.name)return;
   const service=this.services().find(s=>s.id===job.id&&s.name===job.name);
   if(!service||!this.allowed(service).includes(job.action))return;
   this.working.set(true);this.error.set('');this.notice.set('');
   try{
     const result=await this.api<{ok?:unknown}>('/services/'+job.id+'/'+job.action,'POST');
     if(result.ok!==true)throw Error('A API não confirmou a operação.');
     this.notice.set('Solicitação aceita. Atualize os serviços para conferir o estado real.');
     this.cancel();this.working.set(false);
     await this.refresh();
   }catch(e){this.error.set(this.msg(e));this.cancel();}
   finally{this.working.set(false);}
 }
 private msg(error:unknown):string{return error instanceof Error?error.message:'Operação não confirmada.';}
}
