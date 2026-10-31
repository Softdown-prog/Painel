import {Component,Input,OnChanges,OnDestroy,computed,signal} from '@angular/core';
import {canOperate,diskMb,validAppDraft,validAppSlug,validSnapshot,
  type AppDraft,type AppsSnapshot,type ManagedApp} from './apps-policy';

type Operation='start'|'stop'|'restart'|'resources'|'idle';
type Pending={operation:Operation;slug:string;name:string;draft:AppDraft};
type Project={slug:string;repository:string};
type Domain={slug:string;host:string};
type Publication={state:string;message?:string};
type DomainSnapshot={routes:Domain[];publications?:Record<string,Publication>};
type Release={enabled:boolean;current?:{revision?:string;image?:string;state?:string}|null;
  candidate?:{revision?:string;state?:string}|null;backup?:{image?:string;state?:string}|null};
const allowedStates=new Set(['reserved','dns_ready','certificate_pending','published','failed']);
const errorMessage=(e:unknown)=>e instanceof Error?e.message:'Falha ao consultar a VPS.';

@Component({selector:'panel-site-detail',standalone:true,
 templateUrl:'./site-detail.component.html',styleUrl:'./site-detail.component.css'})
export class SiteDetailComponent implements OnChanges,OnDestroy {
 @Input({required:true}) slug='';
 readonly snapshot=signal<AppsSnapshot|null>(null);
 readonly app=signal<ManagedApp|null>(null);
 readonly inspectedImage=signal<string|null>(null);
 readonly loading=signal(false);
 readonly working=signal(false);
 readonly logsBusy=signal(false);
 readonly error=signal('');
 readonly notice=signal('');
 readonly logs=signal<string|null>(null);
 readonly draft=signal<AppDraft>({ramMb:256,cpuCores:0.5,idleMinutes:0});
 readonly pending=signal<Pending|null>(null);
 readonly typedName=signal('');
 readonly repository=signal<string|null>(null);
 readonly repositoryStatus=signal<'unavailable'|'none'|'linked'>('unavailable');
 readonly domain=signal<{host:string;state:string;message:string}|null>(null);
 readonly domainStatus=signal<'unavailable'|'none'|'known'>('unavailable');
 readonly release=signal<Release|null>(null);
 readonly releaseStatus=signal<'unavailable'|'not_linked'|'available'>('unavailable');
 readonly canEdit=computed(()=>this.snapshot()?.enabled===true&&!!this.app()&&!this.loading()&&!this.working());
 readonly diskMb=diskMb;
 private sequence=0;

 ngOnChanges():void {
   this.sequence++;
   this.snapshot.set(null);this.app.set(null);this.inspectedImage.set(null);
   this.repository.set(null);this.repositoryStatus.set('unavailable');
   this.domain.set(null);this.domainStatus.set('unavailable');
   this.release.set(null);this.releaseStatus.set('unavailable');
   this.logs.set(null);this.cancel();
   void this.refresh();
 }
 ngOnDestroy():void{this.sequence++;this.cancel();this.logs.set(null);}
 private async request<T>(path:string,method:'GET'|'POST'='GET',payload?:object):Promise<T>{
   const response=await fetch('/api'+path,{
     method,credentials:'same-origin',cache:'no-store',redirect:'error',
     headers:payload?{'content-type':'application/json',accept:'application/json'}:{accept:'application/json'},
     ...(payload?{body:JSON.stringify(payload)}:{})
   });
   let result:unknown;try{result=await response.json();}
   catch{throw Error('A API devolveu uma resposta inválida.');}
   if(!result||typeof result!=='object'||Array.isArray(result))throw Error('Resposta inesperada da VPS.');
   if(!response.ok){
     const detail=(result as {error?:unknown}).error;
     throw Error(response.status===401?'Sessão expirada. Entre novamente.':
       typeof detail==='string'?detail:'Falha HTTP '+response.status);
   }
   return result as T;
 }
 async refresh():Promise<void>{
   const slug=this.slug,seq=++this.sequence;
   if(!validAppSlug(slug)){
     this.error.set('Identificador de aplicação inválido. Volte à lista de Apps.');
     this.loading.set(false);return;
   }
   if(this.working())return;
   this.loading.set(true);this.error.set('');
   try{
     // Fail closed when the slug is no longer in the authenticated, owned Apps inventory.
     const [snapshot,details]=await Promise.all([
       this.request<unknown>('/apps'),
       this.request<unknown>('/apps/'+encodeURIComponent(slug))
     ]);
     if(seq!==this.sequence)return;
     if(!validSnapshot(snapshot))throw Error('Inventário de aplicações inválido.');
     const app=snapshot.applications.find(a=>a.slug===slug);
     if(!app)throw Error('Esta aplicação não pertence ao gerenciador ou não está cadastrada.');
     if(!details||typeof details!=='object'||Array.isArray(details)||
       (details as {slug?:unknown}).slug!==slug)throw Error('A inspeção do container não confirmou sua identidade.');
     const checked=details as {image?:unknown};
     this.snapshot.set(snapshot);this.app.set(app);
     this.inspectedImage.set(typeof checked.image==='string'?checked.image:null);
     this.draft.set({ramMb:app.ramMb,cpuCores:app.cpuCores,idleMinutes:app.idleMinutes});
     this.repositoryStatus.set('unavailable');this.domainStatus.set('unavailable');
     this.releaseStatus.set('unavailable');this.repository.set(null);this.domain.set(null);
     this.release.set(null);this.cancel();
     // Integration failures are independent: never report "not linked" on a failed lookup.
     const [projects,domains]=await Promise.allSettled([
       this.request<{projects?:Project[]}>('/projects'),
       this.request<DomainSnapshot>('/domains')
     ]);
     if(seq!==this.sequence)return;
     if(projects.status==='fulfilled'&&Array.isArray(projects.value.projects)){
       const linked=projects.value.projects.find(p=>p.slug===slug&&typeof p.repository==='string');
       this.repositoryStatus.set(linked?'linked':'none');
       this.repository.set(linked?.repository??null);
       if(linked){
         try{
           const release=await this.request<Release>('/projects/'+encodeURIComponent(slug)+'/releases');
           if(seq!==this.sequence)return;
           if(release&&typeof release.enabled==='boolean'){
             this.release.set(release);this.releaseStatus.set('available');
           }
         }catch{/* Explicitly leave release unavailable; no inferred deployment SHA. */}
       }else this.releaseStatus.set('not_linked');
     }
     if(domains.status==='fulfilled'&&Array.isArray(domains.value.routes)){
       const route=domains.value.routes.find(r=>r.slug===slug&&typeof r.host==='string');
       this.domainStatus.set(route?'known':'none');
       if(route){
         const publication=domains.value.publications?.[slug];
         const state=publication&&allowedStates.has(publication.state)?publication.state:'reserved';
         this.domain.set({host:route.host,state,message:typeof publication?.message==='string'?publication.message:''});
       }
     }
   }catch(e){
     if(seq===this.sequence){this.snapshot.set(null);this.app.set(null);this.error.set(errorMessage(e));}
   }finally{if(seq===this.sequence)this.loading.set(false);}
 }
 updateDraft(field:keyof AppDraft,event:Event):void{
   const value=Number((event.target as HTMLSelectElement).value);
   this.draft.update(d=>({...d,[field]:value}));this.cancel();
 }
 available(operation:Operation):boolean{
   const app=this.app(),snapshot=this.snapshot();
   if(!app||!snapshot?.enabled||this.loading()||this.working())return false;
   if(operation==='resources'||operation==='idle')return validAppDraft(snapshot,this.draft())&&
     (operation==='resources'
       ? this.draft().ramMb!==app.ramMb||this.draft().cpuCores!==app.cpuCores
       : this.draft().idleMinutes!==app.idleMinutes);
   return canOperate(snapshot,app,operation);
 }
 prepare(operation:Operation):void{
   const app=this.app();
   if(!app||!this.available(operation))return;
   this.pending.set({operation,slug:app.slug,name:app.name,draft:{...this.draft()}});
   this.typedName.set('');this.error.set('');this.notice.set('');
 }
 cancel():void{this.pending.set(null);this.typedName.set('');}
 async confirm():Promise<void>{
   const job=this.pending(),app=this.app(),snapshot=this.snapshot();
   if(!job||!app||!snapshot||this.working()||this.loading()||
     job.slug!==this.slug||job.slug!==app.slug||job.name!==app.name||
     this.typedName()!==job.slug||!this.available(job.operation))return;
   if((job.operation==='resources'||job.operation==='idle')&&
      (job.draft.ramMb!==this.draft().ramMb||
       job.draft.cpuCores!==this.draft().cpuCores||
       job.draft.idleMinutes!==this.draft().idleMinutes))return;
   this.working.set(true);this.error.set('');this.notice.set('');
   const seq=this.sequence;
   try{
     let path='/apps/'+encodeURIComponent(job.slug);
     let payload:object|undefined;
     if(job.operation==='resources'){
       path+='/resources';payload={ramMb:job.draft.ramMb,cpuCores:job.draft.cpuCores};
     }else if(job.operation==='idle'){
       path+='/idle';payload={minutes:job.draft.idleMinutes};
     }else path+='/'+job.operation;
     const result=await this.request<{ok?:unknown;slug?:unknown}>(path,'POST',payload);
     if(result.ok!==true||result.slug!==job.slug)
       throw Error('Operação não confirmada; verifique o estado antes de repetir.');
     if(seq!==this.sequence)return;
     this.notice.set('A API confirmou a solicitação. Consulte novamente o estado da VPS.');
     this.cancel();
     this.working.set(false);
     await this.refresh();
   }catch(e){
     if(seq===this.sequence){this.error.set(errorMessage(e));this.cancel();}
   }finally{this.working.set(false);}
 }
 async showLogs():Promise<void>{
   const app=this.app();
   if(!app||this.logsBusy()||this.loading()||this.working())return;
   const slug=app.slug,seq=this.sequence;
   this.logsBusy.set(true);this.error.set('');
   try{
     const data=await this.request<{slug?:unknown;lines?:unknown}>('/apps/'+encodeURIComponent(slug)+'/logs');
     if(seq!==this.sequence)return;
     if(data.slug!==slug||typeof data.lines!=='string')throw Error('Logs não confirmados pela API.');
     this.logs.set(data.lines.slice(-50000)||'Nenhum registro disponível.');
   }catch(e){if(seq===this.sequence)this.error.set(errorMessage(e));}
   finally{this.logsBusy.set(false);}
 }
}
