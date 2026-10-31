import { Component, OnInit, OnDestroy, signal } from '@angular/core';
import {confirmedTerminalCommand,validTerminalCommand} from './terminal-command';

type SshStatus={enabled:boolean;configured:boolean};
type Execution={exitCode:number;output:string;truncated:boolean;timedOut:boolean};
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
  readonly error=signal('');
  readonly executedAt=signal<string|null>(null);
  private preparedCommand:string|null=null;
  private destroyed=false;
  readonly snippets=['uname -a','df -h /','free -h','docker ps --format "{{.Names}}: {{.Status}}"'];
  ngOnInit():void {void this.refresh();}
  ngOnDestroy():void {
    this.destroyed=true;
    this.cancel();
    this.command.set('');
    this.output.set('');
    this.result.set(null);
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
    if(this.busy()||this.destroyed)return;
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
      const result=await this.api<Execution>('/terminal/ssh/exec','POST',{command:value});
      if(this.destroyed)return;
      if(!Number.isSafeInteger(result.exitCode)||typeof result.output!=='string'||
         typeof result.truncated!=='boolean'||typeof result.timedOut!=='boolean')
        throw Error('Resultado SSH inválido.');
      this.output.set(result.output);
      this.result.set(result);
      this.executedAt.set(new Date().toISOString());
      this.command.set('');
    }catch(e){if(!this.destroyed)this.error.set(this.message(e));}
    finally{this.busy.set(false);}
  }
  clear():void {this.result.set(null);this.output.set('');this.error.set('');}
  private message(e:unknown):string {return e instanceof Error?e.message:'Falha na consulta do terminal.';}
}