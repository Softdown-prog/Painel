import { Component, OnInit, OnDestroy, signal } from '@angular/core';
import {confirmedTerminalCommand,validTerminalCommand} from './terminal-command';

type SshStatus={enabled:boolean;configured:boolean};
type Execution={exitCode:number;output:string;truncated:boolean;timedOut:boolean};
type TerminalJob={id:string;state:'running'|'completed'|'failed'|'cancelled'|'timed_out';
 startedAt:string;finishedAt:string|null;exitCode:number|null;output:string;
 truncated:boolean;durationMs:number;error:string|null;fingerprint:string};
@Component({selector:'panel-vps-terminal',standalone:true,
  templateUrl:'./terminal.component.html',styleUrl:'./terminal.component.css'})
export class TerminalComponent implements OnInit,OnDestroy {
  readonly status=signal<SshStatus|null>(null);
  readonly busy=signal(false);
  readonly checking=signal(false);
  readonly command=signal('');
  readonly pending=signal(false);
  readonly output=signal('');
  readonly result=signal<Execution|null>(null);
  readonly job=signal<TerminalJob|null>(null);
  readonly stopping=signal(false);
  readonly stopPending=signal(false);
  private polling:ReturnType<typeof setInterval>|null=null;
  readonly error=signal('');
  readonly executedAt=signal<string|null>(null);
  private preparedCommand:string|null=null;
  private destroyed=false;
  readonly snippets=['uname -a','df -h /','free -h','docker ps --format "{{.Names}}: {{.Status}}"'];
  ngOnInit():void {
    this.polling=setInterval(()=>{if(this.job()?.state==='running'&&!this.busy()&&!this.destroyed)void this.pollJob();},2000);
    void this.refresh();
  }
  ngOnDestroy():void {
    this.destroyed=true;
    if(this.polling!==null)clearInterval(this.polling);
    this.polling=null;
    this.cancel();
    this.command.set('');
    this.output.set('');
    this.result.set(null);
    this.job.set(null);
    this.status.set(null);
  }
  private async api<T>(path:string,method='GET',data?:object):Promise<T>{
    const response=await fetch('/api'+path,{method,credentials:'same-origin',
      cache:'no-store',redirect:'error',headers:data?{'content-type':'application/json'}:{accept:'application/json'},
      ...(data?{body:JSON.stringify(data)}:{})});
    let json:unknown;
    try{json=await response.json();}catch{throw Error('Resposta JSON inválida da VPS.');}
    if(!json||typeof json!=='object'||Array.isArray(json))throw Error('Resposta inválida da VPS.');
    if(!response.ok) {
      const reason=(json as {error?:unknown}).error;
      throw Error(typeof reason==='string'?reason:'Erro da VPS (HTTP '+response.status+').');
    }
    return json as T;
  }
  async refresh():Promise<void>{
    if(this.checking()||this.busy())return;
    this.checking.set(true);this.error.set('');
    try{
      const status=await this.api<SshStatus>('/terminal/ssh/status');
      if(typeof status.enabled!=='boolean'||typeof status.configured!=='boolean')throw Error('Estado SSH inválido.');
      if(this.destroyed)return;
      this.status.set(status);
      if(!status.enabled||!status.configured)this.cancel();
      else await this.pollJob();
    }catch(e){if(!this.destroyed){this.status.set(null);this.cancel();this.error.set(this.message(e));}}
    finally{this.checking.set(false);}
  }
  choose(value:string):void {
    if(this.busy()||this.destroyed)return;
    this.command.set(value);
    this.cancel();
  }
  updateCommand(event:Event):void {
    if(this.busy()||this.destroyed)return;
    const field=event.target;
    if(!(field instanceof HTMLTextAreaElement))return;
    this.command.set(field.value);
    this.cancel();
  }
  prepare(event:Event):void {
    event.preventDefault();
    if(this.busy()||this.checking()||this.destroyed||
       !this.status()?.configured||!this.status()?.enabled)return;
    const value=this.command();
    if(!validTerminalCommand(value)){
      this.cancel();
      this.error.set('Comando vazio, inválido ou maior que 4 MB.');return;
    }
    this.error.set('');
    this.preparedCommand=value;
    this.pending.set(true);
  }
  cancel():void {this.pending.set(false);this.preparedCommand=null;}
  async execute():Promise<void>{
    if(this.busy()||this.destroyed||this.job()?.state==='running')return;
    const value=this.command();
    const status=this.status();
    if(!confirmedTerminalCommand(this.preparedCommand,value,
      status?.enabled===true,status?.configured===true,this.pending())){
      this.cancel();
      this.error.set('O comando mudou ou perdeu a confirmação. Revise e prepare novamente.');
      return;
    }
    this.cancel();
    this.busy.set(true);this.error.set('');
    this.result.set(null);this.output.set('');
    try{
      const response=await this.api<{job:TerminalJob}>('/terminal/ssh/jobs','POST',{command:value});
      if(this.destroyed)return;
      this.applyJob(response.job);
      this.command.set('');
    }catch(e){if(!this.destroyed)this.error.set(this.message(e));}
    finally{this.busy.set(false);}
  }
  async pollJob():Promise<void>{
    if(this.destroyed||this.busy()||!this.status()?.configured)return;
    try{
      const response=await this.api<{job:TerminalJob|null}>('/terminal/ssh/jobs/current');
      if(this.destroyed)return;
      if(response.job)this.applyJob(response.job);
      else if(this.job()?.state==='running'){
        this.job.set(null);
        this.result.set(null);
        this.output.set('');
        this.error.set('A API perdeu o acompanhamento da tarefa. Verifique a VPS antes de executar novamente.');
      }
    }catch(e){
      if(!this.destroyed&&this.job()?.state==='running')
        this.error.set('Não foi possível consultar o andamento. A tarefa pode continuar na VPS. '+this.message(e));
    }
  }
  private applyJob(job:TerminalJob):void{
    if(!job||!/^[a-f0-9]{32}$/.test(job.id)||
      !['running','completed','failed','cancelled','timed_out'].includes(job.state)||
      typeof job.output!=='string'||typeof job.truncated!=='boolean'||
      !Number.isFinite(job.durationMs)||typeof job.startedAt!=='string')
      throw Error('Estado da tarefa SSH inválido.');
    this.job.set(job);
    this.output.set(job.output);
    this.executedAt.set(job.startedAt);
    if(job.state==='running')this.result.set(null);
    else this.result.set({exitCode:job.exitCode??-1,output:job.output,
      truncated:job.truncated,timedOut:job.state==='timed_out'});
  }
  requestStop():void{
    if(this.job()?.state==='running'&&!this.busy())this.stopPending.set(true);
  }
  async stopJob():Promise<void>{
    const job=this.job();
    if(!job||job.state!=='running'||!this.stopPending()||this.busy())return;
    this.stopPending.set(false);
    this.stopping.set(true);this.error.set('');
    try{
      const response=await this.api<{job:TerminalJob}>('/terminal/ssh/jobs/'+job.id+'/cancel','POST');
      if(!this.destroyed)this.applyJob(response.job);
    }catch(e){if(!this.destroyed)this.error.set(this.message(e));}
    finally{this.stopping.set(false);}
  }
  clear():void {
    if(this.job()?.state==='running')return;
    this.result.set(null);this.output.set('');this.error.set('');
  }
  private message(e:unknown):string {return e instanceof Error?e.message:'Falha na consulta do terminal.';}
}