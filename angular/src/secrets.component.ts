import {Component,OnDestroy,OnInit,computed,signal} from '@angular/core';
import {currentSecretIntent,type SecretIntent} from './secrets-confirmation';
type Item={name:string;label:string;category:'sistema'|'aplicacao';installed:boolean;sizeBytes:number;createdAt:string;updatedAt:string};
type Connection={id:string;label:string;configured:boolean;managed:boolean};
type SecretInfo={enabled:boolean;entries:Item[];connections:Connection[];note?:string};
const NAME=/^[a-z][a-z0-9-]{1,47}$/;
const CATEGORIES=['sistema','aplicacao'] as const;

@Component({selector:'panel-secrets',standalone:true,
  templateUrl:'./secrets.component.html',styleUrl:'./secrets.component.css'})
export class SecretsComponent implements OnInit,OnDestroy{
 readonly info=signal<SecretInfo|null>(null);
 readonly loading=signal(false);
 readonly working=signal(false);
 readonly error=signal('');
 readonly notice=signal('');
 readonly name=signal('');
 readonly label=signal('');
 readonly category=signal<'sistema'|'aplicacao'>('sistema');
 readonly value=signal('');
 readonly password=signal('');
 readonly pending=signal<SecretIntent|null>(null);
 readonly typedName=signal('');
 private revision=0;
 private destroyed=false;
 readonly canSave=computed(()=>{
   const n=this.name(),v=this.value();
   return this.info()?.enabled===true&&!this.working()&&!this.loading() &&
     NAME.test(n)&&!n.startsWith('panel-') &&
     this.label().trim().length>=2&&this.label().length<=80 &&
     CATEGORIES.includes(this.category())&&v.length>=4&&
     new TextEncoder().encode(v).length<=8192&&v.trim()===v&&
     !/[\u0000-\u001f\u007f]/.test(v)&&
     this.password().length>0&&this.password().length<=256;
 });
 ngOnInit():void{void this.refresh();}
 ngOnDestroy():void{
   this.destroyed=true;
   this.clearSensitive();
   this.info.set(null);
 }
 private invalidatePrepared():void{
   this.revision++;
   this.pending.set(null);
   this.typedName.set('');
 }
 editName(value:string):void{if(this.working())return;this.invalidatePrepared();this.name.set(value);}
 editLabel(value:string):void{if(this.working())return;this.invalidatePrepared();this.label.set(value);}
 editCategory(value:string):void{
   if(this.working())return;
   this.invalidatePrepared();
   if(value==='sistema'||value==='aplicacao')this.category.set(value);
 }
 editValue(value:string):void{if(this.working())return;this.invalidatePrepared();this.value.set(value);}
 private clearSensitive():void{
   this.invalidatePrepared();
   this.value.set('');this.password.set('');
 }
 private async api<T>(path:string,method='GET',payload?:object):Promise<T>{
   const response=await fetch('/api'+path,{method,credentials:'same-origin',redirect:'error',cache:'no-store',
     headers:payload?{'content-type':'application/json'}:{accept:'application/json'},
     ...(payload?{body:JSON.stringify(payload)}:{})});
   let body:unknown;try{body=await response.json();}catch{throw Error('A API devolveu uma resposta inválida.');}
   if(!body||typeof body!=='object'||Array.isArray(body))throw Error('Resposta inesperada da API.');
   if(!response.ok){
     const reason=(body as {error?:unknown}).error;
     throw Error(typeof reason==='string'?reason:'Erro HTTP '+response.status);
   }
   return body as T;
 }
 async refresh():Promise<void>{
   if(this.loading()||this.working()||this.destroyed)return;
   this.loading.set(true);this.error.set('');
   try{
     const data=await this.api<SecretInfo>('/secrets');
     if(typeof data.enabled!=='boolean'||!Array.isArray(data.entries)||!Array.isArray(data.connections)||
       !data.entries.every(e=>e&&NAME.test(e.name)&&typeof e.label==='string'&&
         (e.category==='sistema'||e.category==='aplicacao')&&typeof e.installed==='boolean')||
       !data.connections.every(c=>c&&typeof c.label==='string'&&typeof c.configured==='boolean'&&typeof c.managed==='boolean'))
       throw Error('Inventário de chaves inválido.');
     if(this.destroyed)return;
     this.invalidatePrepared();
     this.info.set(data);
     if(!data.enabled)this.clearSensitive();
   }catch(e){
     if(!this.destroyed){
       this.info.set(null);this.clearSensitive();
       this.error.set(this.message(e));
     }
   }finally{this.loading.set(false);}
 }
 prepareSave(event:Event):void{
   event.preventDefault();
   if(!this.canSave())return;
   this.error.set('');this.notice.set('');
   const n=this.name();
   this.pending.set({kind:'save',name:n,replacement:this.info()?.entries.some(e=>e.name===n)??false,
     revision:this.revision});
   this.typedName.set('');
 }
 prepareDelete(item:Item):void{
   if(this.loading()||this.working()||this.destroyed||!this.info()?.enabled||
     !this.info()?.entries.some(e=>e.name===item.name))return;
   this.error.set('');this.notice.set('');
   this.clearSensitive();
   this.pending.set({kind:'delete',name:item.name,replacement:false,revision:this.revision});
 }
 cancel():void{this.clearSensitive();}
 async confirm():Promise<void>{
   const action=this.pending();
   if(!action||this.working()||this.loading()||this.destroyed||!this.info()?.enabled||
     this.typedName()!==action.name||!this.password()||this.password().length>256)return;
   if(!currentSecretIntent(action,this.revision,this.info()?.entries??[],this.name())){
     this.invalidatePrepared();
     this.error.set('A operação ou o inventário mudou. Revise e confirme novamente.');
     return;
   }
   if(action.kind==='save'&&!this.canSave())return;
   this.working.set(true);this.error.set('');this.notice.set('');
   try{
     const data=action.kind==='save'
       ?await this.api<{ok:boolean;message:string}>('/secrets','POST',{
          name:action.name,label:this.label().trim(),category:this.category(),value:this.value(),password:this.password()})
       :await this.api<{ok:boolean;message:string}>('/secrets/'+encodeURIComponent(action.name),'DELETE',{
          password:this.password(),confirm:action.name});
     if(this.destroyed)return;
     if(data.ok!==true)throw Error('Operação não confirmada. Consulte o inventário antes de repetir.');
     this.notice.set(typeof data.message==='string'?data.message:'Operação confirmada pela API.');
     this.name.set('');this.label.set('');this.category.set('sistema');
   }catch(e){if(!this.destroyed)this.error.set(this.message(e));}
   finally{
     // Never retain secret or admin password in signals after a write attempt.
     this.clearSensitive();this.working.set(false);
   }
   if(!this.destroyed)await this.refresh();
 }
 date(v:string):string{
   if(!v)return 'Não informado';
   const d=new Date(v);
   return Number.isFinite(d.getTime())?d.toLocaleString('pt-BR'):'Não informado';
 }
 private message(e:unknown):string{return e instanceof Error?e.message:'Falha ao consultar chaves da VPS.';}
}
