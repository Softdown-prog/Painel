import {Component,ElementRef,OnInit,OnDestroy,ViewChild,computed,signal} from '@angular/core';
import {parseInfraSnapshot,validInfraDraft,type InfraKind,type InfraPlan,type InfraSnapshot,type InfraTopology} from './infrastructure-policy';

type Pending={action:'save'|'delete';id:string;projectSlug:string;fingerprint:string;baseline:string|null;version:string|null};
@Component({selector:'panel-infrastructure',standalone:true,
 templateUrl:'./infrastructure.component.html',styleUrl:'./infrastructure.component.css'})
export class InfrastructureComponent implements OnInit,OnDestroy{
 readonly data=signal<InfraSnapshot|null>(null);
 readonly loading=signal(false);
 readonly working=signal(false);
 readonly error=signal('');
 readonly notice=signal('');
 readonly kind=signal<InfraKind>('mcp');
 readonly projectSlug=signal('');
 readonly name=signal('');
 readonly replicas=signal(1);
 readonly topology=signal<InfraTopology>('single-node');
 readonly editingId=signal<string|null>(null);
 readonly pending=signal<Pending|null>(null);
 readonly confirmation=signal('');
 @ViewChild('infraConfirmInput') private confirmInput?:ElementRef<HTMLInputElement>;
 @ViewChild('infraNameInput') private nameInput?:ElementRef<HTMLInputElement>;
 @ViewChild('infraPrepareButton') private prepareButton?:ElementRef<HTMLButtonElement>;
 private restoreTarget:HTMLElement|null=null;
 private focusTimer:ReturnType<typeof setTimeout>|null=null;
 readonly mcps=computed(()=>(this.data()?.plans??[]).filter(p=>p.kind==='mcp'));
 readonly clusters=computed(()=>(this.data()?.plans??[]).filter(p=>p.kind==='cluster'));
 readonly valid=computed(()=>validInfraDraft(this.data(),this.kind(),this.projectSlug(),
   this.name(),this.replicas(),this.topology(),this.editingId()));
 private destroyed=false;

 ngOnInit():void{void this.refresh();}
 ngOnDestroy():void{
   this.destroyed=true;this.cancel();
   this.data.set(null);this.name.set('');this.projectSlug.set('');
 }
 private scheduleFocus(callback:()=>void):void{
   if(this.focusTimer!==null)clearTimeout(this.focusTimer);
   // The confirmation is created by Angular after its signal update.
   this.focusTimer=setTimeout(()=>{
     this.focusTimer=null;
     if(!this.destroyed)callback();
   },0);
 }
 private focusConfirmation():void{
   this.scheduleFocus(()=>{
     if(this.pending())this.confirmInput?.nativeElement.focus({preventScroll:true});
   });
 }
 private fingerprint():string {
   return JSON.stringify([this.kind(),this.projectSlug(),this.name(),this.replicas(),this.topology(),this.editingId()]);
 }
 private async api<T>(path:string,method:'GET'|'POST'|'PUT'|'DELETE'='GET',payload?:object):Promise<T>{
   const response=await fetch('/api'+path,{
     method,credentials:'same-origin',redirect:'error',cache:'no-store',
     headers:payload?{'content-type':'application/json'}:{accept:'application/json'},
     ...(payload?{body:JSON.stringify(payload)}:{})
   });
   let value:unknown;
   try{value=await response.json();}catch{throw Error('Resposta inválida da API da VPS.');}
   if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Resposta administrativa inválida.');
   if(!response.ok){
     const reason=(value as {error?:unknown}).error;
     throw Error(response.status===401?'Sessão expirada. Faça login novamente.':
       typeof reason==='string'?reason:'Operação recusada (HTTP '+response.status+').');
   }
   return value as T;
 }
 async refresh():Promise<void>{
   if(this.loading()||this.working()||this.destroyed)return;
   this.loading.set(true);this.error.set('');
   try{
     const snapshot=parseInfraSnapshot(await this.api<unknown>('/infrastructure'));
     if(this.destroyed)return;
     this.cancel();
     this.data.set(snapshot);
     if(!snapshot.projects.includes(this.projectSlug()))this.projectSlug.set(snapshot.projects[0]??'');
     if(this.editingId()&&!snapshot.plans.some(p=>p.id===this.editingId()))this.cancelEdit();
   }catch(e){
     if(!this.destroyed){
       this.cancel();this.data.set(null);
       this.error.set(this.message(e));
     }
   }finally{this.loading.set(false);}
 }
 setKind(value:string):void{
   if(this.working())return;
   this.cancel();
   if(value==='mcp'||value==='cluster'){
     this.kind.set(value);this.replicas.set(1);this.topology.set('single-node');
   }
 }
 setProject(value:string):void{
   if(this.working())return;this.cancel();
   if(this.data()?.projects.includes(value))this.projectSlug.set(value);
 }
 setName(value:string):void{if(this.working())return;this.cancel();this.name.set(value);}
 setReplicas(value:string):void{
   if(this.working())return;this.cancel();
   this.replicas.set(Number(value));
 }
 setTopology(value:string):void{
   if(this.working())return;this.cancel();
   if(value==='single-node'||value==='regional')this.topology.set(value);
 }
 edit(plan:InfraPlan):void{
   if(this.working()||this.loading()||!plan.projectLinked)return;
   this.cancel();
   this.editingId.set(plan.id);this.kind.set(plan.kind);this.projectSlug.set(plan.projectSlug);
   this.name.set(plan.name);this.replicas.set(plan.replicas);this.topology.set(plan.topology);
 }
 cancelEdit():void{
   if(this.working())return;
   this.cancel();this.editingId.set(null);this.name.set('');
   this.kind.set('mcp');this.replicas.set(1);this.topology.set('single-node');
 }
 prepare(event:Event):void{
   event.preventDefault();
   if(this.destroyed||this.working()||this.loading()||!this.valid())return;
   const id=this.projectSlug()+'.'+this.kind()+'.'+this.name();
   this.restoreTarget=this.editingId()?this.prepareButton?.nativeElement??null:
     this.nameInput?.nativeElement??null;
   const original=this.editingId()?this.data()?.plans.find(plan=>plan.id===id):null;
   this.pending.set({action:'save',id,projectSlug:this.projectSlug(),
     fingerprint:this.fingerprint(),baseline:original?JSON.stringify(original):null,version:original?.updatedAt??null});
   this.confirmation.set('');this.error.set('');this.notice.set('');
   this.focusConfirmation();
 }
 prepareDelete(plan:InfraPlan,event?:Event):void{
   if(this.destroyed||this.working()||this.loading()||!this.data()?.plans.some(p=>
     p.id===plan.id&&p.projectSlug===plan.projectSlug&&p.kind===plan.kind))return;
   this.cancel();
   this.restoreTarget=event?.currentTarget instanceof HTMLElement?event.currentTarget:null;
   this.pending.set({action:'delete',id:plan.id,projectSlug:plan.projectSlug,fingerprint:'',baseline:JSON.stringify(plan),version:plan.updatedAt});
   this.confirmation.set('');this.error.set('');this.notice.set('');
   this.focusConfirmation();
 }
 cancel(restoreFocus=false):void{
   const source=this.restoreTarget;
   this.pending.set(null);this.confirmation.set('');this.restoreTarget=null;
   if(this.focusTimer!==null)clearTimeout(this.focusTimer);
   this.focusTimer=null;
   if(restoreFocus)this.scheduleFocus(()=>{
     if(!this.pending()&&source?.isConnected&&
       !(source instanceof HTMLButtonElement&&source.disabled)&&
       !(source instanceof HTMLInputElement&&source.disabled))
       source?.focus({preventScroll:true});
   });
 }
 async confirm():Promise<void>{
   const pending=this.pending(),data=this.data();
   if(!pending||!data||this.working()||this.loading()||this.destroyed||
       this.confirmation()!==pending.id)return;
   if(pending.action==='save'&&(!this.valid()||pending.fingerprint!==this.fingerprint()))return;
   if(pending.action==='delete'&&!pending.version)return;
   if(pending.action==='delete'&&!data.plans.some(p=>
      p.id===pending.id&&p.projectSlug===pending.projectSlug))return;
   const kind=this.kind(),name=this.name(),editingId=this.editingId();
   const payload={projectSlug:this.projectSlug(),replicas:this.replicas(),topology:this.topology(),
     transport:kind==='mcp'?'streamable-http':null};
   this.working.set(true);this.error.set('');this.notice.set('');this.cancel();
   let failure='';
   try{
     // Fail closed if a second admin changed ownership or state while the dialog was open.
     // This client-side check narrows the race; the API remains the final authority.
     const fresh=parseInfraSnapshot(await this.api<unknown>('/infrastructure'));
     if(this.destroyed)return;
     const current=fresh.plans.find(p=>p.id===pending.id);
     if(pending.action==='delete'){
       if(!current||current.projectSlug!==pending.projectSlug||
          JSON.stringify(current)!==pending.baseline)
         throw Error('Cadastro alterado em outra sessão. Revise o inventário antes de remover.');
       const result=await this.api<{ok?:unknown}>('/infrastructure/'+encodeURIComponent(pending.id),'DELETE',
         {projectSlug:pending.projectSlug,confirmId:pending.id,expectedUpdatedAt:pending.version});
       if(this.destroyed)return;
       if(result.ok!==true)throw Error('A exclusão do cadastro não foi confirmada.');
       this.notice.set('Cadastro removido. Nenhum serviço da VPS foi alterado.');
     }else{
       const validDraft=validInfraDraft(fresh,kind,payload.projectSlug,name,
         payload.replicas,payload.topology,editingId);
       if(!validDraft||current&&JSON.stringify(current)!==pending.baseline||
          !current&&pending.baseline!==null)
         throw Error('Cadastro ou vínculo do projeto alterado em outra sessão. Revise antes de salvar.');
       const path=editingId?'/infrastructure/'+encodeURIComponent(pending.id):'/infrastructure';
       const result=await this.api<{plan?:{id?:unknown}}>(path,editingId?'PUT':'POST',
         editingId?{...payload,expectedUpdatedAt:pending.version}:{...payload,kind,name});
       if(this.destroyed)return;
       if(result.plan?.id!==pending.id)throw Error('A API não confirmou a configuração.');
       this.notice.set('Configuração salva; não há serviço provisionado na VPS.');
     }
     this.editingId.set(null);this.name.set('');
   }catch(e){if(!this.destroyed)failure=this.message(e);}
   finally{if(!this.destroyed)this.working.set(false);}
   if(!this.destroyed){
     await this.refresh();
     if(failure)this.error.set(failure+(this.error()?' '+this.error():''));
   }
 }
 private message(error:unknown):string{
   return error instanceof Error?error.message:'Não foi possível acessar a infraestrutura.';
 }
}
