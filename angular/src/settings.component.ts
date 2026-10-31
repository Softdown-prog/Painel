import {Component,EventEmitter,OnDestroy,Output,computed,signal} from '@angular/core';
@Component({selector:'panel-settings',standalone:true,templateUrl:'./settings.component.html',styleUrl:'./settings.component.css'})
export class SettingsComponent implements OnDestroy{
 @Output() readonly signedOut=new EventEmitter<void>();
 readonly currentPassword=signal('');
 readonly newPassword=signal('');
 readonly repeatPassword=signal('');
 readonly confirmation=signal('');
 readonly pending=signal(false);
 readonly working=signal(false);
 readonly error=signal('');
 readonly notice=signal('');
 readonly valid=computed(()=>this.currentPassword().length>0&&this.currentPassword().length<=256&&
   this.newPassword().length>=14&&this.newPassword().length<=256&&
   this.newPassword()===this.repeatPassword()&&this.newPassword()!==this.currentPassword());
 ngOnDestroy():void{this.clear();}
 private clear():void{
   this.currentPassword.set('');this.newPassword.set('');this.repeatPassword.set('');
   this.confirmation.set('');this.pending.set(false);
 }
 prepare(event:Event):void{
   event.preventDefault();
   if(this.working()||!this.valid())return;
   this.error.set('');this.notice.set('');this.confirmation.set('');this.pending.set(true);
 }
 cancel():void{this.clear();}
 async save():Promise<void>{
   if(this.working()||!this.pending()||!this.valid()||this.confirmation()!=='ALTERAR SENHA')return;
   this.working.set(true);this.error.set('');
   try{
     const response=await fetch('/api/password',{method:'POST',credentials:'same-origin',
       cache:'no-store',redirect:'error',headers:{'content-type':'application/json'},
       body:JSON.stringify({currentPassword:this.currentPassword(),newPassword:this.newPassword()})});
     let result:unknown;
     try{result=await response.json();}catch{throw Error('Resposta administrativa inválida.');}
     if(!result||typeof result!=='object'||Array.isArray(result))throw Error('Resposta inválida da API.');
     if(!response.ok){
       const message=(result as {error?:unknown}).error;
       throw Error(typeof message==='string'?message:'Falha ao trocar senha (HTTP '+response.status+').');
     }
     if((result as {ok?:unknown}).ok!==true)throw Error('Alteração não confirmada pelo servidor.');
     this.clear();
     this.notice.set('Senha alterada. As sessões anteriores foram encerradas. Faça login novamente.');
     this.signedOut.emit();
   }catch(e){
     this.error.set(e instanceof Error?e.message:'Não foi possível confirmar a mudança.');
     this.clear();
   }finally{this.working.set(false);}
 }
}