import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../revision-activity-ui.js',import.meta.url),'utf8');
const SHA='a'.repeat(40);
function harness(overrides={}){
  let latest=[],notice='';
  const callbacks=new Map();
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:''});return nodes.get(id);};
  const calls=[];
  const payloads={
    '/repositories':{repositories:[{fullName:'Softdown-prog/Loja',branch:'main',workflow:'deploy.yml'}]},
    '/projects':{projects:[{slug:'loja',repository:'Softdown-prog/Loja'}]},
    '/publications':{history:[]},
    '/repositories/Softdown-prog/Loja/runs':{runs:[{id:42,sha:SHA,branch:'main',status:'completed',
      conclusion:'success',createdAt:'2026-10-30T20:00:00Z'}]},
    '/projects/loja/releases':{current:{state:'running',revision:SHA}},...overrides
  };
  const window={
    updateRevisionRuns(rows,text){latest=rows;notice=text;},
    panelApi:{async request(path){calls.push(path);if(payloads[path] instanceof Error)throw payloads[path];return payloads[path];}},
    setTimeout(){return 1;},clearTimeout(){}
  };
  const document={hidden:false,getElementById:node,
    addEventListener(type,cb){callbacks.set(type,cb);}};
  const location={hash:'#revisions'};
  runInNewContext(source,{window,document,location});
  return {get rows(){return latest;},get notice(){return notice;},calls,window,document,location,
    refresh:window.refreshRevisionActivity};
}
test('green VPS is emitted only for the exact running revision',async()=>{
  const ui=harness();await ui.refresh();
  assert.equal(ui.rows.length,1);
  assert.equal(ui.rows[0].ci.kind,'success');
  assert.equal(ui.rows[0].vps.kind,'success');
  assert.equal(ui.rows[0].vps.label,'Ativa na VPS');
  assert.match(ui.notice,/1 revisão/);
  assert(ui.calls.includes('/projects/loja/releases'));
});
test('successful GitHub CI with old running image never reports VPS success',async()=>{
  const ui=harness({'/projects/loja/releases':{current:{state:'running',revision:'b'.repeat(40)}}});
  await ui.refresh();
  assert.equal(ui.rows[0].ci.kind,'success');
  assert.equal(ui.rows[0].vps.kind,'warning');
  assert.equal(ui.rows[0].vps.label,'Outra revisão ativa');
  assert.match(ui.notice,/0 revisão/);
});
test('queued and building GitHub executions plus publication health yield spinner states',async()=>{
  const ui=harness({
    '/repositories/Softdown-prog/Loja/runs':{runs:[{id:42,sha:SHA,status:'in_progress',
      conclusion:null,createdAt:'2026-10-30T20:00:00Z'}]},
    '/publications':{history:[{repository:'Softdown-prog/Loja',slug:'loja',runId:42,phase:'health'}]},
    '/projects/loja/releases':{current:{state:'running',revision:'b'.repeat(40)}}
  });
  await ui.refresh();
  assert.equal(ui.rows[0].ci.kind,'running');
  assert.equal(ui.rows[0].vps.kind,'running');
  assert.equal(ui.rows[0].vps.label,'Testando container');
});
test('failed workflow and unreachable release cannot be presented as successful',async()=>{
  const ui=harness({
    '/repositories/Softdown-prog/Loja/runs':{runs:[{id:42,sha:SHA,status:'completed',
      conclusion:'failure',createdAt:'2026-10-30T20:00:00Z'}]},
    '/projects/loja/releases':new Error('VPS indisponível')
  });
  await ui.refresh();
  assert.equal(ui.rows[0].ci.kind,'failed');
  assert.equal(ui.rows[0].vps.kind,'neutral');
  assert.equal(ui.rows[0].vps.label,'VPS não verificada');
});
test('no repository still publishes an empty honest update instead of stale green',async()=>{
  const ui=harness({'/repositories':{repositories:[]}});await ui.refresh();
  assert.equal(ui.rows.length,0);
  assert.match(ui.notice,/Nenhum repositório/);
});
test('no background polling while hidden or outside revisions',async()=>{
  const ui=harness();ui.document.hidden=true;await ui.refresh();assert.equal(ui.calls.length,0);
  ui.document.hidden=false;ui.location.hash='#overview';await ui.refresh();assert.equal(ui.calls.length,0);
});
