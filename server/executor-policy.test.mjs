import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize, validCreate, validLimits, visibleContainers } from './executor-policy.ts';
import { managedContainerSpec } from './apps.ts';
const labels={ 'com.softload.panel.managed':'true', 'com.softload.panel.slug':'demo' };
const fake={
  Id:'0123456789abcdef0123456789abcdef', Name:'/softload-app-demo',
  Config:{ Labels:labels },State:{Status:'running',Running:true}
};
const inspect=async id=>{
  if(id==='softload-app-demo'||id===fake.Id)return fake;
  if(id==='softload-vps-app-1')return {...fake,Name:'/softload-vps-app-1',Config:{Labels:{}}};
  if(id==='softload-caddy')return {...fake,Name:'/softload-caddy',Config:{Labels:{}}};
  if(['softload-vps-sandbox-1','softload-vps-embeddings-1','softload-portainer'].includes(id))return {...fake,Name:'/'+id,Config:{Labels:{}}};
  if(id==='softload-candidate-demo')return {...fake,Id:'abc124',Name:'/softload-candidate-demo',
    Config:{Labels:{...labels,'com.softload.panel.release-role':'candidate'}}};
  if(id==='softload-backup-demo')return {...fake,Id:'abc125',Name:'/softload-backup-demo',Config:{Labels:{...labels}}};
  if(id==='other')return {...fake,Id:'other',Name:'/other',Config:{Labels:{}}};
  return null;
};
const check=(method,url,payload,options={})=>authorize({method,url,payload,inspect,images:['example:1'],...options});
test('create policy forbids privilege escalation, mounts, custom networks, extra env and CPU abuse',()=>{
 const safe=managedContainerSpec('demo','example:1');
 assert.equal(validCreate('softload-app-demo',safe,['example:1']),true);
 const variants=[
  {...safe,Privileged:true},
  {...safe,HostConfig:{...safe.HostConfig,Binds:['/:/host']}},
  {...safe,HostConfig:{...safe.HostConfig,NetworkMode:'host'}},
  {...safe,HostConfig:{...safe.HostConfig,Memory:9999999999}},
  {...safe,HostConfig:{...safe.HostConfig,CapDrop:[]}},
  {...safe,User:'0:0'},
  {...safe,Labels:{...safe.Labels,'com.softload.panel.slug':'other'}},
  {...safe,Image:'unknown:latest'},
  {...safe,HostConfig:{...safe.HostConfig,PortBindings:{'80/tcp':[{'HostPort':'80'}]}}}
 ];
 for(const v of variants)assert.equal(validCreate('softload-app-demo',v,['example:1']),false);
 const candidate=managedContainerSpec('demo','sha256:'+'a'.repeat(64),{
  'com.softload.panel.repository':'Softdown-prog/sample',
  'com.softload.panel.revision':'b'.repeat(40),
  'com.softload.panel.release-role':'candidate'
 });
 assert.equal(validCreate('softload-candidate-demo',candidate,[]),true);
 assert.equal(validCreate('softload-candidate-foreign',candidate,[]),false);
 assert.equal(validCreate('softload-backup-demo',candidate,[]),false);
});
test('read API supports only bounded allowlisted requests and filters nonowned containers',async()=>{
 for(const url of ['/v1.45/containers/json?all=1','/v1.45/containers/json?all=1&size=1',
 '/v1.45/containers/json?all=1&filters='+encodeURIComponent(JSON.stringify({label:['com.softload.panel.managed=true']}))]){
  const d=await check('GET',url);assert.equal(d.ok,true,JSON.stringify(d));assert.equal(d.filterList,true);
 }
 for(const url of ['/v1.45/containers/json?all=0','/v1.45/networks','/v1.45/volumes',
   '/v1.45/containers/json?all=1&filters='+encodeURIComponent(JSON.stringify({label:['other=true']})),
   '/v1.45/containers/json?all=1&limit=100','/v1.45/containers/other/json']){
  assert.equal((await check('GET',url)).ok,false,url);
 }
 assert.equal((await check('GET','/v1.45/containers/softload-app-demo/json')).ok,true);
 assert.equal((await check('GET','/v1.45/containers/softload-app-demo/json')).targetId,fake.Id);
 assert.equal((await check('GET','/v1.45/containers/'+fake.Id+'/json')).ok,true);
 assert.equal((await check('GET','/v1.45/containers/softload-caddy/json')).ok,true);
 assert.equal((await check('GET','/v1.45/system/df?type=images')).ok,true);
 assert.equal((await check('GET','/v1.45/containers/softload-app-demo/stats?stream=false&one-shot=true')).ok,true);
 const listed=visibleContainers([
  {Names:['/softload-app-demo'],Labels:labels},
  {Names:['/softload-app-demo'],Labels:{}},
  {Names:['/softload-vps-app-1'],Labels:{}},
  {Names:['/softload-vps-sandbox-1'],Labels:{}},
  {Names:['/softload-vps-embeddings-1'],Labels:{}},
  {Names:['/softload-portainer'],Labels:{}},
  {Names:['/other'],Labels:{}}
 ]);
 assert.equal(listed.length,2);
});
test('mutations only affect authorized targets and reject rename between unrelated applications',async()=>{
 assert.equal((await check('POST','/v1.45/containers/softload-vps-app-1/restart?t=15')).ok,true);
 assert.equal((await check('POST','/v1.45/containers/softload-caddy/restart?t=15')).ok,false);
 for(const retired of ['softload-vps-sandbox-1','softload-vps-embeddings-1','softload-portainer']){
  assert.equal((await check('POST','/v1.45/containers/'+retired+'/start')).ok,false,'retired service cannot start: '+retired);
  assert.equal((await check('POST','/v1.45/containers/'+retired+'/restart?t=15')).ok,false,'retired service cannot restart: '+retired);
  assert.equal((await check('GET','/v1.45/containers/'+retired+'/logs?tail=100')).ok,false,'retired service no longer exposed: '+retired);
 }

 assert.equal((await check('POST','/v1.45/containers/other/stop?t=10')).ok,false);
 assert.equal((await check('DELETE','/v1.45/containers/softload-app-demo?force=0&v=0')).ok,false);
 assert.equal((await check('POST','/v1.45/containers/softload-app-demo/update',
   {Memory:536870912,MemorySwap:1073741824,NanoCpus:500000000})).ok,true);
 assert.equal((await check('POST','/v1.45/containers/softload-app-demo/update',
   {Memory:536870912,MemorySwap:1073741824,NanoCpus:500000000,Privileged:true})).ok,false);
 assert.equal((await check('POST','/v1.45/containers/softload-candidate-demo/rename?name=softload-app-foreign')).ok,false);
 assert.equal((await check('POST','/v1.45/containers/softload-candidate-demo/rename?name=softload-app-demo')).ok,true);
 assert.equal((await check('POST','/v1.45/containers/softload-app-demo/rename?name=softload-backup-demo')).ok,true);
 assert.equal((await check('POST','/v1.45/containers/softload-backup-demo/rename?name=softload-app-demo')).ok,true);
 assert.equal((await check('POST','/v1.45/containers/softload-app-demo/rename?name=softload-candidate-demo')).ok,true);
 assert.equal((await check('POST','/v1.45/containers/softload-app-demo/exec')).ok,false);
});
test('GHCR pulls require fixed owner and digest; image operations reject arbitrary sources',async()=>{
 const good='ghcr.io/softdown-prog/website@sha256:'+'a'.repeat(64);
 assert.equal((await check('POST','/v1.45/images/create?fromImage='+encodeURIComponent(good))).ok,true);
 assert.equal((await check('POST','/v1.45/images/create?fromImage='+encodeURIComponent('ghcr.io/attacker/x@sha256:'+'a'.repeat(64)))).ok,false);
 assert.equal((await check('POST','/v1.45/images/create?fromImage='+encodeURIComponent('ghcr.io/softdown-prog/x:latest'))).ok,false);
 assert.equal((await check('DELETE','/v1.45/images/'+encodeURIComponent(good))).ok,false);
});

test('image cleanup allows only verified GHCR digests unused by ALL containers',async()=>{
 const ref='ghcr.io/softdown-prog/shop@sha256:'+'a'.repeat(64);
 const path='/v1.45/images/'+encodeURIComponent(ref)+'?force=0&noprune=1';
 const base={method:'DELETE',url:path,inspect,ghcrOwner:'Softdown-prog',
  inspectImage:async()=>({Id:'sha256:'+'b'.repeat(64),RepoDigests:[ref]}),
  imageUsed:async()=>false};
 assert.equal((await authorize(base)).ok,true);
 assert.equal((await authorize({...base,imageUsed:async()=>true})).ok,false);
 assert.equal((await authorize({...base,inspectImage:async()=>null})).ok,false);
 assert.equal((await authorize({...base,url:path.replace('force=0','force=1')})).ok,false);
 assert.equal((await authorize({...base,url:'/v1.45/images/'+encodeURIComponent('ghcr.io/attacker/shop@sha256:'+'a'.repeat(64))+'?force=0&noprune=1'})).ok,false);
 assert.equal((await authorize({...base,inspectImage:undefined})).ok,false);
 assert.equal((await authorize({...base,imageUsed:undefined})).ok,false);
});
