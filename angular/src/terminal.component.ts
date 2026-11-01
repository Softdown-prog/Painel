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
  private jobEpoch=0;
  private pollInFlightEpoch:number|null=null;
  readonly uncertain=signal(false);
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
    this.jobEpoch++;
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
    if(this.busy()||this.checking()||this.destroyed||this.uncertain()||
       this.job()?.state==='running'||!this.status()?.configured||!this.status()?.enabled)return;
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
    if(this.busy()||this.destroyed||this.uncertain()||this.job()?.state==='running')return;
    const value=this.command();
    const status=this.status();
    if(!confirmedTerminalCommand(this.preparedCommand,value,
      status?.enabled===true,status?.configured===true,this.pending())){
      this.cancel();
      this.error.set('O comando mudou ou perdeu a confirmação. Revise e prepare novamente.');
      return;
    }
    this.cancel();
    this.jobEpoch++; // Invalidate any GET started before this command.
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
    const epoch=this.jobEpoch;
    if(this.pollInFlightEpoch===epoch)return; // One poll per generation.
    this.pollInFlightEpoch=epoch;
    try{
      const response=await this.api<{job:TerminalJob|null}>('/terminal/ssh/jobs/current');
      if(this.destroyed||epoch!==this.jobEpoch)return;
      const previous=this.job();
      if(response.job){
        if(previous?.state==='running'&&previous.id!==response.job.id){
          this.uncertain.set(true);
          this.error.set('A VPS apresentou outra tarefa enquanto a anterior estava em execução. Verifique o host antes de reenviar comandos.');
          return;
        }
        if(previous&&previous.id===response.job.id&&previous.state!=='running'&&
           response.job.state==='running')return; // Ignore regressed status.
        this.applyJob(response.job);
        this.uncertain.set(false);
        this.error.set('');
      }else if(previous?.state==='running'){
        // A reboot or missing in-memory job does NOT prove remote completion.
        // Keep the running record and block further execution until verified.
        this.uncertain.set(true);
        this.error.set('A API perdeu o acompanhamento da tarefa. Ela pode continuar na VPS. Confira o host antes de executar novamente.');
      }
    }catch(e){
      if(!this.destroyed&&epoch===this.jobEpoch&&this.job()?.state==='running'){
        this.error.set('Não foi possível consultar o andamento. A tarefa pode continuar na VPS. '+this.message(e));
      }
    }finally{
      if(this.pollInFlightEpoch===epoch)this.pollInFlightEpoch=null;
    }
  }
  private applyJob(job:TerminalJob):void{
    if(!job||!/^[a-f0-9]{32}$/.test(job.id)||
      !['running','completed','failed','cancelled','timed_out'].includes(job.state)||
      typeof job.output!=='string'||typeof job.truncated!=='boolean'||
      !Number.isFinite(job.durationMs)||typeof job.startedAt!=='string')
      throw Error('Estado da tarefa SSH inválido.');
    this.job.set(job);
    if(job.state!=='running')this.stopPending.set(false);
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
    this.jobEpoch++; // Reject polls that predate this cancellation request.
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