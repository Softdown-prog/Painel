import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runPanelUi } from './ui-fixture.mjs';
const ui = readFileSync(new URL('../site-detail-ui.js',import.meta.url),'utf8');

function makeDom() {
  const nodes = new Map();
  function make(id = '') {
    return {
      id, children: [], textContent: '', value: '', disabled: false, handlers: {}, href: '',
      addEventListener(type,fn) { this.handlers[type]=fn; },
      append(...children) { this.children.push(...children); if(!this.value && this.children[0]?.value)this.value=this.children[0].value; },
      replaceChildren(...children) { this.children=children;this.value=''; },
    };
  }
  return {
    getElementById(id) { if(!nodes.has(id))nodes.set(id,make(id));return nodes.get(id); },
    createElement:()=>make(), nodes
  };
}
test('site dashboard reads real API state and labels unverified domain as reserved',async()=>{
  const document=makeDom();
  const urls=[];
  const sha='a'.repeat(40);
  const values = {
    '/apps':{enabled:true,ramChoices:[128,256,512],cpuChoices:[0.5,1],idleChoices:[0,30],applications:[{
      slug:'loja',name:'softload-app-loja',state:'running',status:'Up',image:'shop:v2',
      ramMb:256,cpuCores:0.5,diskUsedBytes:10485760,idleMinutes:0
    }]},
    '/apps/loja':{slug:'loja',image:'shop:v2'},
    '/projects':{projects:[{slug:'loja',repository:'Softdown-prog/Shop'}]},
    '/domains':{routes:[{slug:'loja',host:'loja.example.test'}]},
    '/projects/loja/releases':{enabled:true,current:{revision:sha,state:'running'},candidate:null,backup:{image:'shop:v1'}},
    '/apps/loja/logs':{lines:'app ready'}
  };
  const fetch=async url=>{
    urls.push(String(url));
    const path=String(url).slice('/api'.length);
    const data=values[path];
    return {ok:!!data,status:data?200:404,json:async()=>data||{error:'not found'}};
  };
  const window={};
  const location={hash:'#site?slug=loja'};
  const confirm=()=>true;
  runPanelUi(ui,{document,window,location,fetch,confirm,Object,Promise,URLSearchParams,Error,Number});
  await window.refreshSiteDetail();
  assert.equal(document.getElementById('siteTitle').textContent,'Aplicação: loja');
  assert.equal(document.getElementById('siteRepo').textContent,'Softdown-prog/Shop');
  assert.match(document.getElementById('siteDomain').textContent,/reservado; publicação não confirmada/);
  assert.match(document.getElementById('siteBackup').textContent,/Disponível/);
  assert.equal(document.getElementById('siteRestart').disabled,false);
  assert.equal(document.getElementById('siteStart').disabled,true);
  assert.equal(document.getElementById('siteRamChoice').value,'256');
  assert.ok(urls.includes('/api/apps/loja'));
});
test('site dashboard refuses invalid application slugs without API requests',async()=>{
  const document=makeDom(),window={},requests=[];
  const fetch=async url=>{requests.push(url);throw Error('Must not call API');};
  runPanelUi(ui,{document,window,fetch,location:{hash:'#site?slug=..%2Fetc'},confirm:()=>true,
    Object,Promise,URLSearchParams,Error,Number});
  await window.refreshSiteDetail();
  assert.equal(requests.length,0);
  assert.match(document.getElementById('siteNotice').textContent,/selecione uma aplicação/i);
});
