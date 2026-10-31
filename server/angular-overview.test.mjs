import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseOverview,parseInventory,capacityAlerts,readingFresh} from '../angular/src/overview-state.ts';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const stamp='2026-10-31T17:00:00.000Z';
const good=()=>({updatedAt:stamp,containerSummary:{available:true,running:2,total:3},cpu:{load1:1.5,cores:4},disk:{used:1024,total:2048}});
test('API metrics are validated without inventing host numbers',()=>{
 const value=parseOverview(good());
 assert.equal(value.containerSummary.running,2);
 assert.deepEqual(value.cpu,{load1:1.5,cores:4});
 assert.deepEqual(value.disk,{used:1024,total:2048});
 const invalid=parseOverview({...good(),cpu:{load1:'100%',cores:4},disk:{used:-1,total:100}});
 assert.equal(invalid.cpu,undefined);assert.equal(invalid.disk,undefined);
 assert.deepEqual(parseOverview({...good(),containerSummary:{available:false,running:null,total:null}}).containerSummary,
   {available:false,running:null,total:null,truncated:false});
 assert.throws(()=>parseOverview({...good(),containerSummary:{available:true,running:9,total:2}}),/contagem/);
 assert.throws(()=>parseOverview({...good(),updatedAt:'invalid'}),/métricas/);
 assert.throws(()=>parseOverview({}),/métricas/);
});
test('Read-only inventory is validated and excludes unexpected metadata',()=>{
 const raw={readOnly:true,updatedAt:stamp,containers:[{
  name:'panel-api',image:'registry/image',state:'running',status:'Up',project:'admin',
  dockerId:'private',mounts:['/var/run/docker.sock']
 }]};
 const parsed=parseInventory(raw);
 assert.equal(parsed.containers.length,1);
 assert.deepEqual(Object.keys(parsed.containers[0]??{}).sort(),['image','name','project','state','status']);
 assert.throws(()=>parseInventory({...raw,readOnly:false}),/inventário/);
 assert.throws(()=>parseInventory({...raw,updatedAt:''}),/inventário/);
 assert.throws(()=>parseInventory({...raw,containers:[{name:'../../etc/passwd'}]}),/inválida/);
});
test('Partial reads and logout race guards are wired to the Angular dashboard',()=>{
 const component=read('angular/src/app.component.ts');
 const html=read('angular/src/app.component.html');
 assert.match(component,/Promise\.allSettled\(/);
 assert.match(component,/epoch!==this\.authEpoch\|\|!this\.signedIn\(\)/);
 assert.match(component,/this\.authEpoch\+\+/);
 assert.match(html,/Dados anteriores: atualização falhou/);
 assert.match(html,/Inventário anterior: atualização falhou/);
 assert.match(html,/Nenhuma leitura de containers confirmada/);
 assert.match(html,/Última leitura válida/);
 assert.doesNotMatch(component,/\/containers\/(start|stop|restart|delete)/);
});

test('validated MemAvailable is displayed, but inconsistent or unverified RAM is not',()=>{
 const valid=parseOverview({...good(),memory:{used:8,total:10,available:2,source:'memavailable'}});
 assert.deepEqual(valid.memory,{used:8,total:10,available:2,source:'memavailable'});
 assert.equal(parseOverview({...good(),memory:{used:8,total:10,available:1,source:'memavailable'}}).memory,undefined);
 assert.equal(parseOverview({...good(),memory:{used:11,total:10,available:0,source:'memavailable'}}).memory,undefined);
 assert.equal(parseOverview({...good(),memory:{used:8,total:10,available:2,source:'unknown'}}).memory,undefined);
});
test('capacity warnings require valid numbers; a fallback RAM reading is not an alert',()=>{
 const full=parseOverview({...good(),memory:{used:95,total:100,available:5,source:'memavailable'},
   disk:{used:95,total:100},cpu:{load1:5,cores:4}});
 const alert=capacityAlerts(full);
 assert.equal(alert.length,3);
 assert.ok(alert.every(x=>x.kind==='danger'||x.kind==='warning'));
 const estimated=parseOverview({...good(),memory:{used:99,total:100,available:1,source:'os-freemem'},
   disk:{used:20,total:100},cpu:{load1:0.1,cores:4}});
 assert.deepEqual(capacityAlerts(estimated),[]);
 assert.deepEqual(capacityAlerts(null),[]);
 assert.deepEqual(capacityAlerts(parseOverview({...good(),disk:{used:-1,total:100}})),[]);
});
test('refresh freshness refuses old and future clock samples',()=>{
 const at='2026-10-31T12:00:00.000Z',now=Date.parse(at);
 assert.equal(readingFresh(at,now+60_000),true);
 assert.equal(readingFresh(at,now+121_000),false);
 assert.equal(readingFresh(at,now-31_000),false);
 assert.equal(readingFresh('not-a-date',now),false);
});
test('overview polling is visibility- and authentication-gated and is cleared on destroy',()=>{
 const component=read('angular/src/app.component.ts');
 const html=read('angular/src/app.component.html');
 assert.match(component,/document\.visibilityState==='visible'&&this\.signedIn\(\)/);
 assert.match(component,/clearInterval\(this\.timer\)/);
 assert.match(component,/overviewFresh=computed/);
 assert.match(html,/RAM em uso/);
 assert.match(html,/Estimativa sem descontar cache/);
 assert.match(html,/Alertas de capacidade não confirmados/);
});
