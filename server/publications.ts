import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readProjects } from './projects.ts';
import { readRepositories } from './github.ts';
import { readImports } from './image-import.ts';
import { handleReleaseRoute } from './releases.ts';
import { handleImageImportRoute } from './image-import.ts';
import { validSlug } from './apps.ts';

type Phase = 'queued' | 'importing' | 'staging' | 'health' | 'promoting' | 'completed' | 'attention' | 'failed';
export type Publication = {
  id:string; slug:string; repository:string; runId:number; revision:string|null;
  phase:Phase; createdAt:string; updatedAt:string; deadlineAt:string;
  detail:string; retryCount:number;
};
type Operation = (slug:string, part:'import'|'release', method:'GET'|'POST', action?:string, input?:Record<string,unknown>)=>Promise<any>;
type Dependencies = {
  dataDir:string; send:(res:ServerResponse,status:number,value:unknown)=>void;
  body:(req:IncomingMessage)=>Promise<Record<string,unknown>>;
  enabled?:boolean; operate?:Operation; now?:()=>number;
};
const FILENAME='publication-jobs.json';
const TERMINAL=new Set<Phase>(['completed','attention','failed']);
const ACTIVE_MS=22*60_000;
let busy=false;
let monitorStarted=false;
function isSha(v:unknown):v is string{return typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);}
function readJobs(dir:string):Publication[]{
 const path=join(dir,FILENAME);
 if(!existsSync(path))return [];
 const raw:unknown=JSON.parse(readFileSync(path,'utf8'));
 if(!Array.isArray(raw)||raw.length>50||!raw.every((j:any)=>
    j&&typeof j==='object'&&typeof j.id==='string'&&validSlug(j.slug)&&
    typeof j.repository==='string'&&Number.isSafeInteger(j.runId)&&
    typeof j.phase==='string'&&['queued','importing','staging','health','promoting','completed','attention','failed'].includes(j.phase)&&
    (j.revision===null||isSha(j.revision))&&typeof j.createdAt==='string'&&typeof j.updatedAt==='string'&&
    typeof j.deadlineAt==='string'&&typeof j.detail==='string'&&Number.isInteger(j.retryCount)))
    throw new Error('Arquivo de publicações inválido. Corrija o estado antes de executar operações.');
 return raw as Publication[];
}
function store(dir:string,items:Publication[]):void{
 const path=join(dir,FILENAME),tmp=path+'.'+process.pid+'.tmp';
 writeFileSync(tmp,JSON.stringify(items.slice(-50),null,2)+'\n',{mode:0o600});
 renameSync(tmp,path);
}
function record(dir:string,job:Publication,now:number):Publication{
 job.updatedAt=new Date(now).toISOString();
 const jobs=readJobs(dir),index=jobs.findIndex(item=>item.id===job.id);
 if(index<0)throw new Error('Publicação desapareceu do histórico.');
 jobs[index]=job;store(dir,jobs);
 return job;
}
function move(dir:string,job:Publication,phase:Phase,detail:string,now:number):Publication{
 job.phase=phase;job.detail=detail;
 return record(dir,job,now);
}
async function productionOperation(slug:string,part:'import'|'release',method:'GET'|'POST',action='',input:Record<string,unknown>={}):Promise<any>{
 const url='/projects/'+slug+(part==='import'?'/images/import':'/releases'+(action?'/'+action:''));
 let output:{status:number;value:any}|undefined;
 const deps={
  dataDir:process.env.PANEL_DATA_DIR||'/data',
  send:(_res:ServerResponse,status:number,value:unknown)=>{output={status,value};},
  body:async()=>input
 };
 const handled=part==='import'?
  await handleImageImportRoute({url,method} as IncomingMessage,{} as ServerResponse,deps):
  await handleReleaseRoute({url,method} as IncomingMessage,{} as ServerResponse,deps);
 if(!handled||!output)throw new Error('Operação interna sem resposta.');
 if(output.status<200||output.status>=300)
  throw new Error(typeof output.value?.error==='string'?output.value.error:'Operação na VPS não foi concluída.');
 return output.value;
}
function matchesImport(dataDir:string,job:Publication):string|null{
 const entry=readImports(dataDir).find(x=>x.slug===job.slug&&x.repository===job.repository&&x.runId===job.runId);
 return entry&&isSha(entry.revision)?entry.revision:null;
}
export async function publicationStep(dir:string,job:Publication,operation:Operation=productionOperation,now=Date.now()):Promise<Publication>{
 const deadline=Date.parse(job.deadlineAt);
 if(!Number.isFinite(deadline)||now>deadline)
  return move(dir,job,'attention','Prazo esgotado. Verifique imagem e containers antes de tentar novamente.',now);
 const active=readJobs(dir).find(x=>x.id===job.id);
 if(!active||active.phase!==job.phase)return job;
 try{
  if(job.phase==='queued'){
   const release=await operation(job.slug,'release','GET');
   const imports=await operation(job.slug,'import','GET');
   if(!release.enabled||!imports.enabled)throw new Error('Habilite importação GHCR e publicação de releases na VPS.');
   if(release.backup||release.candidate||release.current?.state!=='running')
    throw new Error('Resolva a publicação pendente e deixe a versão atual funcionando antes de começar.');
   const cached=matchesImport(dir,job);
   if(cached){
    job.revision=cached;
    return move(dir,job,'staging','Imagem já importada; preparando candidata.',now);
   }
   move(dir,job,'importing','Baixando imagem GHCR aprovada pelo GitHub.',now);
   const result=await operation(job.slug,'import','POST','',{runId:job.runId});
   if(!isSha(result.revision))throw new Error('Importação não confirmou o commit.');
   job.revision=result.revision;
   return record(dir,job,now);
  }
  if(job.phase==='importing'){
   const cached=matchesImport(dir,job);
   if(cached){
    if(job.revision&&cached!==job.revision)throw new Error('Commit da imagem importada mudou.');
    job.revision=cached;
    return move(dir,job,'staging','Imagem verificada no Docker. Preparando candidata.',now);
   }
   const result=await operation(job.slug,'import','GET');
   if(result.job?.status==='running')return job;
   if(result.job?.status==='error')throw new Error('Importação falhou. Consulte os registros da API.');
   if(job.retryCount>=1)throw new Error('Importação interrompida após reinício. Revise antes de repetir.');
   // After API restart, in-memory GHCR progress can be lost; retry once with the same approved run.
   job.retryCount+=1;record(dir,job,now);
   const restarted=await operation(job.slug,'import','POST','',{runId:job.runId});
   if(!isSha(restarted.revision)||(job.revision&&job.revision!==restarted.revision))
    throw new Error('A revisão retornada mudou durante a importação.');
   job.revision=restarted.revision;
   return record(dir,job,now);
  }
  if(!job.revision)throw new Error('Revisão não foi confirmada pelo GHCR.');
  const release=await operation(job.slug,'release','GET');
  if(!release.enabled)throw new Error('Publicações foram desabilitadas na VPS.');
  const current=release.current;
  const candidate=release.candidate;
  if(current?.revision===job.revision&&current?.state==='running'&&release.backup&&!candidate)
   return move(dir,job,'completed','Publicado e verificado. Backup anterior disponível para rollback.',now);
  if(job.phase==='staging'){
   if(release.backup)throw new Error('Existe backup não resolvido. Confira os slots antes de publicar.');
   if(!candidate){
    if(current?.state!=='running')throw new Error('Aplicação atual não está funcionando.');
    move(dir,job,'health','Candidata iniciada; aguardando teste de saúde.',now);
    await operation(job.slug,'release','POST','stage',{runId:job.runId});
    return job;
   }
   if(candidate.revision!==job.revision)throw new Error('Outra revisão candidata foi encontrada.');
   return move(dir,job,'health','Aguardando o teste de saúde da candidata.',now);
  }
  if(job.phase==='health'){
   if(release.backup||!candidate||candidate.revision!==job.revision)
    throw new Error('Candidata alterada; necessário verificar manualmente.');
   if(candidate.state!=='running'||candidate.health==='unhealthy')
    throw new Error('A candidata não está saudável; a versão atual foi preservada.');
   if(candidate.health==='healthy')
    return move(dir,job,'promoting','Saúde aprovada; pronta para substituir a revisão anterior.',now);
   return job;
  }
  if(job.phase==='promoting'){
   if(release.backup||current?.state!=='running'||!candidate||
     candidate.revision!==job.revision||candidate.health!=='healthy'||candidate.state!=='running')
    throw new Error('Estado não permite promoção automática segura. Verifique a aplicação.');
   // The release module rechecks expectedRevision inside its lock immediately before renaming.
   await operation(job.slug,'release','POST','promote',{expectedRevision:job.revision});
   return move(dir,job,'promoting','Troca solicitada; aguardando confirmação do container ativo.',now);
  }
  return job;
 }catch(error){
  const message=error instanceof Error?error.message:'Falha inesperada.';
  return move(dir,job,'attention','Publicação interrompida: '+message+' Confira o estado antes de repetir.',now);
 }
}
export async function runPublicationCycle(dir:string,operation:Operation=productionOperation,now=Date.now()):Promise<void>{
 if(busy)return;
 busy=true;
 try{
  const active=readJobs(dir).find(j=>!TERMINAL.has(j.phase));
  if(active)await publicationStep(dir,active,operation,now);
 }finally{busy=false;}
}
export function startPublicationWorker(dataDir:string):void{
 if(process.env.PANEL_PUBLICATIONS_ENABLED!=='1'||monitorStarted)return;
 monitorStarted=true;
 const tick=()=>{void runPublicationCycle(dataDir).catch(error=>console.error('Publication worker:',error instanceof Error?error.message:String(error)));};
 const timer=setInterval(tick,3000);timer.unref();
 // A queued/in-flight job is resumed from its persisted state after API restarts.
 setImmediate(tick);
 console.log('Durable publication worker ready; no publication starts until a valid admin request.');
}
export async function handlePublicationRoute(req:IncomingMessage,res:ServerResponse,deps:Dependencies):Promise<boolean>{
 const path=new URL(req.url||'/','http://panel.local').pathname;
 const match=/^\/projects\/([a-z0-9-]+)\/publication$/.exec(path);
 if(!match)return false;
 const slug=match[1];
 const enabled=deps.enabled??process.env.PANEL_PUBLICATIONS_ENABLED==='1';
 const send=(status:number,value:unknown)=>deps.send(res,status,value);
 try{
  if(!validSlug(slug))return send(404,{error:'Nome da aplicação inválido.'}),true;
  const project=readProjects(deps.dataDir).find(x=>x.slug===slug);
  if(!project)return send(404,{error:'Vincule a aplicação a um projeto GitHub primeiro.'}),true;
  if(req.method==='GET'){
   const jobs=readJobs(deps.dataDir).filter(x=>x.slug===slug).reverse().slice(0,10);
   send(200,{enabled,current:jobs[0]||null,history:jobs});
   return true;
  }
  if(req.method!=='POST')return send(405,{error:'Método não permitido.'}),true;
  if(!enabled)return send(403,{error:'Publicação automática ainda não foi habilitada na VPS.'}),true;
  const linked=readRepositories(deps.dataDir).find(x=>x.fullName===project.repository&&x.workflow==='panel-app-build.yml');
  if(!linked)return send(409,{error:'Este projeto não possui um workflow GitHub autorizado.'}),true;
  const input=await deps.body(req);
  if(Object.keys(input).length!==1||!Number.isSafeInteger(input.runId)||Number(input.runId)<1)
   return send(400,{error:'Informe o ID numérico do build do GitHub.'}),true;
  const existing=readJobs(deps.dataDir);
  const runId=Number(input.runId);
  const same=existing.find(j=>j.slug===slug&&j.runId===runId);
  if(same)return send(200,{ok:true,alreadyExists:true,job:same}),true;
  if(existing.some(j=>!TERMINAL.has(j.phase)))
   return send(409,{error:'Outra publicação está em andamento. Consulte seu estado antes de iniciar outra.'}),true;
  const now=deps.now?.()??Date.now();
  const job:Publication={id:randomUUID(),slug,repository:project.repository,runId,revision:null,
   phase:'queued',createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),
   deadlineAt:new Date(now+ACTIVE_MS).toISOString(),detail:'Na fila para validar o build e a imagem.',retryCount:0};
  store(deps.dataDir,[...existing.slice(-49),job]);
  console.log(JSON.stringify({event:'publication_queued',id:job.id,slug,runId}));
  send(202,{ok:true,job});
  return true;
 }catch(error){
  console.error('Publication request:',error instanceof Error?error.message:String(error));
  send(503,{error:'Histórico de publicações indisponível. Nenhuma publicação foi iniciada.'});
  return true;
 }
}
