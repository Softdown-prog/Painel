/**
 * SAC report router for the existing read-only multi-repository Code MCP.
 * No broker, SSH, build execution, queue submission or model is involved.
 * Only pre-existing, validated SAC v2 job results are readable.
 */
import {open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve,sep} from 'node:path';

const JOB=/^gha-[0-9]{1,15}-[1-9][0-9]{0,3}$/;
const ID=/^[a-z][a-z0-9-]{0,63}$/;
const SHA=/^[0-9a-f]{40}$/;
const CODE=/^TS[0-9]{4,5}$/;
const FILE=/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.tsx?$/;
const FIELD_NAMES=['tool','code','file','line','column','message','location_verified'];
const REPORT_NAMES=['schema_version','job_id','project_id','profile_id','source_sha',
 'status','phase','exit_code','findings','truncated','post_status',
 'browser_status','root_cause_verified','deployment_authorized','text'];
const MESSAGES=Object.freeze({
 TS2322:'O compilador TypeScript registrou atribuição entre tipos incompatíveis.',
 TS2307:'O compilador TypeScript registrou que não encontrou um módulo.',
 TS2304:'O compilador TypeScript registrou um identificador não encontrado.',
 TS2339:'O compilador TypeScript registrou uma propriedade não reconhecida.'
});
const GENERIC='O compilador Angular registrou um erro TypeScript.';
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).sort().join(',')===keys.slice().sort().join(',');
const bad=()=>{throw Error('Untrusted SAC report');};
const fileName=s=>typeof s==='string'&&s.length<=200&&FILE.test(s)&&
 !s.split('/').some(p=>p==='.'||p==='..'||p==='.git'||p==='node_modules'||
 p==='.env'||p.startsWith('.env.'));

export async function registerSacRoutes(entries,reportsRoot){
 if(!Array.isArray(entries)||entries.length>50||typeof reportsRoot!=='string')bad();
 const root=resolve(reportsRoot);
 const routes=new Map();
 for(const entry of entries){
  if(!object(entry)||!Object.hasOwn(entry,'reportsPath'))continue;
  if(typeof entry.name!=='string'||!/^[A-Za-z0-9_.-]{2,72}$/.test(entry.name)||
    !ID.test(entry.projectId)||typeof entry.reportsPath!=='string'||
    entry.reportsPath!==join(root,entry.projectId))bad();
  const p=resolve(entry.reportsPath);
  if(!p.startsWith(root+sep)||routes.has(entry.name))bad();
  // Reject a symlink in the reports root, its parents or the project directory.
  // Production container must mount the approved tree read-only.
  if(await realpath(root)!==root||await realpath(p)!==p)bad();
  routes.set(entry.name,{projectId:entry.projectId,directory:p});
 }
 return routes;
}

export async function readSacReport(routes,repo,jobId){
 if(typeof repo!=='string'||typeof jobId!=='string'||!JOB.test(jobId))bad();
 const route=routes.get(repo);
 if(!route)throw Error('SAC report route not registered');
 const filename=join(route.directory,jobId+'.json');
 let handle;
 try{handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);}
 catch(e){
  if(e?.code==='ENOENT')return {repo,projectId:route.projectId,jobId,
   status:'not-recorded',readOnly:true};
  throw Error('SAC report not accessible');
 }
 let value;
 try{
  const stat=await handle.stat();
  if(!stat.isFile()||stat.size<2||stat.size>32768)bad();
  const raw=await handle.readFile({encoding:'utf8'});
  value=JSON.parse(raw);
 }catch{bad();}
 finally{await handle.close();}
 if(!object(value)||value.schema_version!==1||value.job_id!==jobId||
   value.project_id!==route.projectId||!ID.test(value.project_id)||
   typeof value.profile_id!=='string'||!ID.test(value.profile_id)||
   typeof value.source_sha!=='string'||!SHA.test(value.source_sha)||
   value.status!=='fail'||value.code!=='angular-compiler-failed'||
   value.execution!=='sac-build-audit'||
   value.static_pipeline_pass!==false||value.browser_pass!==false||
   value.deployment_authorized!==false||
   !object(value.diagnostic)||value.diagnostic.status!=='fail'||
   !exact(value.diagnostic.checks,['pre','build','post','browser'])||
   value.diagnostic.checks.pre!=='pass'||
   value.diagnostic.checks.build!=='fail'||
   value.diagnostic.checks.post!=='unverified'||
   value.diagnostic.checks.browser!=='unverified')bad();
 const report=value.technical_report;
 if(!exact(report,REPORT_NAMES)||report.schema_version!==2||
   report.job_id!==jobId||report.project_id!==value.project_id||
   report.profile_id!==value.profile_id||report.source_sha!==value.source_sha||
   report.status!=='fail'||report.phase!=='build'||
   !Number.isSafeInteger(report.exit_code)||report.exit_code<1||report.exit_code>255||
   !Array.isArray(report.findings)||report.findings.length<1||report.findings.length>4||
   typeof report.truncated!=='boolean'||report.post_status!=='not-run'||
   report.browser_status!=='not-run'||report.root_cause_verified!==false||
   report.deployment_authorized!==false||typeof report.text!=='string'||
   JSON.stringify(report).length>4096)bad();
 const lines=[
  'Projeto '+report.project_id+', commit '+report.source_sha+'.',
  'A compilação Angular não foi concluída. Código de saída: '+report.exit_code+'.'
 ];
 const findings=[];
 for(const f of report.findings){
  if(!exact(f,FIELD_NAMES)||f.tool!=='typescript'||typeof f.code!=='string'||
     !CODE.test(f.code)||f.message!==(MESSAGES[f.code]??GENERIC)||
     typeof f.location_verified!=='boolean')bad();
  let where;
  if(f.location_verified){
   if(!fileName(f.file)||!Number.isSafeInteger(f.line)||f.line<1||f.line>1000000||
     !Number.isSafeInteger(f.column)||f.column<1||f.column>10000)bad();
   where=' no arquivo '+f.file+', linha '+f.line+', coluna '+f.column;
  }else{
   if(f.file!==null||f.line!==null||f.column!==null)bad();
   where=' (arquivo e posição não confirmados)';
  }
  lines.push('Erro '+f.code+where+'. '+f.message);
  findings.push(Object.fromEntries(FIELD_NAMES.map(k=>[k,f[k]])));
 }
 if(report.truncated)lines.push('Existem outras ocorrências omitidas pelo limite do coletor.');
 lines.push('Pré-compilação: aprovada. Pós-compilação e Guardian: não executados porque o build falhou.');
 lines.push('Este relatório registra eventos observados e não determina a causa raiz.');
 if(report.text!==lines.join('\n'))bad();
 return {
  repo,projectId:route.projectId,jobId,sourceSha:value.source_sha,
  status:'fail',code:'angular-compiler-failed',
  technicalReport:{
   schema_version:2,phase:'build',exit_code:report.exit_code,
   findings,truncated:report.truncated,post_status:'not-run',
   browser_status:'not-run',text:lines.join('\n'),
   root_cause_verified:false,deployment_authorized:false
  },
  readOnly:true
 };
}
