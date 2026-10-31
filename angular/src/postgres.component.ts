import {Component, OnInit, computed, signal} from '@angular/core';

type Database = {name:string;owner:string;sizeBytes:number};
type Role = {name:string;canLogin:boolean;superuser:boolean};
type Security = {hostAuthentication:'trust'|'cert'|'other'|'unknown';provisioningEnabled:boolean;message:string};
type DbStatus = {
  engine:'postgresql';integration:'not_configured'|'connected'|'unavailable';enabled:boolean;
  instance:{version:string}|null;databases:Database[]|null;roles:Role[]|null;
  security:Security;metrics:{databaseCount:number;connections:number;totalBytes:number}|null;
  checkedAt:string;message:string
};
type DbCreated = {ok:true;project:string;database:string;username:string;credentialsStored:boolean;message:string};
const PROJECT=/^[a-z][a-z0-9-]{1,29}$/;
function validStatus(v:unknown):v is DbStatus {
  if(!v||typeof v!=='object'||Array.isArray(v))return false;
  const s=v as Partial<DbStatus>;
  if(s.engine!=='postgresql'||!['not_configured','connected','unavailable'].includes(s.integration??'')||
    typeof s.enabled!=='boolean'||typeof s.checkedAt!=='string'||!Number.isFinite(Date.parse(s.checkedAt)))return false;
  if(s.integration!=='connected')return true;
  return s.enabled===true && typeof s.instance?.version==='string' &&
    Array.isArray(s.databases) && Array.isArray(s.roles) && !!s.metrics &&
    Number.isFinite(s.metrics.databaseCount) && Number.isFinite(s.metrics.connections) &&
    Number.isFinite(s.metrics.totalBytes) && !!s.security &&
    typeof s.security.message==='string' && typeof s.security.provisioningEnabled==='boolean' &&
    ['trust','cert','other','unknown'].includes(s.security.hostAuthentication);
}
@Component({selector:'panel-postgres',standalone:true,
  templateUrl:'./postgres.component.html',styleUrl:'./postgres.component.css'})
export class PostgresComponent implements OnInit {
  readonly status=signal<DbStatus|null>(null);
  readonly loading=signal(false);
  readonly working=signal(false);
  readonly error=signal('');
  readonly notice=signal('');
  readonly project=signal('');
  readonly confirmation=signal('');
  readonly pending=signal(false);
  readonly view=signal<'databases'|'roles'>('databases');
  readonly enabled=computed(()=>{
    const s=this.status();
    return s?.integration==='connected' && s.security?.hostAuthentication==='cert' &&
      s.security?.provisioningEnabled===true;
  });
  readonly validProject=computed(()=>PROJECT.test(this.project()));
  ngOnInit():void {void this.refresh();}
  private async api<T>(path:string,method='GET',body?:object):Promise<T>{
    const response=await fetch('/api'+path,{method,credentials:'same-origin',
      redirect:'error',cache:'no-store',
      headers:body?{'content-type':'application/json'}:{accept:'application/json'},
      ...(body?{body:JSON.stringify(body)}:{})});
    let data:unknown;try{data=await response.json();}catch{throw Error('A API não devolveu JSON válido.');}
    if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Resposta inesperada do PostgreSQL.');
    if(!response.ok){
      const reason=(data as {error?:unknown}).error;
      throw Error(typeof reason==='string'?reason:'Falha HTTP '+response.status);
    }
    return data as T;
  }
  async refresh():Promise<void>{
    if(this.loading()||this.working())return;
    this.loading.set(true);this.error.set('');
    try{
      const status=await this.api<unknown>('/database/status');
      if(!validStatus(status))throw Error('A API informou um estado do banco inválido.');
      this.status.set(status);
      if(status.integration!=='connected'||!status.security?.provisioningEnabled)this.cancel();
    }catch(e){
      this.status.set(null);this.cancel();
      this.error.set(e instanceof Error?e.message:'Não foi possível consultar PostgreSQL.');
    }finally{this.loading.set(false);}
  }
  prepare(event:Event):void{
    event.preventDefault();
    if(this.working()||this.loading()||!this.enabled()||!this.validProject())return;
    this.error.set('');this.notice.set('');this.pending.set(true);this.confirmation.set('');
  }
  cancel():void{this.pending.set(false);this.confirmation.set('');}
  async create():Promise<void>{
    const slug=this.project();
    if(!this.pending()||!this.enabled()||!this.validProject()||this.confirmation()!==slug||
      this.working()||this.loading())return;
    this.working.set(true);this.error.set('');this.notice.set('');
    try{
      const result=await this.api<DbCreated>('/database/projects','POST',{project:slug});
      if(result.ok!==true||result.project!==slug||result.credentialsStored!==true||
        typeof result.database!=='string'||typeof result.username!=='string')
        throw Error('Não foi possível confirmar o provisionamento. Consulte o inventário antes de repetir.');
      this.notice.set('Criado: '+result.database+' · identidade '+result.username+
        '. Certificado de acesso mantido somente na VPS; nenhuma senha foi criada.');
      this.project.set('');this.cancel();
      this.working.set(false);
      await this.refresh();
    }catch(e){
      this.error.set(e instanceof Error?e.message:'Falha no provisionamento. Confira o inventário antes de repetir.');
      this.cancel();
    }finally{this.working.set(false);}
  }
  bytes(value:number|null|undefined):string {
    if(typeof value!=='number'||!Number.isFinite(value)||value<0)return '—';
    if(value<1024)return value.toLocaleString('pt-BR')+' B';
    const units=['KB','MB','GB','TB','PB'];
    let count=value,index=-1;
    do{count/=1024;index++;}while(count>=1024&&index<units.length-1);
    return count.toLocaleString('pt-BR',{maximumFractionDigits:1})+' '+(units[index]??'KB');
  }
  date(value:string|undefined):string{
    if(!value)return 'Sem leitura';
    const d=new Date(value);
    return Number.isFinite(d.getTime())?d.toLocaleString('pt-BR'):'Sem leitura';
  }
}
