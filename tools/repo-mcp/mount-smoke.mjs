#!/usr/bin/env node
/**
 * CI-only: prepare synthetic SAC reports outside the code image and verify
 * mounted, read-only MCP routing over HTTP. Never reads production reports.
 */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const MSG='O compilador TypeScript registrou atribuição entre tipos incompatíveis.';
const fixture=(projectId,jobId,sha,filename)=>{
 const finding={tool:'typescript',code:'TS2322',file:filename,line:7,column:12,
  message:MSG,location_verified:true};
 const report={schema_version:2,job_id:jobId,project_id:projectId,
  profile_id:'angular-validation',source_sha:sha,status:'fail',phase:'build',
  exit_code:1,findings:[finding],truncated:false,
  post_status:'not-run',browser_status:'not-run',
  root_cause_verified:false,deployment_authorized:false};
 report.text=[
  'Projeto '+projectId+', commit '+sha+'.',
  'A compilação Angular não foi concluída. Código de saída: 1.',
  'Erro TS2322 no arquivo '+filename+', linha 7, coluna 12. '+MSG,
  'Pré-compilação: aprovada. Pós-compilação e Guardian: não executados porque o build falhou.',
  'Este relatório registra eventos observados e não determina a causa raiz.'
 ].join('\n');
 return {schema_version:1,job_id:jobId,project_id:projectId,
  profile_id:'angular-validation',source_sha:sha,
  status:'fail',static_pipeline_pass:false,browser_pass:false,
  deployment_authorized:false,execution:'sac-build-audit',
  code:'angular-compiler-failed',
  diagnostic:{status:'fail',checks:{
   pre:'pass',build:'fail',post:'unverified',browser:'unverified'}},
  technical_report:report,unknownSecret:'NEVER_EXPORT_CI_SENTINEL'};
};
export async function prepareSyntheticMount({contextDir,fixtureRoot}){
 const registry=JSON.parse(await readFile(join(contextDir,'registry.json'),'utf8'));
 assert.equal(registry.repos.length,4);
 const items=[
  {name:'Data_libray',projectId:'data-library',jobId:'gha-900-1',
   file:'src/audit.ts',sha:'a'.repeat(40)},
  {name:'Terrania',projectId:'terrania',jobId:'gha-901-1',
   file:'src/player.ts',sha:'b'.repeat(40)}
 ];
 const reportsRoot=join(fixtureRoot,'sac-reports');
 await mkdir(reportsRoot,{recursive:true,mode:0o755});
 for(const item of items){
  const target=registry.repos.find(v=>v.name===item.name);
  assert.ok(target);
  assert.equal(Object.hasOwn(target,'reportsPath'),false);
  target.projectId=item.projectId;
  target.reportsPath='/srv/sac-reports/'+item.projectId;
  const path=join(reportsRoot,item.projectId);
  await mkdir(path,{recursive:true,mode:0o755});
  await writeFile(join(path,item.jobId+'.json'),
   JSON.stringify(fixture(item.projectId,item.jobId,item.sha,item.file))+'\n',
   {flag:'wx',mode:0o444});
 }
 const registryFile=join(fixtureRoot,'sac-registry.json');
 await writeFile(registryFile,JSON.stringify(registry)+'\n',{flag:'wx',mode:0o444});
 return {registryFile,reportsRoot};
}
export async function verifySyntheticMount({endpoint,tokenFile}){
 const token=(await readFile(tokenFile,'utf8')).trim();
 assert.ok(token.length>=32);
 let id=10;
 const tool=async(name,args)=>{
  const response=await fetch(endpoint,{method:'POST',headers:{
   authorization:'Bearer '+token,
   accept:'application/json, text/event-stream',
   'content-type':'application/json',
   'mcp-protocol-version':'2025-11-25'},
   body:JSON.stringify({jsonrpc:'2.0',id:id++,method:'tools/call',
    params:{name,arguments:args}})});
  assert.equal(response.status,200);
  const rpc=await response.json();
  assert.equal(rpc.error,undefined);
  const result=rpc.result;
  assert.equal(result.content.length,1);
  return {value:JSON.parse(result.content[0].text),isError:result.isError};
 };
 for(const {repo,jobId,expected} of [
  {repo:'Data_libray',jobId:'gha-900-1',expected:'src/audit.ts'},
  {repo:'Terrania',jobId:'gha-901-1',expected:'src/player.ts'}
 ]){
  const r=await tool('sac_job_report',{repo,jobId});
  assert.equal(r.isError,false);
  assert.equal(r.value.status,'fail');
  assert.equal(r.value.technicalReport.findings[0].file,expected);
  assert.equal(r.value.technicalReport.findings[0].code,'TS2322');
  assert.equal(r.value.technicalReport.post_status,'not-run');
  assert.equal(r.value.readOnly,true);
  assert.equal(JSON.stringify(r.value).includes('NEVER_EXPORT_CI_SENTINEL'),false);
 }
 const wrong=await tool('sac_job_report',{repo:'Terrania',jobId:'gha-900-1'});
 assert.equal(wrong.value.status,'not-recorded');
 const unregistered=await tool('sac_job_report',{repo:'Painel',jobId:'gha-900-1'});
 assert.equal(unregistered.isError,true);
 const traversal=await tool('sac_job_report',{repo:'Terrania',jobId:'../gha-900-1'});
 assert.equal(traversal.isError,true);
 return {ok:true,syntheticReports:2,projectIsolation:true,readOnly:true};
}
const invoked=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(invoked){
 try{
  const [action,a,b]=process.argv.slice(2);
  if(action==='prepare'&&a&&b&&process.argv.length===5){
   const result=await prepareSyntheticMount({contextDir:a,fixtureRoot:b});
   process.stdout.write(JSON.stringify({prepared:true,synthetic:true,readOnly:true})+'\n');
  }else if(action==='verify'&&a&&b&&process.argv.length===5){
   const result=await verifySyntheticMount({endpoint:a,tokenFile:b});
   process.stdout.write(JSON.stringify(result)+'\n');
  }else{throw Error('Invalid synthetic mount test arguments');}
 }catch{
  console.error('SAC_MCP_SYNTHETIC_MOUNT_FAIL');
  process.exitCode=1;
 }
}
