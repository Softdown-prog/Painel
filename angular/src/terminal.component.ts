import { Component, OnInit, signal } from '@angular/core';

type SshStatus={enabled:boolean;configured:boolean};
type Execution={exitCode:number;output:string;truncated:boolean;timedOut:boolean};
const MAX_COMMAND_BYTES=4*1024*1024;
@Component({selector:'panel-vps-terminal',standalone:true,
  templateUrl:'./terminal.component.html',styleUrl:'./terminal.component.css'})
export class TerminalComponent implements OnInit {
  readonly status=signal<SshStatus|null>(null);
  readonly busy=signal(false);
  readonly checking=signal(false);
  readonly command=signal('');
  readonly pending=signal(false);
  readonly output=signal('');
  readonly result=signal<Execution|null>(null);
  readonly error=signal('');
  readonly executedAt=signal<string|null>(null);
  readonly snippets=['uname -a','df -h /','free -h','docker ps --format "{{.Names}}: {{.Status}}"'];
  ngOnInit():void {void this.refresh();}
  private async api<T>(path:string,method='GET',data?:object):Promise<T>{
    const response=await fetch('/api'+path,{method,credentials:'same-origin',
      cache:'no-store',redirect:'error',headers:data?{'content-type':'application/json'}:{accept:'application/json'},
      body:data?JSON.stringify(data):undefined});
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
      this.status.set(status);
    }catch(e){this.status.set(null);this.error.set(this.message(e));}
    finally{this.checking.set(false);}
  }
  choose(value:string):void {if(this.busy())return;this.command.set(value);this.pending.set(false);}
  prepare(event:Event):void {
    event.preventDefault();
    if(this.busy()||!this.status()?.configured||!this.status()?.enabled)return;
    const value=this.command();
    if(!value.trim()||new TextEncoder().encode(value).length>MAX_COMMAND_BYTES ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)){
      this.error.set('Comando vazio, inválido ou maior que 4 MB.');return;
    }
    this.error.set('');
    this.pending.set(true);
  }
  cancel():void {this.pending.set(false);}
  async execute():Promise<void>{
    if(this.busy()||!this.pending()||!this.status()?.enabled||!this.status()?.configured)return;
    const value=this.command();
    this.busy.set(true);this.error.set('');this.pending.set(false);
    this.result.set(null);this.output.set('');
    try{
      const result=await this.api<Execution>('/terminal/ssh/exec','POST',{command:value});
      if(typeof result.exitCode!=='number'||typeof result.output!=='string')throw Error('Resultado SSH inválido.');
      this.output.set(result.output);
      this.result.set(result);
      this.executedAt.set(new Date().toISOString());
      this.command.set('');
    }catch(e){this.error.set(this.message(e));}
    finally{this.busy.set(false);}
  }
  clear():void {this.result.set(null);this.output.set('');this.error.set('');}
  private message(e:unknown):string {return e instanceof Error?e.message:'Falha na consulta do terminal.';}
}