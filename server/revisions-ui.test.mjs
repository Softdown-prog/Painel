import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const code=readFileSync(new URL('../revisions-ui.js',import.meta.url),'utf8');
const SHA='a'.repeat(40);
function setup(entries=[]){
 const dom=new Map(),listeners=new Map();
 function make(tag='div'){
   return {tag,textContent:'',className:'',children:[],dataset:{},attributes:{},disabled:false,
     append(...nodes){this.children.push(...nodes);},
     replaceChildren(...nodes){this.children=nodes;this.textContent='';},
     setAttribute(name,value){this.attributes[name]=value;},
     addEventListener(event,callback){listeners.set(this.id+':'+event,callback);}
   };
 }
 function get(id){if(!dom.has(id)){const e=make();e.id=id;dom.set(id,e);}return dom.get(id);}
 const report={
   checkedAt:'2026-10-30T20:00:00Z',enabled:false,automatic:false,ageDays:14,keepPerApp:2,
   oldCount:0,oldBytesEstimate:0,totalImports:entries.length,entries,history:[],
   scheduler:{enabledByCompose:false,intervalHours:6},hostInventory:{available:false}
 };
 const window={panelApi:{async request(path){
   if(path==='/maintenance/revisions')return report;
   throw Error('Unexpected request '+path);
 }}};
 runInNewContext(code,{window,document:{getElementById:get,createElement:make},
   confirm:()=>false});
 return {get,window,refresh:window.refreshManagedRevisions};
}
function live(kind='running',vps='neutral'){
 return {repository:'Softdown-prog/Loja',slug:'loja',sha:SHA,runId:42,
   createdAt:'2026-10-30T20:00:00Z',url:'https://github.com/Softdown-prog/Loja/actions/runs/42',
   ci:{kind,label:kind==='running'?'CI/CD executando':'CI/CD aprovado'},
   vps:{kind:vps,label:vps==='success'?'Ativa na VPS':'Ainda não ativa na VPS'}};
}
test('live GitHub executions render animated badges in actual lower revision table',async()=>{
 const ui=setup();await ui.refresh();
 ui.window.updateRevisionRuns([live()],'Atualizado');
 const row=ui.get('revisionsEntries').children[0];
 assert.equal(row.tag,'tr');
 assert.equal(row.children.length,6);
 assert.equal(row.children[1].children[0].textContent,SHA.slice(0,10)+' · GitHub #42');
 const badges=row.children[2].children;
 assert.equal(badges.length,2);
 assert.match(badges[0].className,/revision-ci-running/);
 assert.equal(badges[0].children[1].textContent,'CI/CD executando');
 assert.match(badges[1].className,/revision-ci-neutral/);
 assert.equal(ui.get('revisionActivitySummary').textContent,'Atualizado');
});
test('same imported revision shows its protection without a duplicate row',async()=>{
 const ui=setup([{slug:'loja',revision:SHA,importedAt:'2026-10-30T20:00:00Z',
   sizeBytes:1234567,status:'recente',reason:'Mantida pela política'}]);
 await ui.refresh();
 ui.window.updateRevisionRuns([live('success','success')],'VPS confirmada');
 const rows=ui.get('revisionsEntries').children;
 assert.equal(rows.length,1);
 assert.match(rows[0].children[2].children[0].className,/revision-ci-success/);
 assert.match(rows[0].children[2].children[1].className,/revision-ci-success/);
 assert.equal(rows[0].children[2].children[1].children[1].textContent,'Ativa na VPS');
 assert.match(rows[0].children[3].children[0].children[1].textContent,/Recente/);
});
test('an imported image with no matching GitHub run never gets fake deployment green',async()=>{
 const ui=setup([{slug:'loja',revision:SHA,importedAt:'2026-10-30T20:00:00Z',
   sizeBytes:25000000,status:'em_uso',reason:'Imagem do container'}]);
 await ui.refresh();
 const row=ui.get('revisionsEntries').children[0];
 assert.equal(row.children[2].children[0].children[1].textContent,'Execução GitHub não vinculada');
 assert.match(row.children[2].children[0].className,/revision-ci-neutral/);
 assert.equal(row.children[3].children[0].children[1].textContent,'Em uso');
});
test('GitHub may show a queued revision before any image has been imported',async()=>{
 const ui=setup([]);await ui.refresh();
 ui.window.updateRevisionRuns([live()],'GitHub ativo');
 const row=ui.get('revisionsEntries').children[0];
 assert.equal(row.children[3].children[0].children[1].textContent,'Imagem não registrada');
 assert.equal(row.children[4].textContent,'—');
});
