import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dockerRequest, type DockerRequest } from './apps.ts';
import { readImports } from './image-import.ts';

type Import = ReturnType<typeof readImports>[number];
type Image = { Id?: string; Size?: number; RepoDigests?: string[] };
type Container = { Id?: string; ImageID?: string; Names?: string[]; Labels?: Record<string,string>; State?: string };
type Entry = Import & { ref: string; sizeBytes: number; status: 'em_uso'|'reserva'|'recente'|'protegida'|'antiga'|'ausente'; reason: string };
type Report = { checkedAt: string; enabled: boolean; automatic: boolean; ageDays: number; keepPerApp: number; totalImports: number; oldCount: number; oldBytesEstimate: number; entries: Entry[]; history: History[]; lastResult: History | null; hostInventory: HostInventory };
type History = { at: string; source: 'manual'|'automatic'; considered: number; removed: number; failed: number; bytesEstimate: number; message: string };
type HostImage = { Id?:string; RepoTags?:string[]; RepoDigests?:string[]; Size?:number; Created?:number; Containers?:number };
type HostInventory = { available:boolean; total:number; totalBytesEstimate:number; untagged:number;
 multipleVersionRepositories:{repository:string;versions:number}[]; images:{id:string;tags:string[];sizeBytes:number;createdAt:string|null;containers:number|null}[] };

type Deps = {
 dataDir: string;
 send: (res: ServerResponse,status:number,value:unknown)=>void;
 body: (req: IncomingMessage)=>Promise<Record<string,unknown>>;
 docker?: DockerRequest;
 now?: ()=>number;
 enabled?: boolean;
 automatic?: boolean;
};
const REPO_OWNER = (process.env.PANEL_GHCR_ALLOWED_OWNER || 'Softdown-prog').toLowerCase();
const MAX_IMPORTS = 300;
const KEEP = 2; // Last two imports per app are always retained.
const DAYS = 14; // Do not remove very recent images, even on a small VPS.
const INTERVAL = 6 * 60 * 60 * 1000;
const DAY = 86400000;
const RECORD_NAME = 'image-imports.json';
const HISTORY_NAME = 'revision-cleanup-history.json';
const SETTINGS_NAME = 'revision-cleanup-settings.json';
let cleaning = false;
class CleanupError extends Error {
 readonly status: number;
 constructor(status:number,message:string){super(message);this.status=status;}
}
function parse<T>(data:Buffer):T{return JSON.parse(data.toString('utf8')) as T;}
function refOf(item:Import):string {return 'ghcr.io/'+item.repository.toLowerCase()+'@'+item.digest;}
function automaticFor(dataDir:string):boolean{
 try{
  const settings:unknown=JSON.parse(readFileSync(join(dataDir,SETTINGS_NAME),'utf8'));
  if(settings && typeof settings==='object' && typeof (settings as {automatic?:unknown}).automatic==='boolean')
   return (settings as {automatic:boolean}).automatic;
 }catch{ /* Default to deploy configuration until changed by an administrator */ }
 return process.env.PANEL_REVISIONS_AUTOMATIC==='1';
}
function histories(dataDir:string):History[]{
 try {
  const content:unknown=JSON.parse(readFileSync(join(dataDir,HISTORY_NAME),'utf8'));
  return Array.isArray(content) ? content.filter((x):x is History=>x&&typeof x==='object'&&typeof x.at==='string'&&Number.isSafeInteger(x.removed)).slice(-25) : [];
 }catch{return [];}
}
function store(dataDir:string,name:string,value:unknown):void{
 const file=join(dataDir,name),tmp=file+'.'+process.pid+'.tmp';
 writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});
 renameSync(tmp,file);
}
function verifiedImports(dataDir:string):Import[]{
 const imported=readImports(dataDir);
 if(imported.length>MAX_IMPORTS)throw new CleanupError(409,'Há registros demais para uma limpeza automática. Revise os dados antes de limpar.');
 return imported;
}
function isManagedContainer(c:Container):boolean {
 const slug=c.Labels?.['com.softload.panel.slug'];
 return c.Labels?.['com.softload.panel.managed']==='true' &&
  typeof slug==='string' &&
  (c.Names||[]).some(n=>['/softload-app-','/softload-backup-','/softload-candidate-'].some(prefix=>n===prefix+slug));
}
function latestKeys(imports:Import[]):Set<string>{
 const groups=new Map<string,Import[]>();
 for(const i of imports){const a=groups.get(i.slug)||[];a.push(i);groups.set(i.slug,a);}
 const keep=new Set<string>();
 for(const [slug,items] of groups){
  items.sort((a,b)=>new Date(b.importedAt).getTime()-new Date(a.importedAt).getTime());
  for(const i of items.slice(0,KEEP))keep.add(slug+'/'+i.revision);
 }
 return keep;
}
async function hostInventory(docker:DockerRequest):Promise<HostInventory>{
 const unavailable:HostInventory={available:false,total:0,totalBytesEstimate:0,untagged:0,multipleVersionRepositories:[],images:[]};
 try{
  const result=await docker('/images/json');
  if(result.status!==200)return unavailable;
  const raw=parse<HostImage[]>(result.buffer);
  if(!Array.isArray(raw))return unavailable;
  const images=raw.slice(0,250).map(i=>({
   id:String(i.Id||'').slice(0,30),
   tags:Array.isArray(i.RepoTags)?i.RepoTags.filter(x=>x&&x!=='<none>:<none>').slice(0,5):[],
   sizeBytes:Number.isFinite(i.Size)?Math.max(0,i.Size||0):0,
   createdAt:Number.isFinite(i.Created)?new Date((i.Created||0)*1000).toISOString():null,
   containers:Number.isSafeInteger(i.Containers)&&i.Containers!>=0?i.Containers!:null
  }));
  const groups=new Map<string,Set<string>>();
  for(const i of images)for(const tag of i.tags){
   const separator=tag.lastIndexOf(':');
   if(separator<0)continue;
   const repo=tag.slice(0,separator);
   if(!repo)continue;
   const versions=groups.get(repo)||new Set<string>();versions.add(i.id);groups.set(repo,versions);
  }
  const multipleVersionRepositories=[...groups.entries()].filter(([,ids])=>ids.size>1)
    .map(([repository,ids])=>({repository,versions:ids.size}))
    .sort((a,b)=>b.versions-a.versions).slice(0,30);
  return {available:true,total:raw.length,
   totalBytesEstimate:images.reduce((v,i)=>v+i.sizeBytes,0),
   untagged:images.filter(i=>!i.tags.length).length,multipleVersionRepositories,images};
 }catch{return unavailable;}
}

export async function revisionReport(dataDir:string,docker:DockerRequest=dockerRequest,now=Date.now()):Promise<Report>{
 const imported=verifiedImports(dataDir);
 const hostImages=await hostInventory(docker);
 const listResponse=await docker('/containers/json?all=1');
 if(listResponse.status!==200)throw new CleanupError(502,'Não foi possível verificar os containers. Nenhuma limpeza será feita.');
 const containers=parse<Container[]>(listResponse.buffer);
 if(!Array.isArray(containers))throw new CleanupError(502,'Lista do Docker inválida.');
 // The executor returns all panel-managed slots, including the backup and the candidate.
 const owned=containers.filter(isManagedContainer);
 const usedBy=new Map<string,'em_uso'|'reserva'>();
 for(const c of owned){
  if(!c.ImageID)continue;
  const backup=(c.Names||[]).some(name=>name.startsWith('/softload-backup-')||name.startsWith('/softload-candidate-'));
  if(!usedBy.has(c.ImageID)||!backup)usedBy.set(c.ImageID,backup?'reserva':'em_uso');
 }
 const recent=latestKeys(imported);
 const lookedUp=new Map<string,Image|null>();
 const entries:Entry[]=[];
 for(const record of imported){
  if(!record.repository.toLowerCase().startsWith(REPO_OWNER+'/'))continue;
  const ref=refOf(record);
  if(!lookedUp.has(ref)){
   const response=await docker('/images/'+encodeURIComponent(ref)+'/json');
   if(response.status===404)lookedUp.set(ref,null);
   else if(response.status!==200)throw new CleanupError(502,'Não foi possível conferir todas as imagens; limpeza interrompida.');
   else {
    const image=parse<Image>(response.buffer);
    if(image.Id!==record.imageId || !image.RepoDigests?.includes(ref))
      throw new CleanupError(409,'Uma imagem não corresponde ao registro de importação; revisão manual necessária.');
    lookedUp.set(ref,image);
   }
  }
  const image=lookedUp.get(ref);
  let status:Entry['status']='antiga',reason='Importação antiga, sem container ligado.';
  const importedAt=Date.parse(record.importedAt);
  if(!Number.isFinite(importedAt) || importedAt>now+DAY){
   status='protegida';reason='Data de importação inválida ou futura.';
  }else if(!image){status='ausente';reason='Registro presente, mas imagem não encontrada no Docker.';}
  else if(usedBy.has(record.imageId)){
   status=usedBy.get(record.imageId)!;
   reason=status==='reserva'?'Imagem guardada para rollback ou teste da próxima versão.':'Esta imagem está associada ao container principal.';
  }
  else if(recent.has(record.slug+'/'+record.revision)){status='recente';reason='Entre as duas últimas revisões preservadas desta aplicação.';}
  else if(now-importedAt<DAYS*DAY){status='recente';reason='Importada há menos de 14 dias.';}
  entries.push({...record,ref,sizeBytes:image?.Size||0,status,reason});
 }
 // A shared image must never be removed if any import record preserves it.
 const protectedIds=new Set(entries.filter(e=>e.status!=='antiga').map(e=>e.imageId));
 for(const entry of entries){
  if(entry.status==='antiga' && protectedIds.has(entry.imageId)){
   entry.status='reserva';entry.reason='Imagem compartilhada com outra revisão que deve ser mantida.';
  }
 }
 const stale=entries.filter(e=>e.status==='antiga');
 const oldRefs=new Map(stale.map(e=>[e.ref,e]));
 const history=histories(dataDir);
 return {checkedAt:new Date(now).toISOString(),enabled:process.env.PANEL_REVISIONS_CLEANUP_ENABLED==='1',
   automatic:automaticFor(dataDir),ageDays:DAYS,keepPerApp:KEEP,
   totalImports:entries.length,oldCount:oldRefs.size,
   oldBytesEstimate:[...oldRefs.values()].reduce((sum,e)=>sum+e.sizeBytes,0),
   entries:entries.slice().sort((a,b)=>Date.parse(b.importedAt)-Date.parse(a.importedAt)),
   history,lastResult:history.at(-1)||null,hostInventory:hostImages};
}
async function perform(dataDir:string,docker:DockerRequest,now:number,source:'manual'|'automatic'):Promise<History>{
 if(cleaning)throw new CleanupError(409,'Uma limpeza já está em andamento.');
 cleaning=true;
 try{
  const plan=await revisionReport(dataDir,docker,now);
  const targets=new Map(plan.entries.filter(e=>e.status==='antiga').map(e=>[e.ref,e]));
  let removed=0,failed=0,bytesEstimate=0;
  const removedRefs=new Set<string>();
  for(const [ref,entry] of targets){
   // Docker's executor independently checks ALL host containers and refuses force deletes.
   const result=await docker('/images/'+encodeURIComponent(ref)+'?force=0&noprune=1','DELETE');
   if(result.status>=200 && result.status<300){removedRefs.add(ref);removed++;bytesEstimate+=entry.sizeBytes;}
   else failed++;
  }
  if(removedRefs.size){
   // Re-read to avoid dropping unrelated new imports; retain the most recent record for each app.
   const current=verifiedImports(dataDir);
   const remaining=current.filter(e=>!removedRefs.has(refOf(e)));
   store(dataDir,RECORD_NAME,remaining);
  }
  const outcome:History={at:new Date(now).toISOString(),source,considered:targets.size,removed,failed,bytesEstimate,
    message:failed?'Algumas imagens não foram removidas. Revise os registros.':'Limpeza concluída sem apagar containers ou volumes.'};
  const history=[...histories(dataDir),outcome].slice(-25);
  store(dataDir,HISTORY_NAME,history);
  console.log(JSON.stringify({event:'panel_revision_cleanup',...outcome}));
  return outcome;
 } finally{cleaning=false;}
}
export async function handleRevisionRoute(req:IncomingMessage,res:ServerResponse,deps:Deps):Promise<boolean>{
 const path=new URL(req.url||'/','http://panel.local').pathname;
 if(!['/maintenance/revisions','/maintenance/revisions/cleanup','/maintenance/revisions/settings'].includes(path))return false;
 const send=(status:number,value:unknown)=>deps.send(res,status,value);
 const docker=deps.docker||dockerRequest,now=deps.now?.()||Date.now();
 try{
  if(path==='/maintenance/revisions'&&req.method==='GET'){
   const report=await revisionReport(deps.dataDir,docker,now);
   send(200,{...report,enabled:deps.enabled ?? report.enabled,automatic:deps.automatic ?? report.automatic});
   return true;
  }
  if(path==='/maintenance/revisions/settings'&&req.method==='POST'){
   if(!(deps.enabled ?? process.env.PANEL_REVISIONS_CLEANUP_ENABLED==='1'))
    throw new CleanupError(403,'A limpeza precisa ser habilitada na configuração do servidor.');
   const input=await deps.body(req);
   if(Object.keys(input).length!==1||typeof input.automatic!=='boolean')
    throw new CleanupError(400,'Informe apenas automatic: true ou false.');
   store(deps.dataDir,SETTINGS_NAME,{automatic:input.automatic,changedAt:new Date(now).toISOString()});
   send(200,{ok:true,automatic:input.automatic,message:input.automatic ?
    'Limpeza programada. A próxima verificação será feita no ciclo de seis horas.' :
    'Limpeza automática pausada. Nenhuma revisão foi apagada nesta operação.'});
   return true;
  }
  if(path==='/maintenance/revisions/cleanup'&&req.method==='POST'){
   if(!(deps.enabled ?? process.env.PANEL_REVISIONS_CLEANUP_ENABLED==='1'))
    throw new CleanupError(403,'Limpeza desativada neste servidor.');
   const input=await deps.body(req);
   if(Object.keys(input).length!==1||input.confirm!=='LIMPAR_REVISOES_ANTIGAS')
    throw new CleanupError(400,'Confirmação necessária para remover revisões antigas.');
   const outcome=await perform(deps.dataDir,docker,now,'manual');
   send(200,{ok:outcome.failed===0,...outcome});
   return true;
  }
  throw new CleanupError(405,'Método não permitido.');
 }catch(error){
  if(error instanceof CleanupError)send(error.status,{error:error.message});
  else{
   console.error('Revision maintenance failed:',error instanceof Error?error.message:String(error));
   send(502,{error:'Falha ao consultar ou limpar revisões. Nenhuma remoção global foi solicitada.'});
  }
  return true;
 }
}
export function startRevisionMonitor(dataDir:string):void {
 // A disabled deployment cannot clean; the timer allows toggling automatic mode without restarting the API.
 if(process.env.PANEL_REVISIONS_CLEANUP_ENABLED!=='1')return;
 const run=async()=>{
  if(!automaticFor(dataDir))return;
  try{await perform(dataDir,dockerRequest,Date.now(),'automatic');}
  catch(error){console.error('Automatic revision cleanup failed:',error instanceof Error?error.message:String(error));}
 };
 const timer=setInterval(()=>{void run();},INTERVAL);
 timer.unref();
 console.log('Revision cleanup monitor ready; checks auto setting every 6 hours and keeps two imports per app.');
}
