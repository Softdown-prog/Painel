import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSecretsRoute } from './secrets.ts';

function fixture() {
 const root=mkdtempSync(join(tmpdir(),'panel-keys-test-'));
 chmodSync(root,0o700);
 const events=[];
 const deps={directory:root,enabled:true,verifyPassword:p=>p==='correct-admin-password',
  body:async()=>({}),send(_res,status,data){events.push({status,data});}};
 async function run(method,path='/secrets',data={}) {
  events.length=0;
  const matched=await handleSecretsRoute({method,url:path},{}, {...deps,body:async()=>data});
  assert.equal(matched,true);
  return events[0];
 }
 const key={name:'gemini-api-key',label:'Gemini para Solaris',category:'sistema',
  value:'test-value-secret-012345',password:'correct-admin-password'};
 return {root,run,key,dispose:()=>rmSync(root,{force:true,recursive:true})};
}
test('disabled key manager refuses writes and reveals no secrets',async()=>{
 const root=mkdtempSync(join(tmpdir(),'panel-disabled-secrets-'));
 try{
  let result;
  const yes=await handleSecretsRoute({method:'GET',url:'/secrets'},{},{enabled:false,directory:root,
   verifyPassword:()=>true,body:async()=>({}),send(_res,status,data){result={status,data};}});
  assert.equal(yes,true);
  assert.equal(result.data.enabled,false);
  assert.deepEqual(result.data.entries,[]);
  assert.equal(readFileSync===undefined,false);
 }finally{rmSync(root,{force:true,recursive:true});}
});
test('API credentials are written only to private files and listing never echoes a value',async()=>{
 const x=fixture();
 try{
  const r=await x.run('POST','/secrets',x.key);
  assert.equal(r.status,201);
  assert.equal(readFileSync(join(x.root,x.key.name),'utf8'),x.key.value);
  assert.equal(lstatSync(join(x.root,x.key.name)).mode&0o777,0o600);
  const listing=await x.run('GET');
  assert.equal(listing.status,200);
  assert.equal(listing.data.entries.length,1);
  assert.equal(listing.data.entries[0].label,x.key.label);
  assert.ok(!JSON.stringify(listing).includes(x.key.value));
  assert.ok(!readFileSync(join(x.root,'.panel-secret-index.json'),'utf8').includes(x.key.value));
  const replaced=await x.run('POST','/secrets',{...x.key,value:'replacement-token-9876'});
  assert.equal(replaced.status,200);
  assert.equal(readFileSync(join(x.root,x.key.name),'utf8'),'replacement-token-9876');
  assert.equal((await x.run('GET')).data.entries.length,1);
  assert.equal((await x.run('DELETE','/secrets/'+x.key.name,
   {password:'correct-admin-password',confirm:x.key.name})).status,200);
  assert.equal((await x.run('GET')).data.entries.length,0);
 }finally{x.dispose();}
});
test('invalid password, traversal, control characters and invalid names are rejected',async()=>{
 const x=fixture();
 try{
  assert.equal((await x.run('POST','/secrets',{...x.key,password:'wrong'})).status,403);
  assert.equal((await x.run('POST','/secrets',{...x.key,name:'../env'})).status,400);
  assert.equal((await x.run('POST','/secrets',{...x.key,value:'wrong\napi-key'})).status,400);
  assert.equal((await x.run('POST','/secrets',{...x.key,value:'z'.repeat(8193)})).status,400);
  assert.equal((await x.run('POST','/secrets',{...x.key,extra:'unexpected'})).status,400);
  assert.equal((await x.run('GET')).data.entries.length,0);
 }finally{x.dispose();}
});
test('directory with permissive mode or a symlink cannot be used as key store',async()=>{
 const x=fixture();
 try{
  chmodSync(x.root,0o755);
  assert.equal((await x.run('POST','/secrets',x.key)).status,503);
  chmodSync(x.root,0o700);
  symlinkSync('/etc/passwd',join(x.root,'cloudflare-key'));
  assert.equal((await x.run('GET')).status,503);
  assert.equal((await x.run('POST','/secrets',x.key)).status,503);
 }finally{x.dispose();}
});
test('corrupt metadata is never silently overwritten during a write',async()=>{
 const x=fixture();
 try{
  writeFileSync(join(x.root,'.panel-secret-index.json'),'{garbled');
  assert.equal((await x.run('POST','/secrets',x.key)).status,503);
  assert.equal(readFileSync(join(x.root,'.panel-secret-index.json'),'utf8'),'{garbled');
  assert.equal((await x.run('GET')).status,503);
 }finally{x.dispose();}
});
