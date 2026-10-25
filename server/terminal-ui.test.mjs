import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../terminal-ui.js', import.meta.url), 'utf8');

function mount(responses = {}) {
  const elements = new Map();
  const requested = [];
  const confirms = [];
  function element(id) {
    if (!elements.has(id)) {
      const item = {
        id, value:'', textContent:'', disabled:false, className:'', dataset:{},
        handlers:{}, children:[], scrollHeight:0, scrollTop:0,
        classList:{ toggle(){} },
        addEventListener(event, cb){this.handlers[event]=cb;},
        append(item){this.children.push(item);},
        replaceChildren(){this.children=[];},
        setSelectionRange(){},focus(){},
        get childElementCount(){return this.children.length;},
        get firstElementChild(){return this.children[0]||null;}
      };
      elements.set(id,item);
    }
    return elements.get(id);
  }
  const api = async (url, options = {}) => {
    requested.push({ url, options });
    const key=options.method==='POST'?'POST '+url:url;
    const data=Object.hasOwn(responses,key) ? responses[key] : {error:'unsupported'};
    return { ok:!data.error, status:data.error?400:200, json:async()=>data };
  };
  const document = {
    getElementById:element,
    createElement:()=>({className:'',textContent:'',remove(){},classList:{toggle(){}},addEventListener(){}}),
    querySelectorAll:()=>[]
  };
  const window={ addEventListener(){} };
  runInNewContext(source,{document,window,fetch:api,location:{hash:'#overview'},confirm:message=>{confirms.push(message);return true;}, prompt:()=> 'secret-test-password', console,Number,String,Boolean,Array,Object,Date,Reflect,Math,RegExp,Error,encodeURIComponent});
  async function command(text) {
    const form=element('terminalForm');
    element('terminalInput').value=text;
    form.handlers.submit({preventDefault(){}});
    for(let i=0;i<30 && element('terminalRunButton').disabled;i++)await new Promise(r=>setImmediate(r));
    await new Promise(r=>setImmediate(r));
    return element('terminalOutput').children.map(x=>x.textContent).join('\n');
  }
  return {elements,requested,confirms,command};
}
test('CLI consults authenticated VPS API rather than simulating service state',async()=>{
  const cli=mount({
    '/api/services':{services:[{id:'app',state:'running',status:'Up 2 hours'},{id:'agent',state:'exited',status:'Stopped'}]},
    '/api/apps':{enabled:true,maxApps:8,applications:[{slug:'loja',state:'running',ramMb:256}]}
  });
  const services=await cli.command('servicos');
  assert.match(services,/app\s+● ativo/);
  assert.match(services,/agent\s+○ parado/);
  const apps=await cli.command('apps');
  assert.match(apps,/loja/);
  assert.ok(cli.requested.some(x=>x.url==='/api/services'));
  assert.ok(cli.requested.some(x=>x.url==='/api/apps'));
});
test('CLI confirms mutations and sends correct method to existing protected API',async()=>{
  const cli=mount({'POST /api/services/agent/restart':{ok:true}});
  const output=await cli.command('reiniciar agent');
  assert.match(output,/Concluído: reiniciar agent/);
  assert.equal(cli.confirms.length,1);
  const req=cli.requested.find(x=>x.url==='/api/services/agent/restart');
  assert.equal(req?.options.method,'POST');
});
test('CLI rejects shell commands without contacting the VPS',async()=>{
  const cli=mount({});
  const output=await cli.command('sudo rm -rf /');
  assert.match(output,/Comando não disponível|shell Linux/);
  assert.equal(cli.requested.length,0);
});
test('CLI creates a domain via the actual API and reports it as only reserved',async()=>{
  const cli=mount({'POST /api/domains':{route:{host:'loja.apps.analysepro.com'}}});
  const result=await cli.command('dominio criar loja 3000');
  assert.match(result,/loja.apps.analysepro.com/);
  assert.match(result,/ainda depende de DNS/);
  const request=cli.requested.find(x=>x.url==='/api/domains');
  assert.equal(request?.options.method,'POST');
  assert.equal(JSON.parse(request.options.body).port,3000);
});

test('opt-in Linux commands unlock with password and use SSH backend rather than browser shell', async()=>{
  const cli=mount({
    '/api/terminal/ssh/status':{enabled:true,configured:true,unlocked:false},
    'POST /api/terminal/ssh/unlock':{token:'a'.repeat(64),expiresInSeconds:600},
    'POST /api/terminal/ssh/exec':{exitCode:0,output:'vps online',timedOut:false,truncated:false}
  });
  const output=await cli.command('linux uptime');
  assert.match(output,/LINUX DA VPS/);
  assert.match(output,/vps online/);
  const unlock=cli.requested.find(x=>x.url==='/api/terminal/ssh/unlock');
  assert.equal(unlock?.options.method,'POST');
  assert.equal(JSON.parse(unlock.options.body).password,'secret-test-password');
  const execution=cli.requested.find(x=>x.url==='/api/terminal/ssh/exec');
  assert.equal(JSON.parse(execution.options.body).command,'uptime');
  assert.ok(!output.includes('secret-test-password'), 'Never expose password in terminal history');
});
