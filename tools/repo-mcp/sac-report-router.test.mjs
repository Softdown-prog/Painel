import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMcpHttpServer} from './http-server.mjs';

const message='O compilador TypeScript registrou atribuição entre tipos incompatíveis.';
function sample(projectId,jobId,sha,filename){
 const finding={tool:'typescript',code:'TS2322',file:filename,line:7,
  column:12,message,location_verified:true};
 const report={schema_version:2,job_id:jobId,project_id:projectId,
  profile_id:'angular-validation',source_sha:sha,status:'fail',phase:'build',
  exit_code:1,findings:[finding],truncated:false,post_status:'not-run',
  browser_status:'not-run',root_cause_verified:false,
  deployment_authorized:false};
 report.text=[
  'Projeto '+projectId+', commit '+sha+'.',
  'A compilação Angular não foi concluída. Código de saída: 1.',
  'Erro TS2322 no arquivo '+filename+', linha 7, coluna 12. '+message,
  'Pré-compilação: aprovada. Pós-compilação e Guardian: não executados porque o build falhou.',
  'Este relatório registra eventos observados e não determina a causa raiz.'
 ].join('\n');
 return {schema_version:1,job_id:jobId,project_id:projectId,
  profile_id:'angular-validation',source_sha:sha,status:'fail',
  static_pipeline_pass:false,browser_pass:false,deployment_authorized:false,
  execution:'sac-build-audit',code:'angular-compiler-failed',
  diagnostic:{status:'fail',checks:{pre:'pass',build:'fail',post:'unverified',browser:'unverified'}},
  technical_report:report,unusedRawSecret:'DO_NOT_EXPORT_SECRET'};
}
async function fixture(){
 const temp=await mkdtemp(join(tmpdir(),'sac-mcp-router-'));
 const repos=join(temp,'repos'),reports=join(temp,'reports');
 const entries=[];
 for(const [repo,project] of [['Data_libray','data-library'],['Terrania','terrania']]){
  const source=join(repos,repo),reportDir=join(reports,project);
  await mkdir(source,{recursive:true});await mkdir(reportDir,{recursive:true});
  await writeFile(join(source,'index.ts'),'export function '+(repo==='Terrania'?'Terrania':'DataLibrary')+'(){}\n');
  entries.push({name:repo,path:source,projectId:project,reportsPath:reportDir});
 }
 const token='synthetic-mcp-router-token-at-least-32-characters';
 const tokenFile=join(temp,'token'),registryFile=join(temp,'registry.json');
 await writeFile(tokenFile,token);
 await writeFile(registryFile,JSON.stringify({repos:entries}));
 const first=sample('data-library','gha-900-1','a'.repeat(40),'src/audit.ts');
 const second=sample('terrania','gha-901-1','b'.repeat(40),'src/player.ts');
 await writeFile(join(reports,'data-library','gha-900-1.json'),JSON.stringify(first));
 await writeFile(join(reports,'terrania','gha-901-1.json'),JSON.stringify(second));
 return {temp,repos,reports,entries,token,tokenFile,registryFile,first,second};
}
async function request(base,token,id,name,args){
 const response=await fetch(base+'/mcp',{method:'POST',headers:{
  authorization:'Bearer '+token,accept:'application/json, text/event-stream',
  'content-type':'application/json','mcp-protocol-version':'2025-11-25'},
  body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',
   params:{name,arguments:args}})});
 assert.equal(response.status,200);
 const body=await response.json();
 assert.ok(body.result?.content?.[0]?.text);
 return {data:JSON.parse(body.result.content[0].text),error:body.result.isError};
}
test('MCP routes existing SAC reports to their own project without any broker',async()=>{
 const f=await fixture();let mcp;
 try{
  mcp=await createMcpHttpServer({registryFile:f.registryFile,tokenFile:f.tokenFile,
   repoRoot:f.repos,reportsRoot:f.reports,port:0});
  const {port}=await mcp.start(),base='http://127.0.0.1:'+port;
  const names=await request(base,f.token,1,'repo_list',{});
  assert.deepEqual(names.data,['Data_libray','Terrania']);
  const list=await fetch(base+'/mcp',{method:'POST',headers:{
   authorization:'Bearer '+f.token,accept:'application/json, text/event-stream',
   'content-type':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})});
  assert.ok((await list.json()).result.tools.some(x=>x.name==='sac_job_report'));
  const a=await request(base,f.token,3,'sac_job_report',
   {repo:'Data_libray',jobId:'gha-900-1'});
  const b=await request(base,f.token,4,'sac_job_report',
   {repo:'Terrania',jobId:'gha-901-1'});
  assert.equal(a.error,false);assert.equal(b.error,false);
  assert.equal(a.data.technicalReport.findings[0].file,'src/audit.ts');
  assert.equal(b.data.technicalReport.findings[0].file,'src/player.ts');
  assert.equal(a.data.sourceSha,'a'.repeat(40));
  assert.equal(b.data.sourceSha,'b'.repeat(40));
  assert.equal(a.data.technicalReport.post_status,'not-run');
  assert.equal(a.data.readOnly,true);
  assert.equal(JSON.stringify(a.data).includes('DO_NOT_EXPORT_SECRET'),false);
  const absent=await request(base,f.token,5,'sac_job_report',
   {repo:'Terrania',jobId:'gha-900-1'});
  assert.equal(absent.data.status,'not-recorded');
  const unknown=await request(base,f.token,6,'sac_job_report',
   {repo:'Painel',jobId:'gha-900-1'});
  assert.equal(unknown.error,true);
  const traversal=await request(base,f.token,7,'sac_job_report',
   {repo:'Data_libray',jobId:'../gha-901-1'});
  assert.equal(traversal.error,true);
  assert.equal((await fetch(base+'/mcp')).status,401);
 }finally{if(mcp)await mcp.close();await rm(f.temp,{recursive:true,force:true});}
});
test('inconsistent/malicious reports and symlink files are denied, not published',async()=>{
 const f=await fixture();let mcp;
 try{
  mcp=await createMcpHttpServer({registryFile:f.registryFile,tokenFile:f.tokenFile,
   repoRoot:f.repos,reportsRoot:f.reports,port:0});
  const base='http://127.0.0.1:'+(await mcp.start()).port;
  const filename=join(f.reports,'data-library','gha-900-1.json');
  const variants=[
   {...f.first,technical_report:{...f.first.technical_report,text:'approved SECRET'}},
   {...f.first,status:'pass'},
   {...f.first,project_id:'terrania'},
   {...f.first,technical_report:{...f.first.technical_report,
     findings:[{...f.first.technical_report.findings[0],file:'../secret.ts'}]}},
   {...f.first,technical_report:{...f.first.technical_report,
     findings:[{...f.first.technical_report.findings[0],message:'SECRET'}]}}
  ];
  for(const obj of variants){
   await writeFile(filename,JSON.stringify(obj));
   const result=await request(base,f.token,1,'sac_job_report',
    {repo:'Data_libray',jobId:'gha-900-1'});
   assert.equal(result.error,true);
   assert.equal(JSON.stringify(result.data).includes('SECRET'),false);
  }
  await rm(filename);await symlink(join(f.reports,'terrania','gha-901-1.json'),filename);
  const linked=await request(base,f.token,2,'sac_job_report',
   {repo:'Data_libray',jobId:'gha-900-1'});
  assert.equal(linked.error,true);
 }finally{if(mcp)await mcp.close();await rm(f.temp,{recursive:true,force:true});}
});
test('registry never accepts paths outside the operator mounted report root',async()=>{
 const f=await fixture();
 try{
  const variants=[
   [{...f.entries[0],reportsPath:'/etc'},{...f.entries[1]}],
   [{...f.entries[0],projectId:'../other'},{...f.entries[1]}],
   [{...f.entries[0],reportsPath:join(f.reports,'terrania')},{...f.entries[1]}],
  ];
  for(const repos of variants){
   await writeFile(f.registryFile,JSON.stringify({repos}));
   await assert.rejects(createMcpHttpServer({registryFile:f.registryFile,
    tokenFile:f.tokenFile,repoRoot:f.repos,reportsRoot:f.reports,port:0}));
  }
  // The source tree and SAC results are distinct; no source writing is possible.
  assert.match(await readFile(join(f.repos,'Terrania','index.ts'),'utf8'),/Terrania/);
 }finally{await rm(f.temp,{recursive:true,force:true});}
});
test('legacy code-index routes do not require SAC report mounts',async()=>{
 const f=await fixture();let mcp;
 try{
  const registry={repos:f.entries.map(({name,path})=>({name,path}))};
  await writeFile(f.registryFile,JSON.stringify(registry));
  mcp=await createMcpHttpServer({registryFile:f.registryFile,tokenFile:f.tokenFile,
   repoRoot:f.repos,port:0});
  const base='http://127.0.0.1:'+(await mcp.start()).port;
  const stats=await request(base,f.token,1,'repo_stats',{repo:'Data_libray'});
  assert.equal(stats.error,false);
  const missing=await request(base,f.token,2,'sac_job_report',
    {repo:'Data_libray',jobId:'gha-900-1'});
  assert.equal(missing.error,true);
 }finally{if(mcp)await mcp.close();await rm(f.temp,{recursive:true,force:true});}
});
