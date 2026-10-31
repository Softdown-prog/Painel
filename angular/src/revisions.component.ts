import {Component,OnInit,signal} from '@angular/core';

type Entry={slug:string;revision:string;importedAt:string;sizeBytes:number;
  status:'em_uso'|'reserva'|'recente'|'protegida'|'antiga'|'ausente';reason:string};
type History={at:string;source:string;removed:number;failed:number;bytesEstimate:number;message:string};
type Image={id:string;tags:string[];sizeBytes:number;createdAt:string|null;containers:number|null};
type Report={checkedAt:string;enabled:boolean;automatic:boolean;ageDays:number;keepPerApp:number;
 oldCount:number;oldBytesEstimate:number;totalImports:number;entries:Entry[];history:History[];
 hostInventory:{available:boolean;total:number;untagged:number;totalBytesEstimate:number;images:Image[];
 multipleVersionRepositories:{repository:string;versions:number}[]}};
@Component({selector:'panel-revisions',standalone:true,
 templateUrl:'./revisions.component.html',styleUrl:'./revisions.component.css'})
export class RevisionsComponent implements OnInit {
  readonly report=signal<Report|null>(null);
  readonly loading=signal(false);
  readonly working=signal(false);
  readonly error=signal('');
  readonly notice=signal('');
  readonly confirmAction=signal<'cleanup'|'toggle'|null>(null);
  readonly confirmText=signal('');
  readonly showImages=signal(false);
  readonly statusLabel:Record<Entry['status'],string>={
    em_uso:'Em uso',reserva:'Reserva protegida',recente:'Recente',
    protegida:'Protegida',antiga:'Elegível à limpeza',ausente:'Ausente'
  };
  ngOnInit():void{void this.refresh();}
  private async api<T>(path:string,method='GET',data?:object):Promise<T>{
    const response=await fetch('/api'+path,{
      method,credentials:'same-origin',cache:'no-store',redirect:'error',
      headers:data?{'content-type':'application/json'}:{accept:'application/json'},
      body:data?JSON.stringify(data):undefined});
    let result:unknown;try{result=await response.json();}catch{throw Error('A API devolveu JSON inválido.');}
    if(!result||typeof result!=='object'||Array.isArray(result))throw Error('Resposta da API inválida.');
    if(!response.ok){
      const error=(result as {error?:unknown}).error;
      throw Error(typeof error==='string'?error:'Falha HTTP '+response.status);
    }
    return result as T;
  }
  async refresh():Promise<void>{
    if(this.loading()||this.working())return;
    this.loading.set(true);this.error.set('');
    try{
      const response=await this.api<Report>('/maintenance/revisions');
      if(!Array.isArray(response.entries)||!Array.isArray(response.history)||
        !response.hostInventory||!Array.isArray(response.hostInventory.images)||
        typeof response.oldCount!=='number')throw Error('Relatório de revisões incompleto.');
      this.report.set(response);
    }catch(e){this.report.set(null);this.error.set(this.message(e));}
    finally{this.loading.set(false);}
  }
  request(action:'cleanup'|'toggle'):void{
    const r=this.report();
    if(this.working()||!r?.enabled||(action==='cleanup'&&r.oldCount===0))return;
    this.confirmAction.set(action);this.confirmText.set('');this.error.set('');
  }
  cancel():void{this.confirmAction.set(null);this.confirmText.set('');}
  async confirm():Promise<void>{
    const action=this.confirmAction(),r=this.report();
    if(this.working()||!r?.enabled||!action)return;
    if(action==='cleanup'&&this.confirmText()!=='LIMPAR')return;
    this.working.set(true);this.error.set('');this.notice.set('');
    try{
      if(action==='toggle'){
        const outcome=await this.api<{message:string}>('/maintenance/revisions/settings','POST',{automatic:!r.automatic});
        this.notice.set(outcome.message);
      }else{
        const outcome=await this.api<{removed:number;failed:number}>('/maintenance/revisions/cleanup','POST',
          {confirm:'LIMPAR_REVISOES_ANTIGAS'});
        this.notice.set('Limpeza concluída: '+outcome.removed+' removidas, '+outcome.failed+' falhas.');
      }
      this.cancel();
    }catch(e){this.error.set(this.message(e));}
    finally{this.working.set(false);}
    await this.refresh();
  }
  bytes(v:number|null|undefined):string{
    if(typeof v!=='number'||!Number.isFinite(v)||v<0)return '—';
    return v>=1073741824?(v/1073741824).toFixed(2).replace('.',',')+' GB':
      (v/1048576).toFixed(1).replace('.',',')+' MB';
  }
  date(v:string|null|undefined):string{
    if(!v)return '—';
    const d=new Date(v);
    return Number.isNaN(d.getTime())?'—':d.toLocaleString('pt-BR');
  }
  private message(e:unknown):string{return e instanceof Error?e.message:'Não foi possível consultar as revisões.';}
}