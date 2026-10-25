import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlePublicationRoute, runPublicationCycle } from './publications.ts';
const sha='a'.repeat(40);
const other='b'.repeat(40);
const repository='Softdown-prog/shop';
const stamp=Date.parse('2026-10-25T14:00:00Z');
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'panel-durable-publication-'));
 writeFileSync(join(dir,'projects.json'),JSON.stringify([{slug:'demo',repository,connectedAt:new Date(stamp).toISOString()}]));
 writeFileSync(join(dir,'github-repositories.json'),JSON.stringify([{fullName:repository,branch:'main',workflow:'panel-app-build.yml'}]));
 const calls=[];
 const state={
  imported:null,
  revision:other,
  candidate:null,
  backup:null,
  imageJob:null
 };
 async function operation(slug,part,method,action='',input={}){
  calls.push({slug,part,method,action,input});
  if(part==='import'){
   if(method==='GET')return {enabled:true,imported:state.imported,job:state.imageJob};
   state.imported={revision:sha};
   writeFileSync(join(dir,'image-imports.json'),JSON.stringify([{
    slug:'demo',repository,runId:123,revision:sha,importedAt:new Date(stamp).toISOString(),
    digest:'sha256:'+'c'.repeat(64),imageId:'sha256:'+'d'.repeat(64)
   }]));
   return {accepted:true,revision:sha};
  }
  if(method==='GET')return {enabled:true,current:{revision:state.revision,state:'running'},
   candidate:state.candidate,backup:state.backup};
  if(action==='stage'){state.candidate={revision:sha,state:'running',health:'starting'};return {staged:true};}
  if(action==='promote'){
   if(input.expectedRevision!==sha)throw new Error('Expected SHA mismatch');
   state.backup={image:'old'};
   state.candidate=null;
   state.revision=sha;
   return {promoted:true};
  }
  throw new Error('Unexpected operation');
 }
 async function route(method='GET',data={},enabled=true){
  let captured;
  const ok=await handlePublicationRoute({url:'/projects/demo/publication',method},{},{
   dataDir:dir,enabled,now:()=>stamp,body:async()=>data,
   send:(_res,status,value)=>{captured={status,value};}
  });
  assert.equal(ok,true);
  return captured;
 }
 return {dir,route,operation,calls,state,dispose(){rmSync(dir,{force:true,recursive:true});}};
}
test('admin can enqueue once, persisted publication advances without browser and leaves rollback backup',async()=>{
 const x=fixture();
 try{
  assert.equal((await x.route('POST',{runId:123},false)).status,403);
  assert.equal((await x.route('POST',{runId:0})).status,400);
  const created=await x.route('POST',{runId:123});
  assert.equal(created.status,202);
  assert.equal(created.value.job.phase,'queued');
  assert.equal((await x.route('POST',{runId:123})).value.alreadyExists,true);
  assert.equal((await x.route('POST',{runId:124})).status,409);
  for(let i=0;i<4;i++)await runPublicationCycle(x.dir,x.operation,stamp+1000*i);
  assert.equal(x.state.revision,other,'No promotion without passing health check');
  x.state.candidate.health='healthy';
  for(let i=4;i<9;i++)await runPublicationCycle(x.dir,x.operation,stamp+1000*i);
  const status=(await x.route()).value.current;
  assert.equal(status.phase,'completed',status.detail);
  assert.equal(status.revision,sha);
  assert.equal(x.state.revision,sha);
  assert.ok(x.state.backup,'previous container must survive for rollback');
  assert.deepEqual(x.calls.filter(c=>c.method==='POST').map(c=>c.action||'import'),['import','stage','promote']);
  const persisted=JSON.parse(readFileSync(join(x.dir,'publication-jobs.json'),'utf8'));
  assert.equal(persisted.at(-1).phase,'completed');
 }finally{x.dispose();}
});
test('worker safely resumes staging after restart when candidate was already created',async()=>{
 const x=fixture();
 try{
  await x.route('POST',{runId:123});
  await runPublicationCycle(x.dir,x.operation,stamp);
  await runPublicationCycle(x.dir,x.operation,stamp+1000);
  const items=JSON.parse(readFileSync(join(x.dir,'publication-jobs.json'),'utf8'));
  items[0].phase='staging';writeFileSync(join(x.dir,'publication-jobs.json'),JSON.stringify(items));
  x.state.candidate={revision:sha,state:'running',health:'starting'};
  const stageCount=x.calls.filter(c=>c.action==='stage').length;
  await runPublicationCycle(x.dir,x.operation,stamp+2500);
  assert.equal((await x.route()).value.current.phase,'health');
  assert.equal(x.calls.filter(c=>c.action==='stage').length,stageCount,'No duplicate container creation');
 }finally{x.dispose();}
});
test('unhealthy candidate halts safely, with old app untouched',async()=>{
 const x=fixture();
 try{
  await x.route('POST',{runId:123});
  for(let i=0;i<3;i++)await runPublicationCycle(x.dir,x.operation,stamp+i*1000);
  x.state.candidate.health='unhealthy';
  await runPublicationCycle(x.dir,x.operation,stamp+3500);
  const job=(await x.route()).value.current;
  assert.equal(job.phase,'attention');
  assert.equal(x.state.revision,other);
  assert.equal(x.calls.some(c=>c.action==='promote'),false);
 }finally{x.dispose();}
});
test('expired jobs require operator review and never mutate Docker',async()=>{
 const x=fixture();
 try{
  await x.route('POST',{runId:123});
  await runPublicationCycle(x.dir,x.operation,stamp+24*60*60_000);
  assert.equal((await x.route()).value.current.phase,'attention');
  assert.equal(x.calls.length,0);
 }finally{x.dispose();}
});
test('corrupt job store cannot be replaced by a new submission',async()=>{
 const x=fixture();
 try{
  writeFileSync(join(x.dir,'publication-jobs.json'),'{broken');
  assert.equal((await x.route('POST',{runId:123})).status,503);
  assert.equal(readFileSync(join(x.dir,'publication-jobs.json'),'utf8'),'{broken');
 }finally{x.dispose();}
});
