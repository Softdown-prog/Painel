import { Component, OnInit, computed, signal } from '@angular/core';

type Repo = {fullName:string; branch:string; workflow:string};
type Run = {id:number; sha:string; branch:string; status:string; conclusion:string|null; createdAt:string};
type Notice = {text:string; kind:'success'|'warning'};
const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REF = /^(?!\/|.*\.\.)(?!.*\/\/)[A-Za-z0-9_./-]{1,100}$/;
const WORKFLOW = /^[A-Za-z0-9_.-]{1,80}\.ya?ml$/;

@Component({
  selector:'panel-github-projects',
  standalone:true,
  templateUrl:'./github-projects.component.html',
  styleUrl:'./github-projects.component.css'
})
export class GithubProjectsComponent implements OnInit {
  readonly loading=signal(false);
  readonly working=signal(false);
  readonly runsLoading=signal(false);
  readonly error=signal('');
  readonly notice=signal<Notice|null>(null);
  readonly tokenConfigured=signal(false);
  readonly allowedOwner=signal('Softdown-prog');
  readonly repositories=signal<Repo[]>([]);
  readonly chosen=signal('');
  readonly repoName=signal('');
  readonly branch=signal('main');
  readonly workflow=signal('deploy.yml');
  readonly runs=signal<Run[]>([]);
  readonly action=signal<'deploy'|'disconnect'|null>(null);
  readonly selected=computed(()=>this.repositories().find(repo=>repo.fullName===this.chosen())??null);
  readonly validForm=computed(()=>{
    const owner=this.allowedOwner();
    const name=this.repoName().trim();
    return REPO_NAME.test(name) && name.split('/')[0]===owner &&
      !name.endsWith('/.') && !name.endsWith('/..') &&
      REF.test(this.branch().trim()) && !this.branch().endsWith('/') &&
      WORKFLOW.test(this.workflow().trim());
  });

  ngOnInit():void { void this.refresh(); }

  private async api<T>(path:string,method='GET',data?:object):Promise<T> {
    const res=await fetch('/api'+path,{
      method, credentials:'same-origin',redirect:'error',cache:'no-store',
      headers:data?{'content-type':'application/json'}:{accept:'application/json'},
      ...(data?{body:JSON.stringify(data)}:{})
    });
    let result:unknown;
    try {result=await res.json();}
    catch {throw new Error('A API não devolveu uma resposta JSON válida.');}
    if(!result || typeof result!=='object'||Array.isArray(result))
      throw new Error('Resposta inesperada da API.');
    if(!res.ok){
      const message=(result as {error?:unknown}).error;
      throw new Error(res.status===401?'Sessão expirada. Entre novamente.':
        typeof message==='string'?message:'API indisponível (HTTP '+res.status+').');
    }
    return result as T;
  }

  async refresh():Promise<void> {
    if(this.loading()||this.working())return;
    this.loading.set(true);
    this.error.set('');
    try{
      const response=await this.api<{repositories?:Repo[];tokenConfigured?:boolean;allowedOwner?:string}>('/repositories');
      if(!Array.isArray(response.repositories))throw new Error('O servidor não informou os repositórios cadastrados.');
      const list=response.repositories.filter(repo=>repo&&typeof repo.fullName==='string'&&
        REPO_NAME.test(repo.fullName)&&typeof repo.branch==='string'&&typeof repo.workflow==='string');
      this.repositories.set(list);
      this.tokenConfigured.set(response.tokenConfigured===true);
      if(typeof response.allowedOwner==='string'&&response.allowedOwner)this.allowedOwner.set(response.allowedOwner);
      this.chosen.set(list.some(repo=>repo.fullName===this.chosen())?this.chosen():list[0]?.fullName??'');
      this.action.set(null);
      await this.refreshRuns();
    }catch(e){this.repositories.set([]);this.runs.set([]);this.error.set(this.message(e));}
    finally{this.loading.set(false);}
  }

  choose(value:string):void {
    this.chosen.set(value);
    this.action.set(null);
    this.notice.set(null);
    void this.refreshRuns();
  }

  async refreshRuns():Promise<void> {
    const repo=this.selected();
    this.runs.set([]);
    if(!repo)return;
    this.runsLoading.set(true);
    try{
      const result=await this.api<{runs?:Run[]}>('/repositories/'+repo.fullName+'/runs');
      if(this.chosen()!==repo.fullName)return;
      if(!Array.isArray(result.runs))throw new Error('O GitHub não informou o histórico desta branch.');
      this.runs.set(result.runs.filter(r=>Number.isSafeInteger(r.id)&&
        typeof r.sha==='string'&&typeof r.status==='string').slice(0,10));
    }catch(e){if(this.chosen()===repo.fullName)this.error.set(this.message(e));}
    finally{this.runsLoading.set(false);}
  }

  async connect(event:Event):Promise<void> {
    event.preventDefault();
    if(this.working()||!this.tokenConfigured()||!this.validForm())return;
    const repo=this.repoName().trim();
    this.working.set(true);this.error.set('');this.notice.set(null);
    try{
      await this.api('/repositories','POST',{
        fullName:repo,branch:this.branch().trim(),workflow:this.workflow().trim()
      });
      this.repoName.set('');
      this.notice.set({kind:'success',text:'Repositório conectado. Nenhum deploy foi iniciado.'});
    }catch(e){this.error.set(this.message(e));}
    finally{this.working.set(false);}
    // Refresh without racing working-state guard.
    await this.refresh();
    if(this.repositories().some(r=>r.fullName===repo)){this.chosen.set(repo);await this.refreshRuns();}
  }

  startAction(action:'deploy'|'disconnect'):void {
    if(this.working()||!this.selected())return;
    if(action==='deploy'&&!this.tokenConfigured())return;
    this.error.set('');this.notice.set(null);this.action.set(action);
  }

  async confirm():Promise<void> {
    const repo=this.selected(), action=this.action();
    if(!repo||!action||this.working()||(action==='deploy'&&!this.tokenConfigured()))return;
    this.working.set(true);this.error.set('');this.notice.set(null);
    try{
      if(action==='deploy'){
        await this.api('/repositories/'+repo.fullName+'/deploy','POST');
        this.notice.set({kind:'success',text:'Solicitação recebida pelo GitHub. O workflow pode entrar em fila; confirme o resultado em Publicações.'});
      } else {
        await this.api('/repositories/'+repo.fullName,'DELETE');
        this.notice.set({kind:'success',text:'Conexão removida. Nenhum container foi alterado.'});
      }
      this.action.set(null);
    }catch(e){this.error.set(this.message(e));}
    finally{this.working.set(false);}
    if(action==='disconnect')await this.refresh();
    else await this.refreshRuns();
  }

  cancelAction():void {this.action.set(null);}
  status(run:Run):string {
    if(run.status==='in_progress')return 'Em execução';
    if(run.status==='queued'||run.status==='waiting'||run.status==='pending')return 'Na fila';
    const status=run.conclusion??run.status;
    return ({success:'Concluído',failure:'Falhou',cancelled:'Cancelado',timed_out:'Tempo esgotado',
      skipped:'Ignorado'} as Record<string,string>)[status]??status;
  }
  tone(run:Run):string {
    if(run.status!=='completed')return 'pending';
    return run.conclusion==='success'?'success':
      run.conclusion==='failure'||run.conclusion==='timed_out'?'failure':'neutral';
  }
  date(value?:string):string {
    if(!value)return 'Sem data';
    const date=new Date(value);
    return Number.isFinite(date.getTime())?date.toLocaleString('pt-BR'):'Sem data';
  }
  private message(error:unknown):string {
    return error instanceof Error?error.message:'Erro ao acessar o GitHub.';
  }
}
