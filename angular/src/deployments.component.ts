import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import {
  ciStatus, deliveryStatus, statusIcon, validRun, vpsStatus,
  type ActionJob, type LinkedProject, type PublicationJob, type ReleaseSnapshot,
  type Stage, type WorkflowRun
} from './deployment-status';

type Repository = {fullName:string; branch:string; workflow:string};
type RunRow = {
  key:string; sha:string; shortSha:string; runId:number; name:string; createdAt?:string;
  url:string; ci:Stage; delivery:Stage; vps:Stage;
};
type RepoGroup = {
  name:string; branch:string; slug:string|null; installedRevision:string|null;
  rows:RunRow[]; issue:string|null
};
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA = /^[a-f0-9]{40}$/i;
const INTERVAL_MS = 30000;

@Component({
  selector:'panel-deployments',
  standalone:true,
  templateUrl:'./deployments.component.html',
  styleUrl:'./deployments.component.css'
})
export class DeploymentsComponent implements OnInit, OnDestroy {
  readonly loading=signal(false);
  readonly error=signal('');
  readonly warning=signal('');
  readonly groups=signal<RepoGroup[]>([]);
  readonly checkedAt=signal<string|null>(null);
  readonly configured=signal(false);
  readonly automatic=signal(true);
  readonly expanded=signal<string|null>(null);
  readonly expandedJobs=signal<ActionJob[]>([]);
  readonly jobError=signal('');
  readonly jobLoading=signal(false);
  readonly summary=computed(()=>{
    const rows=this.groups().flatMap(group=>group.rows);
    return {
      running:rows.filter(row=>row.ci.tone==='running').length,
      failed:rows.filter(row=>row.ci.tone==='danger'||row.vps.tone==='danger').length,
      confirmed:rows.filter(row=>row.vps.tone==='success').length,
      tracked:rows.length
    };
  });
  readonly icon=statusIcon;
  private timer:ReturnType<typeof setInterval>|null=null;
  private destroyed=false;

  ngOnInit():void {
    void this.refresh();
    this.timer=setInterval(()=>{
      if(this.automatic() && document.visibilityState==='visible')
        void this.refresh(true);
    },INTERVAL_MS);
  }
  ngOnDestroy():void {
    this.destroyed=true;
    if(this.timer!==null)clearInterval(this.timer);
    this.timer=null;
  }
  toggleAutomatic():void {
    this.automatic.update(value=>!value);
    if(this.automatic()) void this.refresh(true);
  }

  private async api<T>(path:string):Promise<T> {
    const response=await fetch('/api'+path,{
      credentials:'same-origin',method:'GET',cache:'no-store',redirect:'error',
      headers:{accept:'application/json'}
    });
    const body:unknown=await response.json();
    if (!body || typeof body!=='object' || Array.isArray(body))
      throw new Error('A API devolveu uma resposta inesperada.');
    if (!response.ok) {
      const error=(body as {error?:unknown}).error;
      throw new Error(response.status===401 ? 'Sua sessão expirou; entre novamente.' :
        typeof error==='string' ? error : 'Falha HTTP '+response.status);
    }
    return body as T;
  }
  async refresh(automatic=false):Promise<void> {
    if (this.loading() || this.destroyed) return;
    this.loading.set(true);
    if(!automatic)this.error.set('');
    this.warning.set('');
    try {
      const data=await this.api<{repositories?:Repository[]}>('/repositories');
      if (!Array.isArray(data.repositories))
        throw new Error('A API não confirmou a lista de repositórios.');
      const linkedRepos=data.repositories.filter(repo=>repo &&
        typeof repo.fullName==='string' && REPO.test(repo.fullName) &&
        typeof repo.branch==='string' && typeof repo.workflow==='string');
      const panel=linkedRepos.find(repo=>repo.fullName==='Softdown-prog/Painel') ??
        {fullName:'Softdown-prog/Painel',branch:'main',workflow:'deploy-vps.yml'};
      const repos=[panel,...linkedRepos.filter(repo=>repo.fullName!==panel.fullName)].slice(0,8);
      const [projectResponse,historyResponse]=await Promise.allSettled([
        this.api<{projects?:LinkedProject[]}>('/projects'),
        this.api<{history?:PublicationJob[]}>('/publications')
      ]);
      const projects=projectResponse.status==='fulfilled' &&
        Array.isArray(projectResponse.value.projects) ? projectResponse.value.projects : [];
      const jobs=historyResponse.status==='fulfilled' &&
        Array.isArray(historyResponse.value.history) ? historyResponse.value.history : [];
      const partial:string[]=[];
      if(projectResponse.status==='rejected')partial.push('vínculos dos projetos');
      if(historyResponse.status==='rejected')partial.push('histórico de publicações');
      const groups=await Promise.all(repos.map(async repo=>{
        const linked=projects.find(item=>item.repository===repo.fullName &&
          typeof item.slug==='string' && SLUG.test(item.slug));
        const isPanel=repo.fullName==='Softdown-prog/Painel';
        const slug=isPanel?'panel-api':(linked?.slug??null);
        const [runsResponse,releaseResponse]=await Promise.allSettled([
          this.api<{runs?:WorkflowRun[]}>('/repositories/'+repo.fullName+'/runs-all'),
          isPanel ? this.api<ReleaseSnapshot>('/panel-version') :
          slug ? this.api<ReleaseSnapshot>('/projects/'+slug+'/releases'):Promise.resolve(null)
        ]);
        const release=releaseResponse.status==='fulfilled'?releaseResponse.value:null;
        const runs=runsResponse.status==='fulfilled'&&Array.isArray(runsResponse.value.runs)
          ? runsResponse.value.runs.filter(validRun).slice(0,8):[];
        const issue=runsResponse.status==='rejected' ? 'Execuções do GitHub indisponíveis.' :
          releaseResponse.status==='rejected'&&slug ? 'Não foi possível conferir a VPS.' : null;
        const rows:RunRow[]=runs.map(run=>{
          const ci=ciStatus(run);
          const raw=vpsStatus(run,repo.fullName,slug,release,jobs);
          const vps=isPanel&&raw.tone==='success'
            ? {...raw,label:'API do Painel nesta revisão'} : raw;
          return {key:repo.fullName+':'+run.id,sha:run.sha,shortSha:run.sha.slice(0,9),
            runId:run.id,name:typeof run.name==='string'?run.name:'Workflow',
            createdAt:run.createdAt,
            url:'https://github.com/'+repo.fullName+'/actions/runs/'+run.id,
            ci,delivery:deliveryStatus(run,vps),vps};
        });
        const installedRevision=release?.current?.state==='running'&&
          typeof release.current.revision==='string'&&SHA.test(release.current.revision)
          ? release.current.revision:null;
        return {name:repo.fullName,branch:repo.branch,slug,installedRevision,rows,issue} satisfies RepoGroup;
      }));
      if(this.destroyed)return;
      this.groups.set(groups);
      this.configured.set(repos.length>0);
      this.checkedAt.set(new Date().toISOString());
      this.error.set('');
      if(partial.length)this.warning.set('Consulta parcial: '+partial.join(', ')+'. Sem confirmação, não marcamos a VPS como atualizada.');
      if(groups.some(group=>group.issue))this.warning.set('Alguns serviços não responderam. Veja os avisos em cada repositório.');
    }catch(error){
      if(this.destroyed)return;
      this.error.set(error instanceof Error?error.message:'Não foi possível consultar as publicações.');
      // Do not keep stale green statuses after the monitoring connection fails.
      this.checkedAt.set(null);
      this.groups.set([]);
      this.configured.set(false);
      this.expanded.set(null);
    }finally{if(!this.destroyed)this.loading.set(false);}
  }

  async toggleJobs(row:RunRow,repository:string):Promise<void> {
    if(this.expanded()===row.key){this.expanded.set(null);this.expandedJobs.set([]);return;}
    if(this.jobLoading())return;
    this.expanded.set(row.key);
    this.expandedJobs.set([]);
    this.jobLoading.set(true);
    this.jobError.set('');
    try{
      const data=await this.api<{jobs?:ActionJob[]}>(
        '/repositories/'+repository+'/runs/'+row.runId+'/jobs');
      if(!Array.isArray(data.jobs))throw new Error('O GitHub não informou as etapas da execução.');
      if(this.destroyed||this.expanded()!==row.key)return;
      this.expandedJobs.set(data.jobs.filter(j=>Number.isSafeInteger(j.id)&&
        typeof j.name==='string'&&typeof j.status==='string'));
    }catch(error){
      if(!this.destroyed&&this.expanded()===row.key)
        this.jobError.set(error instanceof Error?error.message:'Etapas indisponíveis.');
    }finally{if(!this.destroyed)this.jobLoading.set(false);}
  }
  jobStage(status:string,conclusion:string|null):Stage{
    return ciStatus({id:1,sha:'0'.repeat(40),status,conclusion});
  }
  formatDate(value?:string|null):string {
    if(!value)return 'Sem horário confirmado';
    const date=new Date(value);
    return Number.isNaN(date.getTime())?'Sem horário confirmado':date.toLocaleString('pt-BR');
  }
}
