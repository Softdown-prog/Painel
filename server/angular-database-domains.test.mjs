import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const file=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('PostgreSQL and Domains have Angular routes and preserve classic compatibility',()=>{
 const app=file('angular/src/app.component.ts');
 const html=file('angular/src/app.component.html');
 const entry=file('index.html');
 for(const route of ['database','domains']){
   assert.ok(app.includes("hash === '"+route+"'"));
   assert.ok(html.includes("selectPage('"+route+"')"));
   assert.ok(entry.includes(route+":'"+route+"'"));
   assert.ok(entry.includes("fragment === '"+route+"'"));
 }
 assert.match(html,/<panel-postgres\s*\/>/);
 assert.match(html,/<panel-domains\s*\/>/);
 assert.match(file('angular/src/apps.component.html'),/\/angular\/#domains/);
});

test('Postgres component requires cert policy and typed confirmation; secrets stay on VPS',()=>{
 const code=file('angular/src/postgres.component.ts');
 const html=file('angular/src/postgres.component.html');
 assert.match(code,/hostAuthentication==='cert'/);
 assert.match(code,/provisioningEnabled===true/);
 assert.match(code,/this\.confirmation\(\)!==slug/);
 assert.match(code,/\/database\/status/);
 assert.match(code,/\/database\/projects/);
 assert.match(code,/credentials:'same-origin'/);
 assert.match(html,/Confirmar criação/);
 assert.doesNotMatch(code+html,/localStorage|sessionStorage|Bearer |type="password"|CREATE ROLE|CREATE DATABASE/);
});

test('Domain mutations require confirmation and call only allowlisted APIs',()=>{
 const code=file('angular/src/domains.component.ts');
 const html=file('angular/src/domains.component.html');
 assert.match(code,/\/domains\/caddy/);
 assert.match(code,/app\.network===d\.network/);
 assert.match(code,/this\.confirmation\(\)!==job\.slug/);
 assert.match(code,/\/publish','POST'/);
 assert.match(code,/,'DELETE'/);
 assert.match(code,/response\.live!==false/);
 assert.match(html,/Publicar DNS e HTTPS/);
 assert.match(html,/Despublicar e remover/);
 assert.match(html,/não configura DNS nem publica/);
 assert.doesNotMatch(code+html,/x-panel-edge-key|localStorage|sessionStorage/);
});

test('Both Angular modules remain responsive for small mobile screens',()=>{
 for (const path of ['angular/src/postgres.component.css','angular/src/domains.component.css']){
   const css=file(path);
   assert.match(css,/@media\(max-width:480px\)/);
   assert.match(css,/min-height:44px/);
 }
});
