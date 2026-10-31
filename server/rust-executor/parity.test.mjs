import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {authorize} from '../executor-policy.ts';

const owner='com.softload.panel.managed',slug='com.softload.panel.slug';
const target={Id:'0123456789abcdef0123456789abcdef',Name:'/softload-app-demo',
 Config:{Labels:{[owner]:'true',[slug]:'demo'}},State:{Running:true,Status:'running'}};
const fakeInspect=async id=>(id===target.Id||id==='softload-app-demo')?target:null;
const rustBinary='server/rust-executor/target/debug/vps-executor-shadow';

function shadow({method,url,match=true,targetName=target.Name,labels=target.Config.Labels}){
 const payload={method,url,target:match?{id:target.Id,name:targetName,labels}:null};
 const process=spawnSync(rustBinary,[],{input:JSON.stringify(payload),encoding:'utf8',timeout:5000});
 assert.equal(process.status,0,process.stderr);
 return JSON.parse(process.stdout);
}
async function nodePolicy(method,url){
 const d=await authorize({method,url,inspect:fakeInspect,legacyEnabled:false,images:[],ghcrOwner:'Softdown-prog'});
 return d.ok;
}

test('Rust shadow reads match Node policy on narrow read-only safe corpus',async()=>{
 const cases=[
  ['GET','/v1.45/containers/json?all=1&view=inventory',true],
  ['GET','/v1.45/containers/json?view=inventory&all=1',true],
  ['GET','/v1.45/images/json',true],
  ['GET','/v1.45/system/df?type=images',true],
  ['GET','/v1.45/containers/softload-app-demo/json',true],
  ['GET','/v1.45/containers/'+target.Id+'/json',true],
  ['GET','/v1.45/containers/softload-app-other/json',false],
  ['GET','/v1.45/containers/softload-caddy/json',false],
  ['GET','/v1.45/containers/json?all=0&view=inventory',false],
  ['GET','/v1.45/volumes',false],
 ];
 for(const [method,url,expected] of cases){
  const node=await nodePolicy(method,url);
  const rust=shadow({method,url});
  assert.equal(node,expected,'Node corpus expectation '+url);
  assert.equal(rust.candidate_allowed,node,'Rust/Node mismatch '+url);
  assert.equal(rust.enforcement_allowed,false,'shadow must never enforce '+url);
 }
});
test('Rust always denies host mutations even when production Node policy allows them',async()=>{
 const url='/v1.45/containers/softload-app-demo/restart?t=10';
 assert.equal(await nodePolicy('POST',url),true);
 const decision=shadow({method:'POST',url});
 assert.equal(decision.candidate_allowed,false);
 assert.equal(decision.enforcement_allowed,false);
});
test('Rust CLI rejects excessive or malformed input before any decision',()=>{
 const oversize=spawnSync(rustBinary,[],{input:'x'.repeat(33000),encoding:'utf8',timeout:5000});
 assert.equal(oversize.status,2);
 const bad=spawnSync(rustBinary,[],{input:'{"unexpected":"field"}',encoding:'utf8',timeout:5000});
 assert.equal(bad.status,2);
});
