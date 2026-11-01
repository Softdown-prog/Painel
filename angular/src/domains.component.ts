import {Component, ElementRef, OnDestroy, OnInit, ViewChild, computed, signal} from '@angular/core';

type Route={slug:string;host:string;port:number;createdAt:string};
type Publication={state:'reserved'|'dns_ready'|'certificate_pending'|'published'|'failed';updatedAt:string;message?:string};
type Domains={enabled:boolean;publicationEnabled:boolean;zone:string|null;network:string;routes:Route[];publications:Record<string,Publication>};
type App={slug:string;image:string;network:string};
type Pending={operation:'reserve'|'publish'|'remove';slug:string;host:string;port?:number};
const SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATES=new Set(['reserved','dns_ready','certificate_pending','published','failed']);
function validDomains(data:unknown):data is Domains{
  if(!data||typeof data!=='object'||Array.isArray(data))return false;
  const d=data as Partial<Domains>;
  return typeof d.enabled==='boolean' && typeof d.publicationEnabled==='boolean' &&
    (d.zone===null||typeof d.zone==='string') && typeof d.network==='string' &&
    Array.isArray(d.routes) && d.routes.every(route=>route&&SLUG.test(route.slug)&&
      typeof route.host==='string'&&Number.isSafeInteger(route.port)&&route.port>=1024&&route.port<=65535) &&
    !!d.publications&&typeof d.publications==='object'&&!Array.isArray(d.publications) &&
    Object.values(d.publications).every(p=>p&&STATES.has(p.state));
}
@Component({selector:'panel-domains',standalone:true,
 templateUrl:'./domains.component.html',styleUrl:'./domains.component.css'})
export class DomainsComponent implements OnInit,OnDestroy{
 readonly data=signal<Domains|null>(null);
 readonly apps=signal<App[]>([]);
 readonly caddy=signal('');
 readonly loading=signal(false);
 readonly working=signal(false);
 readonly error=signal('');
 readonly notice=signal('');
 readonly selected=signal('');
 readonly port=signal(3000);
 readonly pending=signal<Pending|null>(null);
 readonly confirmation=signal('');
 readonly showCaddy=signal(false);
 @ViewChild('domainConfirmInput') private confirmInput?:ElementRef<HTMLInputElement>;
 private restoreTarget:HTMLElement|null=null;
 private focusTimer:ReturnType<typeof setTimeout>|null=null;
 private destroyed=false;
 readonly eligible=computed(()=>{
   const d=this.data();if(!d)return [];
   return this.apps().filter(app=>app.network===d.network&&
      !d.routes.some(route=>route.slug===app.slug));
 });
 readonly ready=computed(()=>{
   const d=this.data(),app=this.selected();
   return !!d?.enabled && this.eligible().some(a=>a.slug===app) &&
     Number.isSafeInteger(this.port()) && this.port()>=1024&&this.port()<=65535;
 });
 readonly stateNames:Record<Publication['state'],string>={
   reserved:'Reservado · não publicado',dns_ready:'DNS configurado · HTTPS em andamento',
   certificate_pending:'Certificado HTTPS pendente',published:'HTTPS confirmado na publicação',
   failed:'Publicação com falha'
 };
 ngOnInit():void{void this.refresh();}
 ngOnDestroy():void{
   this.destroyed=true;
   if(this.focusTimer!==null)clearTimeout(this.focusTimer);
   this.focusTimer=null;this.restoreTarget=null;
   this.pending.set(null);this.confirmation.set('');
 }
 private scheduleFocus(callback:()=>void):void{
   if(this.focusTimer!==null)clearTimeout(this.focusTimer);
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
 private async api<T>(path:string,method='GET',body?:object):Promise<T>{
   const response=await fetch('/api'+path,{
     method,credentials:'same-origin',redirect:'error',cache:'no-store',
     headers:body?{'content-type':'application/json'}:{accept:'application/json'},
     ...(body?{body:JSON.stringify(body)}:{})});
   let result:unknown;
   try{result=await response.json();}catch{throw Error('Resposta JSON inválida da API.');}
   if(!result||typeof result!=='object'||Array.isArray(result))throw Error('A API retornou dados inválidos.');
   if(!response.ok){
     const error=(result as {error?:unknown}).error;
     throw Error(typeof error==='string'?error:'HTTP '+response.status);
   }
   return result as T;
 }
 async refresh():Promise<void>{
   if(this.destroyed||this.loading()||this.working())return;
   this.loading.set(true);this.error.set('');
   try{
     const [routes,apps,caddy]=await Promise.all([
       this.api<unknown>('/domains'),this.api<{applications?:App[]}>('/apps'),
       this.api<{content?:unknown}>('/domains/caddy')
     ]);
     if(this.destroyed)return;
     if(!validDomains(routes)||!Array.isArray(apps.applications)||
       !apps.applications.every(a=>a&&typeof a.slug==='string'&&typeof a.network==='string'&&typeof a.image==='string')||
       typeof caddy.content!=='string')throw Error('O inventário de domínios está incompleto.');
     this.data.set(routes);this.apps.set(apps.applications);this.caddy.set(caddy.content);
     const choices=apps.applications.filter(a=>a.network===routes.network&&
       !routes.routes.some(r=>r.slug===a.slug));
     if(!choices.some(a=>a.slug===this.selected()))this.selected.set(choices[0]?.slug??'');
     this.cancel();
   }catch(e){
     if(!this.destroyed){
       this.data.set(null);this.apps.set([]);this.caddy.set('');this.cancel();
       this.error.set(e instanceof Error?e.message:'Consulta de domínios indisponível.');
     }
   }finally{if(!this.destroyed)this.loading.set(false);}
 }
 publication(route:Route):Publication{
   return this.data()?.publications[route.slug]??{state:'reserved',updatedAt:'',message:'Nenhuma publicação confirmada.'};
 }
 prepareReserve(event:Event):void{
   event.preventDefault();
   if(this.destroyed||!this.ready()||this.working()||this.loading()||!this.data()?.zone)return;
   this.error.set('');this.notice.set('');
   this.restoreTarget=document.activeElement instanceof HTMLElement?document.activeElement:null;
   this.pending.set({operation:'reserve',slug:this.selected(),
     host:this.selected()+'.'+this.data()!.zone,port:this.port()});
   this.confirmation.set('');
   this.focusConfirmation();
 }
 prepareRoute(operation:'publish'|'remove',route:Route,event?:Event):void{
   const d=this.data();
   if(this.destroyed||!d||this.working()||this.loading()||!d.routes.some(r=>r.slug===route.slug&&r.host===route.host))return;
   if(operation==='publish'&&!d.publicationEnabled)return;
   if(operation==='remove'&&!d.enabled)return;
   this.error.set('');this.notice.set('');
   this.restoreTarget=event?.currentTarget instanceof HTMLElement?event.currentTarget:null;
   this.pending.set({operation,slug:route.slug,host:route.host});
   this.confirmation.set('');
   this.focusConfirmation();
 }
 cancel(restoreFocus=false):void{
   const source=this.restoreTarget;
   this.pending.set(null);this.confirmation.set('');this.restoreTarget=null;
   if(this.focusTimer!==null)clearTimeout(this.focusTimer);
   this.focusTimer=null;
   if(restoreFocus)this.scheduleFocus(()=>{
     if(!this.pending()&&source?.isConnected&&!('disabled' in source&&source.disabled))source?.focus({preventScroll:true});
   });
 }
 async confirm():Promise<void>{
   const job=this.pending(),d=this.data();
   if(this.destroyed||!job||!d||this.working()||this.loading()||this.confirmation()!==job.slug)return;
   if(job.operation==='reserve' && (!this.ready()||this.selected()!==job.slug||
       this.port()!==job.port||job.host!==job.slug+'.'+d.zone))return;
   if(job.operation!=='reserve' && (!d.routes.some(r=>r.slug===job.slug&&r.host===job.host)||
       (job.operation==='publish'&&!d.publicationEnabled)||(job.operation==='remove'&&!d.enabled)))return;
   this.working.set(true);this.error.set('');this.notice.set('');
   try{
     if(job.operation==='reserve'){
       const response=await this.api<{route?:Route;live?:boolean}>('/domains','POST',{slug:job.slug,port:job.port});
       if(this.destroyed)return;
       if(response.route?.host!==job.host||response.live!==false)
         throw Error('Reserva não confirmada. Consulte os domínios antes de repetir.');
       this.notice.set('Endereço '+job.host+' reservado. Ainda não está publicado.');
     } else if(job.operation==='publish'){
       const result=await this.api<{live?:boolean;publication?:Publication}>('/domains/'+job.slug+'/publish','POST');
       if(this.destroyed)return;
       this.notice.set(result.live===true&&result.publication?.state==='published'
         ? 'HTTPS confirmado para '+job.host+'.' :
           'Solicitação concluída. DNS/HTTPS ainda não confirmado; confira novamente.');
     } else {
       const response=await this.api<{ok?:boolean}>('/domains/'+job.slug,'DELETE');
       if(this.destroyed)return;
       if(response.ok!==true)throw Error('Remoção não confirmada. Consulte o registro.');
       this.notice.set('Endereço removido do cadastro. A aplicação e seus arquivos foram preservados.');
     }
     this.cancel();
     this.working.set(false);
     await this.refresh();
   }catch(e){
     if(!this.destroyed){
       this.error.set(e instanceof Error?e.message:'Operação não confirmada; consulte o registro antes de repetir.');
       this.cancel();
     }
   }finally{if(!this.destroyed)this.working.set(false);}
 }
 date(v:string):string{
   const d=new Date(v);
   return v&&Number.isFinite(d.getTime())?d.toLocaleString('pt-BR'):'Sem data confirmada';
 }
 updatePort(value:string):void{this.port.set(Number(value));this.cancel();}
 updateApp(value:string):void{this.selected.set(value);this.cancel();}
}
