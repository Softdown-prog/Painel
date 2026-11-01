import { Component, Input, OnChanges, OnDestroy, signal } from '@angular/core';
import { validAppSlug } from './apps-policy';
import type { ManagedProjectLink } from './project-release-panel.component';

type Candidate = {revision:string;state:string;health:string};
type Backup = {image:string;state:string};
type Release = {enabled:boolean;slug:string;current:{revision:string|null;state:string};
  candidate:Candidate|null;backup:Backup|null};
type Publication = {enabled:boolean;current:{phase:string}|null};
type Repair = 'restore_backup'|'restart_current';
type Recovery = {enabled:boolean;slug:string;state:'ready'|'recoverable'|'manual_review';
  repair:Repair|null;detail:string;
  slots:{current:string|null;candidate:string|null;backup:string|null}};
type Action = 'promote'|'finalize'|'recovery';
type Pending = {action:Action;slug:string;repository:string;expected:string;candidateSha:string|null;
  repair:Repair|null};
const SHA=/^[a-f0-9]{40}$/i;
const TERMINAL=new Set(['completed','attention','failed']);
const msg=(error:unknown)=>error instanceof Error?error.message:'Erro na consulta de manutenção.';

/**
 * Conservatively gated release maintenance. The backend re-checks ownership
 * and state under its own lock; UI checks mitigate accidental/stale requests.
 */
@Component({selector:'panel-release-maintenance',standalone:true,
  templateUrl:'./release-maintenance.component.html',
  styleUrl:'./release-maintenance.component.css'})
export class ReleaseMaintenanceComponent implements OnChanges, OnDestroy {
  @Input({required:true}) project!:ManagedProjectLink;
  @Input({required:true}) requiredWorkflow='';
  readonly loading=signal(false);
  readonly working=signal(false);
  readonly release=signal<Release|null>(null);
  readonly publication=signal<Publication|null>(null);
  readonly recovery=signal<Recovery|null>(null);
  readonly warning=signal('');
  readonly error=signal('');
  readonly notice=signal('');
  readonly pending=signal<Pending|null>(null);
  readonly typed=signal('');
  private sequence=0;
  private destroyed=false;

  ngOnChanges():void {this.cancel();void this.refresh();}
  ngOnDestroy():void {
    this.destroyed=true;this.sequence++;this.cancel();
    this.release.set(null);this.publication.set(null);this.recovery.set(null);
  }
  private supported():boolean{
    const p=this.project;
    return !!p&&validAppSlug(p.slug)&&p.repository.split('/').length===2&&
      p.workflow==='panel-app-build.yml'&&this.requiredWorkflow==='panel-app-build.yml'&&
      p.services.length===1&&p.services[0]===p.slug&&typeof p.branch==='string'&&p.branch.length>0;
  }
  private async api<T>(path:string,method:'GET'|'POST'='GET',payload?:object):Promise<T>{
    const response=await fetch('/api'+path,{
      method,credentials:'same-origin',cache:'no-store',redirect:'error',
      headers:payload?{'content-type':'application/json',accept:'application/json'}:{accept:'application/json'},
      ...(payload?{body:JSON.stringify(payload)}:{})
    });
    let data:unknown;
    try{data=await response.json();}catch{throw Error('Resposta JSON inválida da API.');}
    if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Resposta inesperada da API.');
    if(!response.ok){
      const serverMessage=(data as {error?:unknown}).error;
      throw Error(response.status===401?'Sessão administrativa expirada.':
        typeof serverMessage==='string'?serverMessage:'HTTP '+response.status);
    }
    return data as T;
  }
  private validRelease(raw:unknown):raw is Release{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;
    const value=raw as Partial<Release>;
    const current=value.current;
    if(value.slug!==this.project.slug||typeof value.enabled!=='boolean'||
      !current||typeof current.state!=='string'||
      !(current.revision===null||typeof current.revision==='string'))return false;
    if(value.candidate!==null&&(!value.candidate||
      typeof value.candidate.revision!=='string'||typeof value.candidate.state!=='string'||
      typeof value.candidate.health!=='string'))return false;
    if(value.backup!==null&&(!value.backup||
      typeof value.backup.image!=='string'||typeof value.backup.state!=='string'))return false;
    return true;
  }
  private validPublication(raw:unknown):raw is Publication{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;
    const p=raw as Partial<Publication>;
    return typeof p.enabled==='boolean'&&
      (p.current===null||(!!p.current&&typeof p.current.phase==='string'));
  }
  private validRecovery(raw:unknown):raw is Recovery{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;
    const r=raw as Partial<Recovery>;
    if(r.slug!==this.project.slug||typeof r.enabled!=='boolean'||
      !['ready','recoverable','manual_review'].includes(r.state??'')||
      !(r.repair===null||r.repair==='restore_backup'||r.repair==='restart_current')||
      typeof r.detail!=='string'||!r.slots)return false;
    return (['current','candidate','backup'] as const).every(key=>
      r.slots?.[key]===null||typeof r.slots?.[key]==='string');
  }
  private safePublication(p:Publication|null):boolean{
    return p?.enabled===true&&(p.current===null||TERMINAL.has(p.current.phase));
  }
  private safePromote(r:Release|null,p:Publication|null,d:Recovery|null):boolean{
    return r?.enabled===true&&r.current.state==='running'&&
      typeof r.current.revision==='string'&&SHA.test(r.current.revision)&&
      !!r.candidate&&r.candidate.state==='running'&&r.candidate.health==='healthy'&&
      SHA.test(r.candidate.revision)&&r.candidate.revision!==r.current.revision&&
      r.backup===null&&d?.enabled===true&&d.state==='ready'&&
      d.slots.current==='running'&&d.slots.candidate==='running'&&d.slots.backup===null&&
      this.safePublication(p);
  }
  private safeFinalize(r:Release|null,p:Publication|null,d:Recovery|null):boolean{
    const target=r?.backup??r?.candidate;
    return r?.enabled===true&&r.current.state==='running'&&
      typeof r.current.revision==='string'&&SHA.test(r.current.revision)&&
      ((r.backup!==null&&r.candidate===null)||(r.backup===null&&r.candidate!==null))&&
      !!target&&target.state!=='running'&&['exited','created','dead'].includes(target.state)&&
      d?.enabled===true&&d.state==='ready'&&d.slots.current==='running'&&
      (r.backup!==null?d.slots.backup===target.state&&d.slots.candidate===null:
        d.slots.candidate===target.state&&d.slots.backup===null)&&
      this.safePublication(p);
  }
  private safeRecovery(d:Recovery|null,p:Publication|null):boolean{
    if(d?.enabled!==true||d.state!=='recoverable'||!this.safePublication(p))return false;
    if(d.repair==='restore_backup')
      return d.slots.current===null&&d.slots.candidate===null&&
        d.slots.backup!==null&&d.slots.backup!=='running';
    if(d.repair==='restart_current')
      return d.slots.current!==null&&d.slots.current!=='running'&&
        d.slots.candidate===null&&d.slots.backup===null;
    return false;
  }
  canPromote():boolean{
    return this.supported()&&!this.loading()&&!this.working()&&
      this.safePromote(this.release(),this.publication(),this.recovery());
  }
  canFinalize():boolean{
    return this.supported()&&!this.loading()&&!this.working()&&
      this.safeFinalize(this.release(),this.publication(),this.recovery());
  }
  canRecovery():boolean{
    return this.supported()&&!this.loading()&&!this.working()&&
      this.safeRecovery(this.recovery(),this.publication());
  }
  private identity(r:Release|null,p:Publication|null,d:Recovery|null):string{
    return JSON.stringify({
      release:r?{enabled:r.enabled,current:r.current,candidate:r.candidate,backup:r.backup}:null,
      publication:p?{enabled:p.enabled,phase:p.current?.phase??null}:null,
      recovery:d?{enabled:d.enabled,state:d.state,repair:d.repair,slots:d.slots}:null
    });
  }
  async refresh():Promise<void>{
    const seq=++this.sequence;
    this.cancel();this.warning.set('');this.error.set('');
    this.release.set(null);this.publication.set(null);this.recovery.set(null);
    if(this.destroyed||!this.supported()){this.loading.set(false);return;}
    this.loading.set(true);
    const slug=encodeURIComponent(this.project.slug);
    const [release,publication,recovery]=await Promise.allSettled([
      this.api<unknown>('/projects/'+slug+'/releases'),
      this.api<unknown>('/projects/'+slug+'/publication'),
      this.api<unknown>('/projects/'+slug+'/releases/recovery')
    ]);
    if(this.destroyed||this.sequence!==seq)return;
    const problems:string[]=[];
    if(release.status==='fulfilled'&&this.validRelease(release.value))this.release.set(release.value);
    else problems.push('releases');
    if(publication.status==='fulfilled'&&this.validPublication(publication.value))this.publication.set(publication.value);
    else problems.push('publicação');
    if(recovery.status==='fulfilled'&&this.validRecovery(recovery.value))this.recovery.set(recovery.value);
    else problems.push('diagnóstico de recuperação');
    if(problems.length)this.warning.set('Consultas não confirmadas: '+problems.join(', ')+'. Ações correspondentes bloqueadas.');
    this.loading.set(false);
  }
  prepare(action:Action):void{
    if(!this.supported()||
      (action==='promote'&&!this.canPromote())||
      (action==='finalize'&&!this.canFinalize())||
      (action==='recovery'&&!this.canRecovery()))return;
    this.pending.set({action,slug:this.project.slug,repository:this.project.repository,
      expected:this.identity(this.release(),this.publication(),this.recovery()),
      candidateSha:action==='promote'?this.release()?.candidate?.revision??null:null,
      repair:action==='recovery'?this.recovery()?.repair??null:null});
    this.typed.set('');this.error.set('');this.notice.set('');
  }
  cancel():void{this.pending.set(null);this.typed.set('');}
  expected():string{
    const job=this.pending();
    if(!job)return '';
    return (job.action==='promote'?'PUBLICAR ':job.action==='finalize'?'DESCARTAR ':'RECUPERAR ')+job.slug;
  }
  async confirm():Promise<void>{
    const job=this.pending();
    if(!job||this.destroyed||this.working()||this.loading()||!this.supported()||
      job.slug!==this.project.slug||job.repository!==this.project.repository||
      this.typed()!==this.expected()||
      (job.action==='promote'&&!this.canPromote())||
      (job.action==='finalize'&&!this.canFinalize())||
      (job.action==='recovery'&&!this.canRecovery()))return;
    this.working.set(true);this.error.set('');this.notice.set('');
    const seq=this.sequence,slug=encodeURIComponent(job.slug);
    let confirmed=false;
    try{
      const [projects,publication,recovery,release]=await Promise.allSettled([
        this.api<{projects?:ManagedProjectLink[];requiredWorkflow?:string}>('/projects'),
        this.api<unknown>('/projects/'+slug+'/publication'),
        this.api<unknown>('/projects/'+slug+'/releases/recovery'),
        this.api<unknown>('/projects/'+slug+'/releases')
      ]);
      if(this.destroyed||seq!==this.sequence)return;
      if(projects.status!=='fulfilled'||!Array.isArray(projects.value.projects)||
        projects.value.requiredWorkflow!=='panel-app-build.yml')throw Error('Vínculo de projeto não confirmado.');
      const live=projects.value.projects.find(p=>p.slug===job.slug&&p.repository===job.repository);
      if(!live||live.workflow!==this.project.workflow||live.branch!==this.project.branch||
        !Array.isArray(live.services)||live.services.length!==1||live.services[0]!==job.slug)
        throw Error('Vínculo, branch ou serviços mudaram; operação bloqueada.');
      const p=publication.status==='fulfilled'&&this.validPublication(publication.value)?publication.value:null;
      const d=recovery.status==='fulfilled'&&this.validRecovery(recovery.value)?recovery.value:null;
      const r=release.status==='fulfilled'&&this.validRelease(release.value)?release.value:null;
      if(job.expected!==this.identity(r,p,d))throw Error('Estado da VPS mudou; consulte novamente antes de confirmar.');
      if((job.action==='promote'&&!this.safePromote(r,p,d))||
        (job.action==='finalize'&&!this.safeFinalize(r,p,d))||
        (job.action==='recovery'&&!this.safeRecovery(d,p)))
        throw Error('Pré-requisitos de segurança não confirmados; operação cancelada.');
      if(job.action==='promote'){
        if(!job.candidateSha||!SHA.test(job.candidateSha))throw Error('SHA da candidata inválido.');
        const response=await this.api<{promoted?:unknown;revision?:unknown}>(
          '/projects/'+slug+'/releases/promote','POST',{expectedRevision:job.candidateSha});
        if(response.promoted!==true||response.revision!==job.candidateSha)
          throw Error('Promoção não confirmada. Confira a VPS antes de tentar novamente.');
        this.notice.set('A API confirmou a promoção. Confira a revisão executada e a disponibilidade do serviço.');
      }else if(job.action==='finalize'){
        const response=await this.api<{finalized?:unknown}>(
          '/projects/'+slug+'/releases/finalize','POST',{confirm:'DELETE_BACKUP'});
        if(response.finalized!==true)throw Error('Descarte não confirmado. Consulte a VPS antes de repetir.');
        this.notice.set('A API confirmou a liberação do slot parado. Esta operação pode eliminar a possibilidade de rollback.');
      }else{
        if(job.repair!==d?.repair||!job.repair)throw Error('Diagnóstico de recuperação mudou.');
        const response=await this.api<{repaired?:unknown;action?:unknown}>(
          '/projects/'+slug+'/releases/recovery','POST',{confirm:'RESTORE_SAFE_STATE'});
        if(response.repaired!==true||response.action!==job.repair)
          throw Error('Recuperação não confirmada. Inspecione o estado antes de repetir.');
        this.notice.set('Recuperação aceita pela API: '+job.repair+'. Confira se a aplicação voltou a executar.');
      }
      confirmed=true;this.cancel();
    }catch(error){
      if(!this.destroyed&&seq===this.sequence){
        this.error.set(msg(error));
        this.cancel();
        this.release.set(null);this.publication.set(null);this.recovery.set(null);
      }
    }finally{this.working.set(false);}
    if(confirmed&&!this.destroyed&&seq===this.sequence)await this.refresh();
  }
}
