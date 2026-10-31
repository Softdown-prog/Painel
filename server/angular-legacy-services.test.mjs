import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const get=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('containers stay read-only for external projects and only show allowlisted service management',()=>{
 const app=get('angular/src/app.component.html');
 const cmp=get('angular/src/legacy-services.component.ts');
 assert.match(app,/Inventário Docker <span class="tag">SOMENTE LEITURA/);
 assert.match(app,/<panel-legacy-services\s*\/>/);
 assert.match(cmp,/const IDS=new Set\(\['app','agent','caddy'\]\)/);
 assert.match(cmp,/const ACTIONS=new Set\(\['start','stop','restart'\]\)/);
 assert.match(cmp,/service\.id!=='app'&&service\.id!=='agent'/);
 assert.match(cmp,/this\.typedName\(\)!==job\.name/);
 assert.doesNotMatch(cmp,/\/containers\/.+\/(restart|stop|start)|\/var\/run\/docker.sock|x-panel-edge-key/);
});

test('legacy service manager uses existing authenticated, scoped endpoints and requires confirmation',()=>{
 const ts=get('angular/src/legacy-services.component.ts');
 const tpl=get('angular/src/legacy-services.component.html');
 assert.match(ts,/\/services'/);
 assert.match(ts,/\/services\/'\+id\+'\/logs\?tail=200'/);
 assert.match(ts,/\/services\/'\+job\.id\+'\/'\+job\.action/);
 assert.match(ts,/credentials:'same-origin'/);
 assert.match(tpl,/Confirmar operação/);
 assert.match(tpl,/A API limita as ações/);
 assert.doesNotMatch(ts,/localStorage|sessionStorage|Bearer |Authorization/);
});

test('service cards and logs support mobile widths without horizontal overflow',()=>{
 const css=get('angular/src/legacy-services.component.css');
 assert.match(css,/@media\(max-width:480px\)/);
 assert.match(css,/min-height:44px/);
 assert.match(css,/word-break:break-word/);
});
