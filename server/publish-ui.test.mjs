import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runPanelUi } from './ui-fixture.mjs';
const script = readFileSync(new URL('../projects-ui.js',import.meta.url),'utf8');
const revision='a'.repeat(40);
function harness(unhealthy=false){
  const elements=new Map(),calls=[],confirmations=[];
  let staged=false,promoted=false;
  function make(tag='div'){
    const item={
      tag,children:[],handlers:{},className:'',href:'',target:'',rel:'',type:'',disabled:false,
      _value:'',_text:'',
      get textContent(){return this._text;},
      set textContent(t){this._text=String(t);this.children=[];},
      get value(){return this._value || this.children[0]?.value || '';},
      set value(v){this._value=v;},
      get options(){return this.children;},
      addEventListener(type,callback){this.handlers[type]=callback;},
      append(...items){this.children.push(...items);},
      replaceChildren(...items){this.children=items;this._text='';this._value='';},
      querySelectorAll(){return [];}
    };
    return item;
  }
  const document={
    getElementById(id){if(!elements.has(id))elements.set(id,make());return elements.get(id);},
    createElement:make,
    createTextNode(text){return make('text');}
  };
  const responses={
    '/projects':{projects:[{slug:'demo',repository:'Softdown-prog/shop',branch:'main',workflow:'panel-app-build.yml',services:['demo']}],
      buildsEnabled:true,requiredWorkflow:'panel-app-build.yml'},
    '/apps':{applications:[{slug:'demo',state:'running',image:'shop:old'}]},
    '/repositories':{repositories:[{fullName:'Softdown-prog/shop',branch:'main',workflow:'panel-app-build.yml'}]},
    '/projects/demo/runs':{runs:[{id:123,sha:revision,status:'completed',conclusion:'success',createdAt:'2026-10-25T12:00:00Z'}]},
    '/projects/demo/images/import':{enabled:true,job:null,imported:{revision}},
    '/projects/demo/publication':{enabled:true,current:null,history:[]}
  };
  async function fetch(path,opts={}){
    const name=String(path).replace(/^\/api/,'');
    calls.push({path:name,method:opts.method||'GET',data:opts.body?JSON.parse(opts.body):null});
    let data=responses[name];
    if(name==='/projects/demo/publication'&&opts.method==='POST'){
      data={ok:true,job:{runId:123,phase:'queued',detail:'Na fila'}};responses[name]={enabled:true,current:{runId:123,phase:'completed',detail:'Publicado e verificado.'},
        history:[{runId:123,phase:'completed',detail:'Publicado e verificado.'}]};
    }
        if(name==='/projects/demo/releases'&&(opts.method||'GET')==='GET'){
      data={enabled:true,current:{revision:promoted?revision:'b'.repeat(40),state:'running',image:'shop:old'},
        candidate:staged&&!promoted?{revision,state:'running',health:unhealthy?'unhealthy':'healthy'}:null,
        backup:promoted?{image:'shop:old',state:'exited'}:null};
    } else if(name==='/projects/demo/releases/stage'&&opts.method==='POST'){
      staged=true;data={staged:true,revision};
    }else if(name==='/projects/demo/releases/promote'&&opts.method==='POST'){
      if(opts.body && JSON.parse(opts.body).expectedRevision!==revision)
        return {ok:false,status:409,json:async()=>({error:'wrong revision'})};
      promoted=true;data={promoted:true,revision};
    }else if(name==='/projects/demo/releases/recovery'){
      data={enabled:true,state:'ready',detail:'healthy'};
    }
    return {ok:!!data,status:data?200:404,json:async()=>data||{error:'not found'}};
  }
  const window={};
  runPanelUi(script,{
    document,window,fetch,confirm:(question)=>{confirmations.push(question);return true;},
    setTimeout:(cb)=>{Promise.resolve().then(cb);return 1;},
    clearTimeout:()=>{},
    location:{hash:'#projects'},console,Date,Error,URLSearchParams,Object,Promise,Set,Number
  });
  return {window,elements,calls,confirmations,get promoted(){return promoted;}};
}
async function exercise(unhealthy=false) {
  const env=harness(unhealthy);
  await env.window.refreshManagedProjects();
  await new Promise(resolve=>setImmediate(resolve));
  const project=env.elements.get('managedProjects').children[0];
  assert.ok(project,'Linked application must be shown');
  const [,actions,,runs]=project.children;
  const builds=actions.children.find(child=>child.textContent==='Consultar builds');
  assert.ok(builds,'Build list button missing');
  await builds.handlers.click();
  const revisionRow=runs.children[0];
  const publish=revisionRow.children.find(child=>child.textContent==='Publicar revisão');
  assert.ok(publish,'One-click publish button missing');
  await publish.handlers.click();
  return env;
}
test('one-click button queues backend job and does not orchestrate Docker from browser',async()=>{
  const h=await exercise();
  const steps=h.calls.filter(x=>x.method==='POST');
  assert.deepEqual(steps.map(x=>x.path),['/projects/demo/publication']);
  assert.equal(steps[0].data.runId,123);
  assert.equal(h.promoted,false,'Only the backend worker may promote revisions');
  assert.equal(h.confirmations.length,1);
  assert.match(h.elements.get('projectsNotice').textContent,/Publicado e verificado|A VPS continuará executando/);
});
test('publications are displayed as server jobs rather than client-owned deploy',async()=>{
  const h=await exercise(true);
  assert.equal(h.promoted,false);
  assert.ok(!h.calls.some(x=>x.path.includes('/promote')||x.path.includes('/stage')));
  assert.ok(h.calls.some(x=>x.path==='/projects/demo/publication'&&x.method==='GET'));
});
