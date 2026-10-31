import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('site detail has a native Angular deep link from Apps and can show malformed slugs without I/O',()=>{
 const app=read('angular/src/app.component.ts');
 const tpl=read('angular/src/app.component.html');
 const list=read('angular/src/apps.component.html');
 assert.match(app,/view==='site'/);
 assert.match(app,/validAppSlug\(slug\)\?slug:null/);
 assert.match(tpl,/<panel-site-detail \[slug\]="slug" \/>/);
 assert.match(tpl,/Identificador inválido/);
 assert.match(list,/'\/angular\/#site\?slug='\+app\.slug/);
 assert.doesNotMatch(list,/Abrir modo anterior/);
});
test('canonical site deep links preserve validated slug and reject hostile query strings',()=>{
 const entry=read('index.html');
 const script=entry.match(/<!-- Angular is canonical;[\s\S]*?<script>([\s\S]*?)<\/script>/)?.[1];
 assert.ok(script);
 const route=(url)=>{
   const u=new URL(url);
   let next=null,legacy=false;
   runInNewContext(script,{
     location:{pathname:u.pathname,search:u.search,hash:u.hash,replace:path=>{next=path;}},
     URLSearchParams,Set,
     document:{documentElement:{classList:{add:()=>{legacy=true;}}}}
   });
   return {next,legacy};
 };
 assert.equal(route('https://panel.test/#site?slug=meu-app').next,'/angular/#site?slug=meu-app');
 assert.equal(route('https://panel.test/#site?slug=..%2Fetc').next,'/angular/#apps');
 assert.equal(route('https://panel.test/#site?slug=aa&unexpected=1').next,'/angular/#site?slug=aa');
 assert.equal(route('https://panel.test/?interface=classica#site?slug=meu-app').legacy,true);
});
test('site detail reads only scoped APIs and requires typed confirmation before changes',()=>{
 const ts=read('angular/src/site-detail.component.ts'),html=read('angular/src/site-detail.component.html');
 assert.match(ts,/validSnapshot\(snapshot\)/);
 assert.match(ts,/this\.typedName\(\)!==job\.slug/);
 assert.match(ts,/canOperate\(snapshot,app,operation\)/);
 assert.match(ts,/validAppDraft\(snapshot,this\.draft\(\)\)/);
 assert.match(ts,/result\.slug!==job\.slug/);
 assert.match(ts,/\/projects\/'\+encodeURIComponent\(slug\)\+'\/releases/);
 assert.match(ts,/\/apps\/'\+encodeURIComponent\(slug\)\+'\/logs'/);
 assert.match(ts,/credentials:'same-origin'/);
 assert.match(html,/Última confirmação HTTPS registrada/);
 assert.match(html,/Consulta indisponível/);
 assert.doesNotMatch(ts,/localStorage|sessionStorage|\/containers\/|docker\.sock|Authorization|Bearer /);
});
test('site detail allows safe use on 320–480px without overflowing the page',()=>{
 const css=read('angular/src/site-detail.component.css');
 assert.match(css,/@media\(max-width:480px\)/);
 assert.match(css,/min-height:44px/);
 assert.match(css,/max-width:100%/);
 assert.match(css,/overflow-wrap:anywhere/);
});
