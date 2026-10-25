import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { revisionReport, handleRevisionRoute } from './revision-maintenance.ts';
const now=Date.parse('2026-10-25T14:00:00.000Z');
const days=d=>new Date(now-d*86400000).toISOString();
const imageId=n=>'sha256:'+String(n).repeat(64);
const digest=n=>'sha256:'+String(n).repeat(64);
const record=(num,age,slug='loja')=>({slug,repository:'Softdown-prog/shop',revision:String(num).repeat(40),
 digest:digest(num),imageId:imageId(num),runId:num,importedAt:days(age)});
function env(){
 const dir=mkdtempSync(join(tmpdir(),'revisions-'));
 const items=[record(1,110),record(2,80),record(3,40),record(4,4),record(5,1)];
 const deleted=[];
 const usedImage=imageId(2);
 writeFileSync(join(dir,'image-imports.json'),JSON.stringify(items));
 const docker=async(path,method='GET')=>{
  const response=(status,data)=>({status,buffer:Buffer.from(JSON.stringify(data))});
  if(path==='/images/json')return response(200,[
   {Id:imageId(1),RepoTags:['ghcr.io/softdown-prog/shop:sha-old'],Size:120000000,Created:1725000000},
   {Id:imageId(2),RepoTags:['ghcr.io/softdown-prog/shop:sha-current'],Size:130000000,Created:1726000000},
   {Id:imageId(3),RepoTags:[],Size:20000000,Created:1724000000}
  ]);
  if(path==='/containers/json?all=1')return response(200,[{
   ImageID:usedImage,Names:['/softload-backup-loja'],
   Labels:{'com.softload.panel.managed':'true','com.softload.panel.slug':'loja'}
  }]);
  const match=/^\/images\/([^?]+?)(?:\/json|\?force=0&noprune=1)$/.exec(path);
  if(!match)return response(404,{error:'missing'});
  const ref=decodeURIComponent(match[1]);
  const item=items.find(x=>'ghcr.io/'+x.repository.toLowerCase()+'@'+x.digest===ref);
  if(!item)return response(404,{});
  if(method==='DELETE'){deleted.push(ref);return response(200,[{Untagged:ref}]);}
  return response(200,{Id:item.imageId,Size:120000000,RepoDigests:[ref]});
 };
 function destroy(){rmSync(dir,{force:true,recursive:true});}
 return {dir,items,docker,deleted,destroy};
}
test('report retains running rollback, last 2 per application and recent images',async()=>{
 const x=env();
 try{
  const plan=await revisionReport(x.dir,x.docker,now);
  assert.equal(plan.totalImports,5);
  assert.equal(plan.oldCount,2);
  assert.equal(plan.hostInventory.total,3);
  assert.equal(plan.hostInventory.untagged,1);
  assert.equal(plan.hostInventory.multipleVersionRepositories[0].versions,2);
  assert.equal(plan.entries.find(e=>e.revision==='2'.repeat(40)).status,'reserva');
  assert.equal(plan.entries.find(e=>e.revision==='4'.repeat(40)).status,'recente');
  assert.equal(plan.entries.find(e=>e.revision==='5'.repeat(40)).status,'recente');
  assert.equal(plan.oldBytesEstimate,240000000);
  assert.equal(x.deleted.length,0);
 }finally{x.destroy();}
});
test('manual cleanup requires explicit opt-in and confirmation, records counts and preserves backups',async()=>{
 const x=env();
 try{
  let response;
  async function call(enabled,bodyValue) {
   response=undefined;
   await handleRevisionRoute({url:'/maintenance/revisions/cleanup',method:'POST'}, {}, {
    enabled,dataDir:x.dir,docker:x.docker,now:()=>now,
    body:async()=>bodyValue,send(_res,status,value){response={status,...value};}
   });
   return response;
  }
  assert.equal((await call(false,{confirm:'LIMPAR_REVISOES_ANTIGAS'})).status,403);
  assert.equal((await call(true,{confirm:'wrong'})).status,400);
  assert.equal(x.deleted.length,0);
  const result=await call(true,{confirm:'LIMPAR_REVISOES_ANTIGAS'});
  assert.equal(result.status,200);
  assert.equal(result.removed,2);
  assert.equal(result.failed,0);
  assert.equal(x.deleted.length,2);
  assert.ok(x.deleted.every(ref=>!ref.includes('sha256:'+ '2'.repeat(64))));
  const remaining=JSON.parse(readFileSync(join(x.dir,'image-imports.json'),'utf8'));
  assert.equal(remaining.length,3);
  const history=JSON.parse(readFileSync(join(x.dir,'revision-cleanup-history.json'),'utf8'));
  assert.equal(history.length,1);assert.equal(history[0].source,'manual');
 }finally{x.destroy();}
});
test('report blocks cleanup when image metadata differs from verified import record',async()=>{
 const x=env();
 try{
  const fake=async(path,method)=>{
   const value=await x.docker(path,method);
   if(path.includes('/images/')&&method!=='DELETE'){
    const image=JSON.parse(value.buffer.toString('utf8'));
    image.Id=imageId(9);
    return {status:200,buffer:Buffer.from(JSON.stringify(image))};
   }
   return value;
  };
  await assert.rejects(revisionReport(x.dir,fake,now),/imagem não corresponde/i);
  assert.equal(x.deleted.length,0);
 }finally{x.destroy();}
});
test('shared image remains protected if it is retained by any application',async()=>{
 const x=env();
 try{
  x.items.push({...record(1,1,'outra'),imageId:imageId(1)});
  writeFileSync(join(x.dir,'image-imports.json'),JSON.stringify(x.items));
  const report=await revisionReport(x.dir,x.docker,now);
  assert.equal(report.entries.find(e=>e.slug==='loja'&&e.revision==='1'.repeat(40)).status,'reserva');
  assert.equal(report.oldCount,1);
  assert.equal(x.deleted.length,0);
 }finally{x.destroy();}
});

test('scheduled cleanup can be activated and paused by the administrator without deleting images',async()=>{
 const x=env();
 try{
  let returned;
  const call=async automatic=>{
   await handleRevisionRoute({url:'/maintenance/revisions/settings',method:'POST'}, {},{
    enabled:true,dataDir:x.dir,docker:x.docker,now:()=>now,body:async()=>({automatic}),
    send(_res,status,data){returned={status,...data};}
   });
   return returned;
  };
  assert.equal((await call(true)).automatic,true);
  assert.equal((await revisionReport(x.dir,x.docker,now)).automatic,true);
  assert.equal((await call(false)).automatic,false);
  assert.equal((await revisionReport(x.dir,x.docker,now)).automatic,false);
  assert.equal(x.deleted.length,0);
 }finally{x.destroy();}
});
test('read-only Docker-wide inventory remains optional if host image listing is unavailable',async()=>{
 const x=env();
 try{
  const docker=async(path,method)=>{
   if(path==='/images/json')return {status:503,buffer:Buffer.from('{}')};
   return x.docker(path,method);
  };
  const report=await revisionReport(x.dir,docker,now);
  assert.equal(report.hostInventory.available,false);
  assert.equal(report.oldCount,2);
  assert.equal(x.deleted.length,0);
 }finally{x.destroy();}
});

test('cleanup does not delete a digest if a new import arrives after the inventory snapshot',async()=>{
 const x=env();
 try{
  let modified=false;
  const docker=async(path,method)=>{
   const result=await x.docker(path,method);
   if(path.startsWith('/images/')&&path.endsWith('/json')&&!modified){
    modified=true;
    const newer=record(1,0,'outro-cliente');
    writeFileSync(join(x.dir,'image-imports.json'),JSON.stringify([...x.items,newer]));
   }
   return result;
  };
  let received;
  await handleRevisionRoute({url:'/maintenance/revisions/cleanup',method:'POST'}, {}, {
   enabled:true,dataDir:x.dir,docker,now:()=>now,
   body:async()=>({confirm:'LIMPAR_REVISOES_ANTIGAS'}),
   send(_res,status,data){received={status,...data};}
  });
  assert.equal(received.status,200);
  assert.equal(received.failed,1,'The concurrently reused digest must not be deleted');
  assert.ok(!x.deleted.some(ref=>ref.endsWith('1'.repeat(64))));
  const data=JSON.parse(readFileSync(join(x.dir,'image-imports.json'),'utf8'));
  assert.ok(data.some(r=>r.slug==='outro-cliente'));
 }finally{x.destroy();}
});
