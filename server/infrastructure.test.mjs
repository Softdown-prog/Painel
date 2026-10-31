import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {handleInfrastructureRoute,readInfrastructurePlans} from './infrastructure.ts';

function fixture(){
 const dataDir=mkdtempSync(join(tmpdir(),'panel-infra-'));
 writeFileSync(join(dataDir,'projects.json'),JSON.stringify([
   {slug:'terrania',repository:'Softdown-prog/Terrania',connectedAt:'2026-10-31T12:00:00Z',services:[]},
   {slug:'painel',repository:'Softdown-prog/Painel',connectedAt:'2026-10-31T12:00:00Z',services:[]}
 ]));
 const request=async (url,method='GET',payload={})=>{
   let result;
   const recognized=await handleInfrastructureRoute({url,method},{},{
     dataDir,body:async()=>payload,
     send:(_res,status,data)=>{result={status,data};}
   });
   assert.equal(recognized,true);
   return result;
 };
 return {dataDir,request,close:()=>rmSync(dataDir,{recursive:true,force:true})};
}
const mcp={kind:'mcp',projectSlug:'terrania',name:'navigation',replicas:1,topology:'single-node',transport:'streamable-http'};
const cluster={kind:'cluster',projectSlug:'painel',name:'jobs',replicas:3,topology:'regional',transport:null};
test('MCP and cluster plans are persisted and explicitly do not provision resources',async()=>{
 const f=fixture();
 try{
   const empty=await f.request('/infrastructure');
   assert.equal(empty.status,200);
   assert.deepEqual(empty.data.projects,['terrania','painel']);
   assert.equal(empty.data.capabilities.provisioning,false);
   assert.equal(empty.data.capabilities.healthMonitoring,false);
   const a=await f.request('/infrastructure','POST',mcp);
   const b=await f.request('/infrastructure','POST',cluster);
   assert.equal(a.status,201);assert.equal(b.status,201);
   assert.equal(a.data.plan.id,'terrania.mcp.navigation');
   assert.equal(a.data.plan.runtime,'not-provisioned');
   assert.equal(b.data.plan.id,'painel.cluster.jobs');
   assert.equal(b.data.plan.exposure,'private');
   assert.equal(readInfrastructurePlans(f.dataDir).length,2);
   assert.equal(statSync(join(f.dataDir,'infrastructure-plans.json')).mode&0o777,0o600);
   const list=(await f.request('/infrastructure')).data;
   assert.deepEqual(list.plans.map(p=>p.projectLinked),[true,true]);
   assert.ok(list.plans.every(p=>!('containerId'in p)&&!('endpoint'in p)&&!('token'in p)));
 }finally{f.close();}
});
test('registration rejects unknown owners, arbitrary commands, public exposure and invalid capacities',async()=>{
 const f=fixture();
 try{
   for(const bad of [
     {...mcp,projectSlug:'foreign'}, {...mcp,name:'../../escape'},
     {...mcp,endpoint:'http://169.254.169.254/'},{...mcp,command:'bash -c evil'},
     {...mcp,exposure:'public'}, {...mcp,replicas:2},
     {...cluster,replicas:0},{...cluster,replicas:9},
     {...cluster,topology:'unrestricted'}, {...cluster,transport:'stdio'},
     {...mcp,transport:'stdio'}, {...mcp,authToken:'test'}
   ]){
     const status=(await f.request('/infrastructure','POST',bad)).status;
     assert.ok(status===400||status===404);
   }
   assert.deepEqual(readInfrastructurePlans(f.dataDir),[]);
 }finally{f.close();}
});
test('editing and removing a plan verifies project identity and exact confirmation',async()=>{
 const f=fixture();
 try{
   await f.request('/infrastructure','POST',mcp);
   await f.request('/infrastructure','POST',cluster);
   const path='/infrastructure/painel.cluster.jobs';
   assert.equal((await f.request(path,'PUT',{projectSlug:'terrania',replicas:4,topology:'regional',transport:null})).status,409);
   assert.equal((await f.request(path,'PUT',{projectSlug:'painel',replicas:9,topology:'regional',transport:null})).status,400);
   assert.equal((await f.request(path,'PUT',{projectSlug:'painel',replicas:2,topology:'single-node',transport:null})).status,200);
   assert.equal(readInfrastructurePlans(f.dataDir).find(p=>p.id==='painel.cluster.jobs').replicas,2);
   assert.equal((await f.request(path,'DELETE',{projectSlug:'terrania',confirmId:'painel.cluster.jobs'})).status,409);
   assert.equal((await f.request(path,'DELETE',{projectSlug:'painel',confirmId:'wrong'})).status,400);
   assert.equal((await f.request(path,'DELETE',{projectSlug:'painel',confirmId:'painel.cluster.jobs'})).status,200);
   assert.deepEqual(readInfrastructurePlans(f.dataDir).map(p=>p.id),['terrania.mcp.navigation']);
   assert.equal((await f.request(path,'DELETE',{projectSlug:'painel',confirmId:'painel.cluster.jobs'})).status,404);
 }finally{f.close();}
});
test('concurrent creation is serialized and cannot overwrite a plan',async()=>{
 const f=fixture();
 try{
   const results=await Promise.all(Array.from({length:8},()=>f.request('/infrastructure','POST',mcp)));
   assert.equal(results.filter(x=>x.status===201).length,1);
   assert.equal(results.filter(x=>x.status===409).length,7);
   assert.equal(readInfrastructurePlans(f.dataDir).length,1);
 }finally{f.close();}
});
test('orphan plans remain visible and removable but not editable',async()=>{
 const f=fixture();
 try{
   await f.request('/infrastructure','POST',mcp);
   writeFileSync(join(f.dataDir,'projects.json'),'[]');
   const result=(await f.request('/infrastructure')).data;
   assert.equal(result.plans[0].projectLinked,false);
   assert.equal((await f.request('/infrastructure/terrania.mcp.navigation','PUT',
     {projectSlug:'terrania',replicas:1,topology:'single-node',transport:'streamable-http'})).status,409);
   assert.equal((await f.request('/infrastructure/terrania.mcp.navigation','DELETE',
     {projectSlug:'terrania',confirmId:'terrania.mcp.navigation'})).status,200);
 }finally{f.close();}
});
test('corrupted registry does not get silently overwritten by a new request',async()=>{
 const f=fixture();
 try{
   const file=join(f.dataDir,'infrastructure-plans.json');
   writeFileSync(file,'{"plans":[]}');
   assert.equal((await f.request('/infrastructure')).status,502);
   assert.equal((await f.request('/infrastructure','POST',mcp)).status,502);
   assert.equal(readFileSync(file,'utf8'),'{"plans":[]}');
 }finally{f.close();}
});
