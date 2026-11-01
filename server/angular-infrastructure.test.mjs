import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseInfraSnapshot,validInfraDraft} from '../angular/src/infrastructure-policy.ts';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const stamp='2026-10-31T18:00:00Z';
const plan={id:'terrania.mcp.navigator',kind:'mcp',projectSlug:'terrania',
 name:'navigator',replicas:1,topology:'single-node',transport:'streamable-http',
 exposure:'private',runtime:'not-provisioned',createdAt:stamp,updatedAt:stamp,projectLinked:true};
const sample=()=>({projects:['terrania','painel'],plans:[plan],
 capabilities:{configuration:true,provisioning:false,healthMonitoring:false,lifecycle:false},
 limits:{total:32,perProject:8,maxClusterReplicas:8}});
test('Angular verifies infrastructure inventory and does not show simulated running states',()=>{
 const data=parseInfraSnapshot(sample());
 assert.equal(data.plans.length,1);
 assert.equal(data.capabilities.provisioning,false);
 assert.throws(()=>parseInfraSnapshot({...sample(),capabilities:{...sample().capabilities,provisioning:true}}),/Capacidades/);
 assert.throws(()=>parseInfraSnapshot({...sample(),plans:[{...plan,runtime:'running'}]}),/inesperada/);
 assert.throws(()=>parseInfraSnapshot({...sample(),plans:[{...plan,id:'foreign.mcp.navigator'}]}),/inesperada/);
 assert.throws(()=>parseInfraSnapshot({...sample(),plans:[{...plan,transport:'stdio'}]}),/inesperada/);
});
test('Angular blocks foreign projects, duplicate names, unbounded replicas and edits to orphan plans',()=>{
 const data=parseInfraSnapshot(sample());
 assert.equal(validInfraDraft(data,'mcp','terrania','new-mcp',1,'single-node',null),true);
 assert.equal(validInfraDraft(data,'mcp','foreign','new-mcp',1,'single-node',null),false);
 assert.equal(validInfraDraft(data,'mcp','terrania','navigator',1,'single-node',null),false);
 assert.equal(validInfraDraft(data,'mcp','terrania','new-mcp',2,'single-node',null),false);
 assert.equal(validInfraDraft(data,'cluster','painel','workers',9,'regional',null),false);
 assert.equal(validInfraDraft(data,'cluster','painel','workers',3,'regional',null),true);
 assert.equal(validInfraDraft(data,'mcp','terrania','navigator',1,'single-node',plan.id),true);
 assert.equal(validInfraDraft({...data,plans:[{...plan,projectLinked:false}]},
   'mcp','terrania','navigator',1,'single-node',plan.id),false);
});
test('both MCP and cluster UI are available behind authenticated Angular routing only',()=>{
 const app=read('angular/src/app.component.ts');
 const html=read('angular/src/app.component.html');
 const infra=read('angular/src/infrastructure.component.ts');
 const view=read('angular/src/infrastructure.component.html');
 const api=read('server/api.mjs');
 assert.match(app,/InfrastructureComponent/);
 assert.match(html,/selectPage\('infrastructure'\)/);
 assert.match(html,/<panel-infrastructure\s*\/>/);
 assert.match(api,/handleInfrastructureRoute/);
 assert.ok(api.indexOf('if (!session(req))')<api.indexOf('handleInfrastructureRoute(req'));
 assert.match(infra,/this\.confirmation\(\)!==pending\.id/);
 assert.match(infra,/this\.valid\(\)\|\|pending\.fingerprint!==this\.fingerprint\(\)/);
 assert.match(view,/Servidores MCP/);
 assert.match(view,/Clusters/);
 assert.match(view,/Somente cadastro de configuração/);
 assert.doesNotMatch(infra+view,/docker\.sock|x-panel-edge-key|localStorage|sessionStorage/);
});
