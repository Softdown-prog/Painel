/**
 * Bounded background SSH jobs. A job outlives its HTTP request/navigation and
 * streams progress to authenticated polling routes. The API process owns jobs:
 * an API restart may interrupt/discard them; no shell text is persisted.
 */
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {terminalSshConfig} from './terminal-ssh.ts';

const MAX_COMMAND_BYTES=4*1024*1024;
const MAX_OUTPUT_CHARS=64000;
const MAX_RUNTIME_MS=30*60_000;
const RETAIN_MS=60*60_000;
const ID=/^[a-f0-9]{32}$/;
type State='running'|'completed'|'failed'|'cancelled'|'timed_out';
type Runner=(command:string,onData:(chunk:string)=>void,signal:AbortSignal)=>Promise<number>;
type Result={id:string;state:State;startedAt:string;finishedAt:string|null;exitCode:number|null;
 output:string;truncated:boolean;durationMs:number;error:string|null;fingerprint:string};
type Job=Result&{controller:AbortController;timeout:ReturnType<typeof setTimeout>|null;
 cancelled:boolean;timedOut:boolean};
type Deps={
 send:(res:ServerResponse,status:number,data:unknown)=>void;
 body:(req:IncomingMessage)=>Promise<Record<string,unknown>>;
 enabled?:boolean;configured?:boolean;manager?:TerminalJobManager;
};

export function validJobCommand(data:Record<string,unknown>):data is {command:string}{
 return Object.keys(data).length===1&&typeof data['command']==='string'&&
  data['command'].trim().length>0&&Buffer.byteLength(data['command'],'utf8')<=MAX_COMMAND_BYTES&&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(data['command']);
}

export function streamSsh(command:string,onData:(chunk:string)=>void,signal:AbortSignal):Promise<number>{
 const settings=terminalSshConfig();
 if(!settings.valid)return Promise.reject(new Error('SSH não configurado'));
 if(signal.aborted)return Promise.reject(new Error('Execução cancelada'));
 return new Promise((resolve,reject)=>{
  const args=['-T','-p',String(settings.port),'-i',settings.key,
   '-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes',
   '-o','UserKnownHostsFile='+settings.hosts,'-o','ConnectTimeout=5',
   '-o','ConnectionAttempts=1','-o','ClearAllForwardings=yes',
   '-o','ControlMaster=no','-o','PermitLocalCommand=no','-o','ProxyCommand=none',
   '-o','PasswordAuthentication=no','--',settings.user+'@'+settings.host,'sh','-s'];
  const child=spawn('ssh',args,{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
  let settled=false;
  const force=()=>{if(!settled)child.kill('SIGKILL');};
  let killTimer:ReturnType<typeof setTimeout>|null=null;
  const abort=()=>{
   child.kill('SIGTERM');
   killTimer=setTimeout(force,2500);killTimer.unref();
  };
  const cleanup=()=>{
   signal.removeEventListener('abort',abort);
   if(killTimer!==null)clearTimeout(killTimer);
  };
  signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted)abort();
  const finish=(err?:Error,code?:number|null)=>{
   if(settled)return;
   settled=true;cleanup();
   if(err)reject(err);
   else resolve(Number.isInteger(code)?code as number:-1);
  };
  for(const stream of [child.stdout,child.stderr]){
   stream.on('data',(chunk:Buffer)=>onData(chunk.toString('utf8')));
  }
  child.once('error',(err:Error)=>finish(err));
  child.once('close',(code:number|null)=>finish(undefined,code));
  child.stdin.on('error',()=>{/* SSH may terminate before reading stdin */});
  child.stdin.end(command+'\n');
 });
}

export class TerminalJobManager {
 private readonly jobs=new Map<string,Job>();
 private activeId:string|null=null;
 private readonly run:Runner;
 private readonly maxRuntimeMs:number;
 constructor(run:Runner=streamSsh,maxRuntimeMs=MAX_RUNTIME_MS){
  this.run=run;
  this.maxRuntimeMs=maxRuntimeMs;
 }
 private prune():void{
  const now=Date.now();
  for(const [id,job] of this.jobs){
   if(job.state!=='running'&&job.finishedAt!==null&&
      now-Date.parse(job.finishedAt)>RETAIN_MS)this.jobs.delete(id);
  }
  // Only one active job and a bounded history; no unbounded process memory.
  while(this.jobs.size>12){
   const oldest=[...this.jobs].find(([,job])=>job.state!=='running');
   if(!oldest)break;
   this.jobs.delete(oldest[0]);
  }
 }
 private snapshot(job:Job):Result{
  return {id:job.id,state:job.state,startedAt:job.startedAt,finishedAt:job.finishedAt,
   exitCode:job.exitCode,output:job.output,truncated:job.truncated,
   durationMs:job.finishedAt===null?Date.now()-Date.parse(job.startedAt):job.durationMs,
   error:job.error,fingerprint:job.fingerprint};
 }
 current():Result|null{
  this.prune();
  if(this.activeId!==null){
   const active=this.jobs.get(this.activeId);
   if(active)return this.snapshot(active);
  }
  const last=[...this.jobs.values()].at(-1);
  return last?this.snapshot(last):null;
 }
 get(id:string):Result|null{
  this.prune();
  const job=ID.test(id)?this.jobs.get(id):undefined;
  return job?this.snapshot(job):null;
 }
 start(command:string):Result|null{
  this.prune();
  if(this.activeId!==null)return null;
  const id=randomBytes(16).toString('hex');
  const controller=new AbortController();
  const job:Job={id,controller,state:'running',startedAt:new Date().toISOString(),
   finishedAt:null,exitCode:null,output:'',truncated:false,durationMs:0,error:null,
   fingerprint:createHash('sha256').update(command).digest('hex').slice(0,16),
   cancelled:false,timedOut:false,timeout:null};
  this.jobs.set(id,job);this.activeId=id;
  job.timeout=setTimeout(()=>{
   job.timedOut=true;
   controller.abort();
  },this.maxRuntimeMs);
  job.timeout.unref();
  // Async job begins immediately, but never blocks its HTTP response.
  void Promise.resolve().then(()=>this.run(command,part=>{
   if(job.state!=='running')return;
   const space=MAX_OUTPUT_CHARS-job.output.length;
   if(space>0)job.output+=part.slice(0,space);
   if(part.length>space)job.truncated=true;
  },controller.signal)).then(code=>{
   job.exitCode=code;
   job.state=job.timedOut?'timed_out':job.cancelled?'cancelled':code===0?'completed':'failed';
  }).catch(()=>{
   job.state=job.timedOut?'timed_out':job.cancelled?'cancelled':'failed';
   job.error=job.cancelled||job.timedOut?null:'Falha na conexão SSH; confira o estado remoto antes de reenviar.';
  }).finally(()=>{
   if(job.timeout!==null)clearTimeout(job.timeout);
   job.timeout=null;
   job.finishedAt=new Date().toISOString();
   job.durationMs=Date.parse(job.finishedAt)-Date.parse(job.startedAt);
   if(this.activeId===id)this.activeId=null;
   console.log(JSON.stringify({event:'panel_ssh_job',id,fingerprint:job.fingerprint,
    state:job.state,exitCode:job.exitCode,durationMs:job.durationMs}));
   this.prune();
  });
  return this.snapshot(job);
 }
 cancel(id:string):Result|null{
  const job=ID.test(id)?this.jobs.get(id):undefined;
  if(!job)return null;
  if(job.state==='running'&&!job.cancelled){
   job.cancelled=true;
   job.controller.abort();
  }
  return this.snapshot(job);
 }
}

const manager=new TerminalJobManager();
export async function handleSshTerminalJobRoute(req:IncomingMessage,res:ServerResponse,deps:Deps):Promise<boolean>{
 const path=new URL(req.url||'/','http://panel.local').pathname;
 if(!path.startsWith('/terminal/ssh/jobs'))return false;
 const enabled=deps.enabled??process.env['PANEL_TERMINAL_SSH_ENABLED']==='1';
 if(!enabled){deps.send(res,403,{error:'Terminal SSH não habilitado.'});return true;}
 if(!(deps.configured??terminalSshConfig().valid)){
  deps.send(res,503,{error:'Acesso SSH ainda não configurado.'});return true;
 }
 const jobs=deps.manager??manager;
 if(path==='/terminal/ssh/jobs/current'&&req.method==='GET'){
  deps.send(res,200,{job:jobs.current()});return true;
 }
 if(path==='/terminal/ssh/jobs'&&req.method==='POST'){
  const input=await deps.body(req);
  if(!validJobCommand(input)){
   deps.send(res,400,{error:'Comando inválido (máximo de 4 MB).'});return true;
  }
  const job=jobs.start(input.command);
  if(!job){deps.send(res,429,{error:'Já existe uma tarefa SSH em execução. Consulte o andamento antes de iniciar outra.'});return true;}
  deps.send(res,202,{job});return true;
 }
 const match=/^\/terminal\/ssh\/jobs\/([a-f0-9]{32})(\/cancel)?$/.exec(path);
 if(match){
  const id=match[1];
  if(!id){deps.send(res,404,{error:'Tarefa não encontrada.'});return true;}
  if(!match[2]&&req.method==='GET'){
   const job=jobs.get(id);
   deps.send(res,job?200:404,job?{job}:{error:'Tarefa não encontrada.'});return true;
  }
  if(match[2]&&req.method==='POST'){
   const job=jobs.cancel(id);
   deps.send(res,job?200:404,job?{job,warning:'Interromper SSH não garante o encerramento de processos remotos desvinculados.'}:{error:'Tarefa não encontrada.'});
   return true;
  }
 }
 deps.send(res,405,{error:'Método não permitido.'});return true;
}
