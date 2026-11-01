import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseOverview,parseInventory,capacityAlerts,readingFresh} from '../angular/src/overview-state.ts';
import {parseAdminSession,expiredProtectedSession,maySubmitAdminLogin} from '../angular/src/session-state.ts';
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

test('container inventory filters are local, project-aware and do not expose lifecycle actions',async()=>{
 const {filterInventory,inventoryProjects}=await import('../angular/src/inventory-view.ts');
 const raw={readOnly:true,updatedAt:stamp,containers:[
   {name:'panel-api',image:'registry/API',state:'running',status:'Up',project:'Painel'},
   {name:'cafe-web',image:'nginx:latest',state:'exited',status:'Exited',project:'Café'},
   {name:'legacy-job',image:'worker:1',state:'paused',status:'Paused',project:null}
 ]};
 const inventory=parseInventory(raw);
 assert.deepEqual(inventoryProjects(inventory),['Café','Painel']);
 assert.deepEqual(inventoryProjects(null),[]);
 const base={query:'',project:'',status:'all'};
 assert.equal(filterInventory(inventory,base).length,3);
 assert.deepEqual(filterInventory(inventory,{...base,status:'running'}).map(x=>x.name),['panel-api']);
 assert.deepEqual(filterInventory(inventory,{...base,status:'other'}).map(x=>x.name),['cafe-web','legacy-job']);
 assert.deepEqual(filterInventory(inventory,{...base,project:'Café'}).map(x=>x.name),['cafe-web']);
 assert.deepEqual(filterInventory(inventory,{...base,query:'CAFE'}).map(x=>x.name),['cafe-web']);
 assert.deepEqual(filterInventory(inventory,{...base,query:'registry/api'}).map(x=>x.name),['panel-api']);
 assert.equal(filterInventory(inventory,{...base,query:'sem resultado'}).length,0);
 assert.deepEqual(filterInventory(null,base),[]);
 const component=read('angular/src/app.component.ts');
 const html=read('angular/src/app.component.html');
 assert.match(component,/visibleContainers=computed/);
 assert.match(html,/Nenhum container corresponde aos filtros atuais/);
 assert.match(html,/Os filtros pesquisam somente os containers recebidos/);
 assert.doesNotMatch(html,/\/containers\/(?:start|stop|restart|delete)/);
});

test('administrative session is parsed without trusting incomplete or malformed responses',()=>{
 assert.deepEqual(parseAdminSession({authenticated:false,setupRequired:true,secret:'ignored'}),
   {authenticated:false,setupRequired:true});
 assert.deepEqual(parseAdminSession({authenticated:true,setupRequired:false}),
   {authenticated:true,setupRequired:false});
 for(const raw of [null,[],{}, {authenticated:'yes',setupRequired:false},
   {authenticated:true,setupRequired:null}])
   assert.throws(()=>parseAdminSession(raw),/sessão administrativa/);
 assert.equal(expiredProtectedSession(401,'/overview'),true);
 assert.equal(expiredProtectedSession(401,'/containers'),true);
 assert.equal(expiredProtectedSession(401,'/login'),false);
 assert.equal(expiredProtectedSession(401,'/session'),false);
 assert.equal(expiredProtectedSession(403,'/secrets'),false);
});
test('Angular revalidates every visible session and refuses unconfirmed logout',()=>{
 const component=read('angular/src/app.component.ts'),html=read('angular/src/app.component.html');
 assert.match(component,/void this\.revalidateVisiblePage\(\)/);
 assert.match(component,/document\.visibilityState==='visible'&&this\.signedIn\(\)/);
 assert.match(component,/parseAdminSession\(await this\.request<unknown>\('\/session'\)\)/);
 assert.match(component,/this\.lockSession\('Sessão administrativa encerrada/);
 assert.match(component,/expiredProtectedSession\(response\.status,path\)/);
 assert.match(component,/this\.logoutUnconfirmed\.set\(true\)/);
 assert.match(component,/this\.sessionCheckId\+\+/);
 assert.match(html,/Tentar encerrar sessão novamente/);
 assert.match(html,/Verificar sessão/);
 assert.doesNotMatch(component,/localStorage|sessionStorage/);
});

test('login is impossible during an unconfirmed or pending logout, even without UI guards',()=>{
 const anonymous={authenticated:false,setupRequired:false};
 assert.equal(maySubmitAdminLogin(anonymous,false,false,false,false),true);
 for(const flags of [
   [true,false,false,false],
   [false,true,false,false],
   [false,false,true,false],
   [false,false,false,true]
 ]){
   assert.equal(maySubmitAdminLogin(anonymous,...flags),false);
 }
 assert.equal(maySubmitAdminLogin(null,false,false,false,false),false);
 assert.equal(maySubmitAdminLogin({authenticated:true,setupRequired:false},false,false,false,false),false);
 assert.equal(maySubmitAdminLogin({authenticated:false,setupRequired:true},false,false,false,false),false);
 const src=read('angular/src/app.component.ts'),html=read('angular/src/app.component.html');
 assert.match(src,/if\(!this\.loginAllowed\(\)\)return/);
 assert.match(src,/this\.logoutPending\.set\(true\)/);
 assert.match(src,/this\.logoutUnconfirmed\.set\(true\)/);
 assert.match(src,/if\(this\.destroyed\|\|this\.logoutUnconfirmed\(\)\|\|this\.logoutPending\(\)\)return false/);
 assert.match(html,/@else if\(logoutUnconfirmed\(\)\)/);
 assert.match(html,/@else if \(!session\(\)\)/);
 assert.match(html,/\[disabled\]="!loginAllowed\(\) \|\| !password\(\)"/);
 assert.match(html,/Confirmando a saída com o servidor/);
});
