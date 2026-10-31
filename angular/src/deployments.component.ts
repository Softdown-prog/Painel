import { Component, OnInit, signal } from '@angular/core';
import {
  ciStatus, validRun, vpsStatus,
  type LinkedProject, type PublicationJob, type ReleaseSnapshot,
  type Stage, type WorkflowRun
} from './deployment-status';

type Repository = {fullName:string; branch:string; workflow:string};
type RunRow = {
  key:string; sha:string; shortSha:string; runId:number; createdAt?:string;
  url:string; ci:Stage; vps:Stage
};
type RepoGroup = {
  name:string; branch:string; workflow:string; slug:string|null;
  installedRevision:string|null; rows:RunRow[]; issue:string|null
};
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA = /^[a-f0-9]{40}$/i;

@Component({
  selector:'panel-deployments',
  standalone:true,
  templateUrl:'./deployments.component.html',
  styleUrl:'./deployments.component.css'
})
export class DeploymentsComponent implements OnInit {
  readonly loading=signal(false);
  readonly error=signal('');
  readonly warning=signal('');
  readonly groups=signal<RepoGroup[]>([]);
  readonly checkedAt=signal<string|null>(null);
  readonly configured=signal(false);

  ngOnInit():void { void this.refresh(); }

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

  async refresh():Promise<void> {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set('');
    this.warning.set('');
    try {
      const data=await this.api<{repositories?:Repository[]}>('/repositories');
      if (!Array.isArray(data.repositories))
        throw new Error('A API não confirmou a lista de repositórios.');
      const repos=data.repositories.filter(repo=>repo &&
        typeof repo.fullName==='string' && REPO.test(repo.fullName) &&
        typeof repo.branch==='string' && typeof repo.workflow==='string').slice(0,8);
      this.configured.set(repos.length>0);
      const [projectResponse,historyResponse]=await Promise.allSettled([
        this.api<{projects?:LinkedProject[]}>('/projects'),
        this.api<{history?:PublicationJob[]}>('/publications')
      ]);
      const projects=projectResponse.status==='fulfilled' &&
        Array.isArray(projectResponse.value.projects) ? projectResponse.value.projects : [];
      const jobs=historyResponse.status==='fulfilled' &&
        Array.isArray(historyResponse.value.history) ? historyResponse.value.history : [];
      const partial:string[]=[];
      if(projectResponse.status==='rejected') partial.push('vínculos dos projetos');
      if(historyResponse.status==='rejected') partial.push('histórico de publicações');

      const groups=await Promise.all(repos.map(async repo=>{
        const linked=projects.find(item=>item.repository===repo.fullName &&
          typeof item.slug==='string' && SLUG.test(item.slug));
        const slug=linked?.slug ?? null;
        const [runsResponse,releaseResponse]=await Promise.allSettled([
          this.api<{runs?:WorkflowRun[]}>('/repositories/'+repo.fullName+'/runs'),
          slug ? this.api<ReleaseSnapshot>('/projects/'+slug+'/releases') :
            Promise.resolve(null)
        ]);
        const release=releaseResponse.status==='fulfilled' ? releaseResponse.value : null;
        const runs=runsResponse.status==='fulfilled' && Array.isArray(runsResponse.value.runs) ?
          runsResponse.value.runs.filter(validRun).slice(0,4) : [];
        const issue=runsResponse.status==='rejected' ? 'Não foi possível consultar as execuções do GitHub.' :
          releaseResponse.status==='rejected' && slug ? 'Não foi possível conferir o container na VPS.' : null;
        const rows:RunRow[]=runs.map(run=>({
          key:repo.fullName+':'+run.id,sha:run.sha,
          shortSha:run.sha.slice(0,9),runId:run.id,createdAt:run.createdAt,
          url:'https://github.com/'+repo.fullName+'/actions/runs/'+run.id,
          ci:ciStatus(run),vps:vpsStatus(run,repo.fullName,slug,release,jobs)
        }));
        const installedRevision=release?.current?.state==='running' &&
          typeof release.current.revision==='string' && SHA.test(release.current.revision) ?
          release.current.revision : null;
        return {name:repo.fullName,branch:repo.branch,workflow:repo.workflow,
          slug,installedRevision,rows,issue} satisfies RepoGroup;
      }));
      this.groups.set(groups);
      this.checkedAt.set(new Date().toISOString());
      if(partial.length) this.warning.set('Consultas indisponíveis: '+partial.join(', ')+
        '. Os estados não confirmados continuam sem indicação de sucesso.');
    }catch(error){
      this.error.set(error instanceof Error?error.message:'Não foi possível consultar as publicações.');
      this.checkedAt.set(null);
      this.groups.set([]);
      this.configured.set(false);
    } finally { this.loading.set(false); }
  }
  formatDate(value?:string|null):string {
    if (!value) return 'Sem horário confirmado';
    const d=new Date(value);
    return Number.isNaN(d.getTime())?'Sem horário confirmado':d.toLocaleString('pt-BR');
  }
}
