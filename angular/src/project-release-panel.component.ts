import { Component, Input, OnChanges, OnDestroy, signal } from '@angular/core';
import { validAppSlug } from './apps-policy';

export type ManagedProjectLink={
  slug:string;repository:string;branch:string|null;workflow:string|null;services:string[];
};
type Release={
  enabled:boolean;slug:string;
  current:{state:string;revision:string|null;image?:string};
  candidate:{revision?:string;state?:string;health?:string}|null;
  backup:{image?:string;state?:string}|null;
};
type ImportState={
  enabled:boolean;job:{status:string;message?:string}|null;
  imported:{revision:string;digest:string;importedAt:string}|null;
};
type Publication={
  enabled:boolean;current:{phase:string;detail:string;runId:number}|null;
};
type Run={
  id:number;sha:string;status:string;conclusion:string|null;createdAt:string;
};
type ConfirmJob={
  action:'build'|'rollback'|'import'|'stage';slug:string;repository:string;
  revision:string|null;backupImage:string|null;runId:number|null;runSha:string|null;
};
const SHA=/^[a-f0-9]{40}$/i;
const DIGEST=/^sha256:[a-f0-9]{64}$/i;
const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TERMINAL=new Set(['completed','attention','failed']);
const message=(error:unknown)=>error instanceof Error?error.message:'Falha na consulta da API.';

/**
 * Front-end only: the backend authenticates the session, checks project ownership
 * and serializes container mutations. Never infer installation from CI success.
 */
@Component({
  selector:'panel-project-release',
  standalone:true,
  templateUrl:'./project-release-panel.component.html',
  styleUrl:'./project-release-panel.component.css'
})
export class ProjectReleasePanelComponent implements OnChanges,OnDestroy {
  @Input({required:true}) project!:ManagedProjectLink;
  @Input({required:true}) buildsEnabled=false;
  @Input({required:true}) requiredWorkflow='';
  readonly release=signal<Release|null>(null);
  readonly image=signal<ImportState|null>(null);
  readonly publication=signal<Publication|null>(null);
  readonly runs=signal<Run[]>([]);
  readonly releaseIssue=signal('');
  readonly imageIssue=signal('');
  readonly publicationIssue=signal('');
  readonly runsIssue=signal('');
  readonly loading=signal(false);
  readonly working=signal(false);
  readonly error=signal('');
  readonly notice=signal('');
  readonly pending=signal<ConfirmJob|null>(null);
  readonly typed=signal('');
  private sequence=0;
  private destroyed=false;
  supported():boolean{return this.ownedProject();}
  canBuild():boolean{
    return this.supported()&&this.buildsEnabled&&!this.working()&&!this.loading();
  }
  canRollback():boolean{
    const r=this.release(),p=this.publication();
    return this.supported()&&!this.working()&&!this.loading()&&
      r?.enabled===true&&r.current.state==='running'&&
      typeof r.current.revision==='string'&&SHA.test(r.current.revision)&&
      !!r.backup&&!r.candidate&&p?.enabled===true&&
      (p.current===null||TERMINAL.has(p.current.phase));
  }
  private finished(run:Run):boolean {
    return Number.isSafeInteger(run.id)&&run.id>0&&SHA.test(run.sha)&&
      run.status==='completed'&&run.conclusion==='success';
  }
  private availablePublication():boolean{
    const p=this.publication();
    return p!==null&&(p.current===null||TERMINAL.has(p.current.phase));
  }
  private availableImport():boolean {
    const i=this.image();
    return i!==null&&i.enabled===true&&
      (i.job===null||i.job.status==='success'||i.job.status==='error');
  }
  private canHandleRun(run:Run):boolean{
    const r=this.release();
    return this.supported()&&!this.working()&&!this.loading()&&this.finished(run)&&
      this.availableImport()&&this.availablePublication()&&
      r?.enabled===true&&r.current.state==='running'&&
      typeof r.current.revision==='string'&&SHA.test(r.current.revision)&&
      !r.candidate&&!r.backup;
  }
  canImport(run:Run):boolean {
    return this.canHandleRun(run)&&
      this.image()?.imported?.revision?.toLowerCase()!==run.sha.toLowerCase();
  }
  canStage(run:Run):boolean {
    const imported=this.image()?.imported;
    return this.canHandleRun(run)&&!!imported&&
      imported.revision.toLowerCase()===run.sha.toLowerCase()&&DIGEST.test(imported.digest);
  }
  private ownedProject():boolean {
    const p=this.project;
    return !!p&&validAppSlug(p.slug)&&REPO.test(p.repository)&&
      p.workflow==='panel-app-build.yml'&&
      this.requiredWorkflow==='panel-app-build.yml'&&
      p.services.length===1&&p.services[0]===p.slug&&
      typeof p.branch==='string'&&p.branch.length>0;
  }
  ngOnChanges():void {
    this.cancel();
    this.release.set(null);this.image.set(null);this.publication.set(null);this.runs.set([]);
    void this.refresh();
  }
  ngOnDestroy():void {
    this.destroyed=true;this.sequence++;
    this.cancel();this.release.set(null);this.image.set(null);
    this.publication.set(null);this.runs.set([]);
  }
  private async api<T>(path:string,method:'GET'|'POST'='GET',payload?:object):Promise<T>{
    const response=await fetch('/api'+path,{
      method,credentials:'same-origin',cache:'no-store',redirect:'error',
      headers:payload?{accept:'application/json','content-type':'application/json'}:{accept:'application/json'},
      ...(payload?{body:JSON.stringify(payload)}:{})
    });
    let data:unknown;
    try {data=await response.json();}
    catch {throw Error('Resposta da API não está em JSON.');}
    if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Resposta inválida da API.');
    if(!response.ok){
      const detail=(data as {error?:unknown}).error;
      throw Error(response.status===401?'Sessão administrativa expirada.':
        typeof detail==='string'?detail:'Falha HTTP '+response.status);
    }
    return data as T;
  }
  private validRelease(raw:unknown):raw is Release {
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;
    const r=raw as Partial<Release>;
    if(r.slug!==this.project.slug||typeof r.enabled!=='boolean'||
      !r.current||typeof r.current.state!=='string'||
      !(r.current.revision===null||typeof r.current.revision==='string'))return false;
    if(r.candidate!==null&&(!r.candidate||typeof r.candidate!=='object'))return false;
    if(r.backup!==null&&(!r.backup||typeof r.backup!=='object'))return false;
    return true;
  }
  private validImage(raw:unknown):raw is ImportState {
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;
    const r=raw as Partial<ImportState>;
    return typeof r.enabled==='boolean'&&
      (r.job===null||(!!r.job&&typeof r.job.status==='string'))&&
      (r.imported===null||(!!r.imported&&typeof r.imported.revision==='string'&&
        typeof r.imported.digest==='string'));
  }
  private validPublication(raw:unknown):raw is Publication {
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;
    const p=raw as Partial<Publication>;
    return typeof p.enabled==='boolean'&&
      (p.current===null||(!!p.current&&typeof p.current.phase==='string'&&
        typeof p.current.detail==='string'&&Number.isSafeInteger(p.current.runId)));
  }
  async refresh():Promise<void>{
    const seq=++this.sequence;
    this.release.set(null);this.image.set(null);this.publication.set(null);this.runs.set([]);
    this.releaseIssue.set('');this.imageIssue.set('');this.publicationIssue.set('');this.runsIssue.set('');
    this.error.set('');
    if(this.destroyed||!this.supported()){
      this.loading.set(false);return;
    }
    this.loading.set(true);
    const slug=encodeURIComponent(this.project.slug);
    const [release,image,publication,runs]=await Promise.allSettled([
      this.api<unknown>('/projects/'+slug+'/releases'),
      this.api<unknown>('/projects/'+slug+'/images/import'),
      this.api<unknown>('/projects/'+slug+'/publication'),
      this.api<{slug?:string;runs?:unknown}>('/projects/'+slug+'/runs')
    ]);
    if(this.destroyed||seq!==this.sequence)return;
    if(release.status==='fulfilled'&&this.validRelease(release.value))this.release.set(release.value);
    else this.releaseIssue.set('Estado de releases não confirmado pela API.');
    if(image.status==='fulfilled'&&this.validImage(image.value))this.image.set(image.value);
    else this.imageIssue.set('Importação GHCR não verificada.');
    if(publication.status==='fulfilled'&&this.validPublication(publication.value))
      this.publication.set(publication.value);
    else this.publicationIssue.set('Publicação persistente não verificada.');
    if(runs.status==='fulfilled'&&runs.value.slug===this.project.slug&&Array.isArray(runs.value.runs)){
      const valid=runs.value.runs.filter((item:unknown):item is Run=>{
        if(!item||typeof item!=='object'||Array.isArray(item))return false;
        const r=item as Partial<Run>;
        return Number.isSafeInteger(r.id)&&Number(r.id)>0&&typeof r.sha==='string'&&
          SHA.test(r.sha)&&typeof r.status==='string'&&typeof r.createdAt==='string';
      });
      this.runs.set(valid.slice(0,8));
    }else this.runsIssue.set('Builds GitHub indisponíveis nesta consulta.');
    this.loading.set(false);
  }
  prepare(action:'build'|'rollback'):void {
    if(action==='build'&&!this.canBuild()||action==='rollback'&&!this.canRollback())return;
    const r=this.release(),p=this.project;
    this.pending.set({
      action,slug:p.slug,repository:p.repository,
      revision:r?.current.revision??null,backupImage:r?.backup?.image??null,
      runId:null,runSha:null
    });
    this.typed.set('');
    this.error.set('');this.notice.set('');
  }
  prepareRun(action:'import'|'stage',runId:number):void{
    const run=this.runs().find(item=>item.id===runId);
    if(!run||(action==='import'?!this.canImport(run):!this.canStage(run)))return;
    this.pending.set({action,slug:this.project.slug,repository:this.project.repository,
      revision:this.release()?.current.revision??null,backupImage:null,
      runId:run.id,runSha:run.sha});
    this.typed.set('');this.error.set('');this.notice.set('');
  }
  cancel():void{this.pending.set(null);this.typed.set('');}
  expected():string {
    const job=this.pending();
    if(!job)return '';
    if(job.action==='rollback')return 'RESTAURAR '+job.slug;
    if(job.action==='import')return 'IMPORTAR '+job.slug;
    if(job.action==='stage')return 'PREPARAR '+job.slug;
    return job.slug;
  }
  async confirm():Promise<void>{
    const job=this.pending(),project=this.project;
    if(job?.action==='import'||job?.action==='stage'){
      await this.confirmRun(job);return;
    }
    if(!job||this.working()||this.loading()||
      job.slug!==project.slug||job.repository!==project.repository||
      this.typed()!==this.expected()||
      (job.action==='build'&&!this.canBuild())||
      (job.action==='rollback'&&!this.canRollback()))return;
    this.working.set(true);this.error.set('');
    const seq=this.sequence;
    let accepted=false;
    try {
      // Never trust a stale Angular screen for a VPS/GitHub mutation.
      const data=await this.api<{projects?:ManagedProjectLink[];buildsEnabled?:boolean;requiredWorkflow?:string}>('/projects');
      if(this.destroyed||seq!==this.sequence)return;
      const live=Array.isArray(data.projects)?
        data.projects.find(p=>p.slug===job.slug&&p.repository===job.repository):null;
      if(!live||live.branch!==project.branch||live.workflow!==project.workflow||
         !Array.isArray(live.services)||live.services.length!==1||
         live.services[0]!==job.slug||data.requiredWorkflow!=='panel-app-build.yml')
        throw Error('Vínculo ou workflow do projeto mudou. Reabra a consulta antes de continuar.');
      if(job.action==='build'){
        if(data.buildsEnabled!==true)throw Error('Builds estão desabilitados na API.');
        const response=await this.api<{accepted?:boolean;slug?:string;repository?:string}>(
          '/projects/'+encodeURIComponent(job.slug)+'/build','POST');
        if(response.accepted!==true||response.slug!==job.slug||response.repository!==job.repository)
          throw Error('O GitHub não confirmou o recebimento do build.');
        this.notice.set('Build solicitado ao GitHub. Nenhum container foi substituído; consulte o histórico.');
      }else{
        // Must reconfirm current revision, backup and publication state before rollback.
        const [fresh,publication]=await Promise.all([
          this.api<unknown>('/projects/'+encodeURIComponent(job.slug)+'/releases'),
          this.api<unknown>('/projects/'+encodeURIComponent(job.slug)+'/publication')
        ]);
        if(this.destroyed||seq!==this.sequence)return;
        if(!this.validRelease(fresh)||fresh.enabled!==true||
           fresh.current.state!=='running'||fresh.current.revision!==job.revision||
           !fresh.backup||fresh.backup.image!==job.backupImage||fresh.candidate||
           !this.validPublication(publication)||publication.enabled!==true||
           (publication.current!==null&&!TERMINAL.has(publication.current.phase)))
          throw Error('Estado da versão ou publicação mudou. Rollback cancelado para segurança.');
        const response=await this.api<{rolledBack?:boolean}>(
          '/projects/'+encodeURIComponent(job.slug)+'/releases/rollback','POST');
        if(response.rolledBack!==true)throw Error('Rollback não confirmado; consulte o estado antes de repetir.');
        this.notice.set('Rollback confirmado pela API. Consulte novamente a versão realmente em execução.');
      }
      accepted=true;
      this.cancel();
    }catch(e){if(!this.destroyed&&seq===this.sequence)this.error.set(message(e));}
    finally{this.working.set(false);}
    if(accepted&&!this.destroyed&&seq===this.sequence)await this.refresh();
  }
  private async confirmRun(job:ConfirmJob):Promise<void>{
    if((job.action!=='import'&&job.action!=='stage')||
      this.working()||this.loading()||this.destroyed||
      job.slug!==this.project.slug||job.repository!==this.project.repository||
      this.typed()!==this.expected()||!Number.isSafeInteger(job.runId)||
      job.runId===null||job.runId<=0||job.runSha===null||!SHA.test(job.runSha))return;
    const selected=this.runs().find(r=>r.id===job.runId&&r.sha===job.runSha);
    if(!selected||(job.action==='import'?!this.canImport(selected):!this.canStage(selected)))return;
    this.working.set(true);this.error.set('');this.notice.set('');
    const seq=this.sequence;
    let accepted=false;
    const slug=encodeURIComponent(job.slug);
    try{
      const [projects,runs,release,image,publication]=await Promise.all([
        this.api<{projects?:ManagedProjectLink[];requiredWorkflow?:string}>('/projects'),
        this.api<{slug?:string;runs?:unknown}>('/projects/'+slug+'/runs'),
        this.api<unknown>('/projects/'+slug+'/releases'),
        this.api<unknown>('/projects/'+slug+'/images/import'),
        this.api<unknown>('/projects/'+slug+'/publication')
      ]);
      if(this.destroyed||seq!==this.sequence)return;
      const linked=Array.isArray(projects.projects)?
        projects.projects.find(p=>p.slug===job.slug&&p.repository===job.repository):null;
      if(!linked||linked.branch!==this.project.branch||
        linked.workflow!=='panel-app-build.yml'||projects.requiredWorkflow!=='panel-app-build.yml'||
        !Array.isArray(linked.services)||linked.services.length!==1||linked.services[0]!==job.slug)
        throw Error('O vínculo, os serviços ou o workflow mudaram; operação cancelada.');
      if(runs.slug!==job.slug||!Array.isArray(runs.runs))throw Error('Histórico do build não confirmado.');
      const liveRun=runs.runs.find((raw:unknown)=>{
        if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;
        const value=raw as Partial<Run>;
        return value.id===job.runId&&value.sha===job.runSha&&
          value.status==='completed'&&value.conclusion==='success';
      });
      if(!liveRun)throw Error('O build selecionado mudou ou não está aprovado.');
      if(!this.validRelease(release)||release.enabled!==true||
         release.current.state!=='running'||release.current.revision!==job.revision||
         !!release.candidate||!!release.backup||
         !this.validImage(image)||image.enabled!==true||
         (image.job!==null&&!['success','error'].includes(image.job.status))||
         !this.validPublication(publication)||
         (publication.current!==null&&!TERMINAL.has(publication.current.phase)))
        throw Error('Estado GHCR, publicação ou containers mudou; operação cancelada.');
      if(job.action==='stage'&&
         (image.imported?.revision?.toLowerCase()!==job.runSha.toLowerCase()||
          !image.imported||!DIGEST.test(image.imported.digest)))
        throw Error('A imagem desta revisão não está importada com digest confirmado.');
      if(job.action==='import'){
        const acceptedImport=await this.api<{accepted?:unknown;revision?:unknown;digest?:unknown}>(
          '/projects/'+slug+'/images/import','POST',{runId:job.runId});
        if(acceptedImport.accepted!==true||acceptedImport.revision!==job.runSha||
          typeof acceptedImport.digest!=='string'||!DIGEST.test(acceptedImport.digest))
          throw Error('A importação não foi confirmada; consulte a API antes de repetir.');
        this.notice.set('Importação aceita pela API. Aguarde a verificação do GHCR; nenhuma versão foi publicada.');
      }else{
        const staged=await this.api<{staged?:unknown;revision?:unknown}>(
          '/projects/'+slug+'/releases/stage','POST',{runId:job.runId});
        if(staged.staged!==true||staged.revision!==job.runSha)
          throw Error('Candidata não confirmada; consulte a VPS antes de repetir.');
        this.notice.set('Candidata solicitada. Aguarde HEALTHCHECK; a versão ativa não foi substituída.');
      }
      accepted=true;this.cancel();
    }catch(error){if(!this.destroyed&&seq===this.sequence)this.error.set(message(error));}
    finally{this.working.set(false);}
    if(accepted&&!this.destroyed&&seq===this.sequence)await this.refresh();
  }
  status():string {
    const release=this.release();
    if(!release)return 'Versão atual não confirmada';
    if(release.current.state!=='running')return 'Container não confirmado em execução';
    return typeof release.current.revision==='string'&&SHA.test(release.current.revision)
      ? 'Em execução · '+release.current.revision.slice(0,12)
      : 'Em execução · SHA não identificada';
  }
}
