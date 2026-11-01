import { Component, EventEmitter, Input, OnChanges, OnDestroy, OnInit, Output, signal } from '@angular/core';
import { validAppSlug, validSnapshot, type AppsSnapshot, type ManagedApp } from './apps-policy';

export type LinkedRepo={fullName:string;branch:string;workflow:string};
export type LinkedProject={slug:string;repository:string;branch:string|null;workflow:string|null;services:string[]};
type Mode='create'|'edit'|'unlink';
const REPO=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const same=(a:string[],b:string[]):boolean=>a.length===b.length&&a.every((v,i)=>v===b[i]);
const failure=(error:unknown):string=>error instanceof Error?error.message:'Falha ao gerenciar vínculo do projeto.';

/** Frontend binding controls only; Docker ownership and project isolation are enforced by the API. */
@Component({selector:'panel-project-bindings',standalone:true,
  templateUrl:'./project-bindings.component.html',styleUrl:'./project-bindings.component.css'})
export class ProjectBindingsComponent implements OnInit,OnChanges,OnDestroy{
  @Input({required:true}) projects:LinkedProject[]=[];
  @Input({required:true}) repositories:LinkedRepo[]=[];
  @Input({required:true}) ready=false;
  @Output() readonly changed=new EventEmitter<void>();

  readonly inventory=signal<AppsSnapshot|null>(null);
  readonly inventoryLoading=signal(false);
  readonly inventoryIssue=signal('');
  readonly mode=signal<Mode|null>(null);
  readonly appSlug=signal('');
  readonly repoName=signal('');
  readonly services=signal<string[]>([]);
  readonly baseline=signal<LinkedProject|null>(null);
  readonly typed=signal('');
  readonly working=signal(false);
  readonly error=signal('');
  readonly notice=signal('');
  private destroyed=false;
  private inventoryToken=0;

  ngOnInit():void{void this.refreshApps();}
  ngOnDestroy():void{
    this.destroyed=true;this.inventoryToken++;
    this.reset();this.inventory.set(null);
  }
  ngOnChanges():void{
    const old=this.baseline();
    if(!old)return;
    const current=this.projects.find(p=>p.slug===old.slug);
    if(!this.ready||!current||current.repository!==old.repository||
       !same(current.services,old.services))this.reset();
  }
  private async api<T>(path:string,method:'GET'|'POST'|'PUT'|'DELETE'='GET',data?:object):Promise<T>{
    const response=await fetch('/api'+path,{
      method,credentials:'same-origin',cache:'no-store',redirect:'error',
      headers:data?{accept:'application/json','content-type':'application/json'}:{accept:'application/json'},
      ...(data?{body:JSON.stringify(data)}:{})
    });
    let json:unknown;
    try{json=await response.json();}catch{throw Error('A API não retornou JSON.');}
    if(!json||typeof json!=='object'||Array.isArray(json))throw Error('Resposta inesperada da API.');
    if(!response.ok){
      const detail=(json as {error?:unknown}).error;
      throw Error(response.status===401?'Sessão administrativa expirada.':
        typeof detail==='string'?detail:'Falha HTTP '+response.status);
    }
    return json as T;
  }
  async refreshApps():Promise<void>{
    const token=++this.inventoryToken;
    if(this.destroyed||this.working())return;
    this.inventoryLoading.set(true);this.inventoryIssue.set('');
    try{
      const value=await this.api<unknown>('/apps');
      if(this.destroyed||token!==this.inventoryToken)return;
      if(!validSnapshot(value))throw Error('Inventário de aplicações inválido.');
      this.inventory.set(value);
    }catch(error){
      if(!this.destroyed&&token===this.inventoryToken){
        this.inventory.set(null);this.inventoryIssue.set(failure(error));
      }
    }finally{if(!this.destroyed&&token===this.inventoryToken)this.inventoryLoading.set(false);}
  }
  apps():ManagedApp[]{return this.inventory()?.applications??[];}
  availableNewApps():ManagedApp[]{
    return this.apps().filter(a=>!this.projects.some(p=>p.slug===a.slug)&&
      !this.projects.some(p=>p.services.includes(a.slug)));
  }
  possibleServices():ManagedApp[]{
    const selected=this.appSlug();
    return this.apps().filter(a=>a.slug===selected||
      !this.projects.some(p=>p.slug!==selected&&p.services.includes(a.slug)));
  }
  private connectedRepo(repository:string):boolean{
    return REPO.test(repository)&&this.repositories.some(r=>r.fullName===repository);
  }
  beginCreate():void{
    if(this.working()||!this.ready||this.inventoryLoading()||this.inventory()?.enabled!==true||
      this.projects.length>=8||!this.availableNewApps().length||!this.repositories.length)return;
    this.reset();this.error.set('');this.notice.set('');
    this.mode.set('create');this.selectApp(this.availableNewApps()[0]?.slug??'');
    this.repoName.set(this.repositories[0]?.fullName??'');
  }
  beginExisting(mode:'edit'|'unlink',slug:string):void{
    if(this.working()||!this.ready)return;
    const p=this.projects.find(x=>x.slug===slug);
    if(!p||!validAppSlug(p.slug)||!REPO.test(p.repository))return;
    if(mode==='edit'&&(this.inventory()?.enabled!==true||
      !p.services.includes(p.slug)||!p.services.every(s=>this.apps().some(a=>a.slug===s))))
      return;
    this.reset();this.error.set('');this.notice.set('');
    this.mode.set(mode);this.baseline.set({...p,services:[...p.services]});
    this.appSlug.set(p.slug);this.repoName.set(p.repository);this.services.set([...p.services]);
  }
  selectApp(slug:string):void{
    if(this.mode()!=='create'||!this.availableNewApps().some(a=>a.slug===slug))return;
    this.appSlug.set(slug);this.services.set([slug]);this.typed.set('');
  }
  selectRepo(repo:string):void{
    if(this.mode()!=='create'||!this.connectedRepo(repo))return;
    this.repoName.set(repo);this.typed.set('');
  }
  toggleService(slug:string,checked:boolean):void{
    if(!['create','edit'].includes(this.mode()??'')||this.working()||slug===this.appSlug()||
      !this.possibleServices().some(a=>a.slug===slug))return;
    const old=this.services();
    if(checked){if(old.includes(slug)||old.length>=8)return;this.services.set([...old,slug]);}
    else this.services.set(old.filter(x=>x!==slug));
    this.typed.set('');
  }
  reset():void{
    this.mode.set(null);this.baseline.set(null);this.typed.set('');
    this.appSlug.set('');this.repoName.set('');this.services.set([]);
  }
  expected():string{
    const mode=this.mode(),slug=this.appSlug();
    if(!mode)return '';
    return (mode==='create'?'VINCULAR ':mode==='edit'?'SERVICOS ':'DESVINCULAR ')+slug;
  }
  canSubmit():boolean{
    const mode=this.mode(),slug=this.appSlug(),baseline=this.baseline();
    if(!this.ready||this.working()||this.inventoryLoading()||!mode||!validAppSlug(slug))return false;
    if(mode==='unlink')return !!baseline&&baseline.slug===slug&&
      this.projects.some(p=>p.slug===slug&&p.repository===baseline.repository&&same(p.services,baseline.services));
    if(this.inventory()?.enabled!==true||!this.apps().some(a=>a.slug===slug))return false;
    const list=this.services();
    if(list.length<1||list.length>8||!list.includes(slug)||new Set(list).size!==list.length||
      !list.every(s=>this.possibleServices().some(a=>a.slug===s)))return false;
    if(mode==='create')return this.projects.length<8&&
      this.availableNewApps().some(a=>a.slug===slug)&&this.connectedRepo(this.repoName());
    return !!baseline&&this.projects.some(p=>p.slug===baseline.slug&&
      p.repository===baseline.repository&&same(p.services,baseline.services))&&
      !same(list,baseline.services);
  }
  private validProjects(value:unknown):value is LinkedProject[]{
    return Array.isArray(value)&&value.length<=8&&value.every(item=>
      !!item&&typeof item==='object'&&
      typeof item.slug==='string'&&validAppSlug(item.slug)&&
      typeof item.repository==='string'&&REPO.test(item.repository)&&
      Array.isArray(item.services)&&item.services.length<=8&&
      item.services.every((s:unknown)=>typeof s==='string'&&validAppSlug(s)));
  }
  async confirm():Promise<void>{
    const mode=this.mode(),slug=this.appSlug(),repo=this.repoName(),
      services=[...this.services()],baseline=this.baseline(),typed=this.typed();
    if(!mode||typed!==this.expected()||!this.canSubmit())return;
    this.working.set(true);this.error.set('');this.notice.set('');
    try{
      const [projectInfo,repos,apps]=await Promise.all([
        this.api<{projects?:unknown}>('/projects'),
        this.api<{repositories?:unknown}>('/repositories'),
        mode==='unlink'?Promise.resolve(null):this.api<unknown>('/apps')
      ]);
      if(this.destroyed)return;
      if(!this.validProjects(projectInfo.projects))throw Error('Vínculos não confirmados pela API.');
      const live=projectInfo.projects;
      const connected=Array.isArray(repos.repositories)&&repos.repositories.some((r:unknown)=>{
        if(!r||typeof r!=='object')return false;
        const obj=r as {fullName?:unknown;branch?:unknown;workflow?:unknown};
        return obj.fullName===repo&&typeof obj.branch==='string'&&typeof obj.workflow==='string';
      });
      if(mode==='create'&&!connected)throw Error('O repositório não está mais conectado.');
      if(mode!=='create'){
        const old=live.find(p=>p.slug===slug);
        if(!baseline||!old||old.repository!==baseline.repository||
          !same(old.services,baseline.services))
          throw Error('O vínculo ou os serviços mudaram. Reabra a edição.');
      }else if(live.length>=8||live.some(p=>p.slug===slug))
        throw Error('O projeto foi vinculado por outra operação ou atingiu o limite.');
      if(mode!=='unlink'){
        if(!validSnapshot(apps)||!apps.enabled)throw Error('Inventário de aplicações gerenciadas indisponível.');
        if(services.length<1||services.length>8||!services.includes(slug)||
          !services.every(s=>apps.applications.some(a=>a.slug===s))||
          live.some(p=>p.slug!==slug&&services.some(s=>p.services.includes(s))))
          throw Error('Serviços alterados ou vinculados a outro projeto; operação cancelada.');
      }
      if(mode==='create'){
        const response=await this.api<{project?:{slug?:unknown;repository?:unknown;services?:unknown}}>(
          '/projects','POST',{slug,repository:repo,services});
        if(response.project?.slug!==slug||response.project.repository!==repo||
          !Array.isArray(response.project.services)||!same(response.project.services,services))
          throw Error('Vínculo não confirmado; reconsulte antes de repetir.');
        this.notice.set('Aplicação vinculada ao repositório. Nenhum container foi modificado.');
      }else if(mode==='edit'){
        const response=await this.api<{project?:{slug?:unknown;repository?:unknown;services?:unknown}}>(
          '/projects/'+encodeURIComponent(slug)+'/services','PUT',{services});
        if(response.project?.slug!==slug||response.project.repository!==repo||
          !Array.isArray(response.project.services)||!same(response.project.services,services))
          throw Error('Serviços não confirmados; reconsulte antes de repetir.');
        this.notice.set('Serviços associados no registro do painel. Nenhum container foi iniciado ou parado.');
      }else{
        const response=await this.api<{ok?:unknown}>('/projects/'+encodeURIComponent(slug),'DELETE');
        if(response.ok!==true)throw Error('Desvinculação não confirmada. Consulte o servidor.');
        this.notice.set('Vínculo removido. Container e repositório preservados.');
      }
      this.reset();this.changed.emit();
    }catch(error){if(!this.destroyed){this.error.set(failure(error));this.reset();}}
    finally{this.working.set(false);}
  }
}
