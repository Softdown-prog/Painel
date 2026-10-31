import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseOverview,parseInventory} from '../angular/src/overview-state.ts';
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
