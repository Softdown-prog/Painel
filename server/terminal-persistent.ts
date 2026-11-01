/**
 * SSH transport for host-owned systemd jobs.
 * The fixed root-owned helper must be deliberately installed on the VPS
 * before PANEL_TERMINAL_PERSISTENT=1 is enabled.
 *
 * Never pass command text as argv, a unit name or an environment variable:
 * shell script content is sent only on SSH stdin.
 */
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {terminalSshConfig} from './terminal-ssh.ts';

const HELPER='/usr/local/libexec/vps-panel-terminal-jobs';
const JOB_ID=/^[a-f0-9]{32}$/;
const MAX_REPLY=96*1024;
type State='running'|'completed'|'failed'|'cancelled'|'timed_out';
export type HostJob={id:string;state:State;startedAt:string;finishedAt:string|null;
 exitCode:number|null;output:string;truncated:boolean;durationMs:number;
 error:string|null;fingerprint:string};

function valid(value:unknown):value is HostJob{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const job=value as Partial<HostJob>;
 return typeof job.id==='string'&&JOB_ID.test(job.id)&&
  ['running','completed','failed','cancelled','timed_out'].includes(job.state??'')&&
  typeof job.startedAt==='string'&&typeof job.output==='string'&&
  job.output.length<=70_000&&typeof job.truncated==='boolean'&&
  typeof job.durationMs==='number'&&Number.isFinite(job.durationMs)&&
  typeof job.fingerprint==='string'&&/^[a-f0-9]{16}$/.test(job.fingerprint)&&
  (job.exitCode===null||Number.isSafeInteger(job.exitCode))&&
  (job.finishedAt===null||typeof job.finishedAt==='string')&&
  (job.error===null||typeof job.error==='string');
}

export async function hostRequest(action:'start'|'status'|'current'|'cancel',
 id?:string,command?:string):Promise<Record<string,unknown>>{
 const settings=terminalSshConfig();
 if(!settings.valid)throw Error('A conexão SSH não está configurada.');
 if(id!==undefined&&!JOB_ID.test(id))throw Error('Identificador de tarefa inválido.');
 if(action==='start'&&(typeof command!=='string'||!id))throw Error('Comando inválido.');
 if(action!=='start'&&command!==undefined)throw Error('Script enviado fora da operação inicial.');
 const hash=command!==undefined?createHash('sha256').update(command).digest('hex').slice(0,16):null;
 const args=['-T','-p',String(settings.port),'-i',settings.key,
  '-o','BatchMode=yes','-o','IdentitiesOnly=yes',
  '-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+settings.hosts,
  '-o','ConnectTimeout=5','-o','ConnectionAttempts=1',
  '-o','ClearAllForwardings=yes','-o','ControlMaster=no',
  '-o','PermitLocalCommand=no','-o','ProxyCommand=none',
  '-o','PasswordAuthentication=no','--',settings.user+'@'+settings.host,
  HELPER,action,...(id?[id]:[]),...(hash?[hash]:[])];
 return new Promise((resolve,reject)=>{
  const child=spawn('ssh',args,{stdio:['pipe','pipe','pipe'],
   env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
  let output='';let size=0;let settled=false;
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Error('Consulta SSH excedeu o prazo. Verifique o estado antes de repetir.'));},20_000);
  const finish=(error?:Error,exit?:number|null)=>{
   if(settled)return;
   settled=true;clearTimeout(timer);
   if(error){reject(error);return;}
   if(exit!==0){reject(Error('Operação do supervisor SSH não foi concluída.'));return;}
   try{
    const json:unknown=JSON.parse(output);
    if(!json||typeof json!=='object'||Array.isArray(json))throw Error('Resposta inválida do supervisor SSH.');
    const obj=json as Record<string,unknown>;
    if(typeof obj['error']==='string')throw Error('Supervisor SSH rejeitou a operação.');
    resolve(obj);
   }catch{reject(Error('Não foi possível confirmar o estado da tarefa SSH.'));}
  };
  child.stdout.on('data',(chunk:Buffer)=>{
   size+=chunk.length;
   if(size>MAX_REPLY){child.kill('SIGKILL');finish(Error('Resposta SSH excedeu o limite seguro.'));return;}
   output+=chunk.toString('utf8');
  });
  // Never echo stderr (it may contain host/environment information).
  child.stderr.resume();
  child.once('error',(error:Error)=>finish(error));
  child.once('close',(code:number|null)=>finish(undefined,code));
  child.stdin.on('error',()=>{});
  child.stdin.end(command??'');
 });
}
export class PersistentTerminalJobManager {
 private readonly request:typeof hostRequest;
 constructor(request:typeof hostRequest=hostRequest){this.request=request;}
 async current():Promise<HostJob|null>{
  const result=await this.request('current');
  return this.parse(result);
 }
 async get(id:string):Promise<HostJob|null>{
  if(!JOB_ID.test(id))return null;
  const result=await this.request('status',id);
  return this.parse(result);
 }
 async start(command:string):Promise<HostJob|null>{
  const id=randomBytes(16).toString('hex');
  const result=await this.request('start',id,command);
  if(result['busy']===true)return null;
  const job=this.parse(result);
  if(!job||job.id!==id)throw Error('Identificador de tarefa inconsistente.');
  return job;
 }
 async cancel(id:string):Promise<HostJob|null>{
  if(!JOB_ID.test(id))return null;
  const result=await this.request('cancel',id);
  return this.parse(result);
 }
 private parse(value:Record<string,unknown>):HostJob|null{
  if(value['job']===null||value['notFound']===true)return null;
  if(!valid(value['job']))throw Error('Supervisor SSH retornou um estado inválido.');
  return value['job'];
 }
}
