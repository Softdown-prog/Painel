import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const get=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('traffic and resource history are integrated into canonical Angular navigation',()=>{
 const shell=get('angular/src/app.component.ts'),markup=get('angular/src/app.component.html'),entry=get('index.html');
 assert.match(shell,/TrafficComponent/);
 assert.match(shell,/hash === 'traffic'/);
 assert.match(markup,/<panel-traffic\s*\/>/);
 assert.match(markup,/selectPage\('traffic'\)/);
 assert.match(entry,/traffic:'traffic'/);
 assert.match(entry,/fragment === 'traffic'/);
});
test('traffic settings require typed approval and are not mistaken for billing usage',()=>{
 const code=get('angular/src/traffic.component.ts'),html=get('angular/src/traffic.component.html');
 assert.match(code,/\/traffic'/);
 assert.match(code,/\/overview'/);
 assert.match(code,/this\.confirmation\(\)!=='ATUALIZAR'/);
 assert.match(code,/resetDay\(\)<=28/);
 assert.match(code,/allowance\(\)<=1000/);
 assert.match(html,/fatura do provedor/);
 assert.match(html,/Preparar alteração/);
 assert.match(code,/credentials:'same-origin'/);
 assert.doesNotMatch(code+html,/localStorage|sessionStorage|Authorization:|x-panel-edge-key/);
});
test('traffic charts remain contained on mobile and refresh without background delivery',()=>{
 const code=get('angular/src/traffic.component.ts');
 const css=get('angular/src/traffic.component.css');
 assert.match(code,/document\.visibilityState==='visible'/);
 assert.match(code,/clearInterval\(this\.timer\)/);
 assert.match(css,/overflow-x:auto/);
 assert.match(css,/@media\(max-width:480px\)/);
 assert.match(css,/min-height:44px/);
});
