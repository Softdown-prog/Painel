import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runPanelUi } from './ui-fixture.mjs';
const source = readFileSync(new URL('../terminal-ui.js', import.meta.url), 'utf8');

function mount(responses = {}) {
  const elements = new Map();
  const requested = [];
  const confirms = [];
  const copied = [];
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
    createElement:()=>({className:'',textContent:'',children:[],handlers:{},remove(){},classList:{toggle(){}},
      setAttribute(){},append(child){this.children.push(child);},addEventListener(event,cb){this.handlers[event]=cb;}}),
    querySelectorAll:()=>[]
  };
  const window={ addEventListener(){} };
  const navigator={clipboard:{writeText:async text=>{copied.push(text);}}};
  runPanelUi(source,{document,window,navigator,fetch:api,location:{hash:'#overview'},confirm:message=>{confirms.push(message);return true;}, prompt:()=>{throw new Error('Unexpected password prompt');}, console,Number,String,Boolean,Array,Object,Date,Reflect,Math,RegExp,Error,encodeURIComponent});
  async function command(text) {
    const form=element('terminalForm');
    element('terminalInput').value=text;
    form.handlers.submit({preventDefault(){}});
    for(let i=0;i<30 && element('terminalRunButton').disabled;i++)await new Promise(r=>setImmediate(r));
    await new Promise(r=>setImmediate(r));
    return element('terminalOutput').children.map(x=>x.textContent).join('\n');
  }
  return {elements,requested,confirms,copied,command};
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
test('CLI forwards direct shell commands through the SSH backend and masks tokens on screen',async()=>{
  const token='cfut_'+ 'a'.repeat(48);
  const cli=mount({
    '/api/terminal/ssh/status':{enabled:true,configured:true},
    'POST /api/terminal/ssh/exec':{exitCode:0,output:'ok',timedOut:false,truncated:false}
  });
  const output=await cli.command('curl -H "Authorization: Bearer '+token+'" https://api.cloudflare.com/client/v4/user/tokens/verify');
  assert.match(output,/SHELL DA VPS/);
  assert.ok(!output.includes(token), 'Never show token in terminal output/history');
  const execution=cli.requested.find(x=>x.url==='/api/terminal/ssh/exec');
  assert.ok(JSON.parse(execution.options.body).command.includes(token), 'The original command reaches only the SSH backend');
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

test('Linux commands use the authenticated panel session without a second password', async()=>{
  const cli=mount({
    '/api/terminal/ssh/status':{enabled:true,configured:true},
    'POST /api/terminal/ssh/exec':{exitCode:0,output:'vps online',timedOut:false,truncated:false}
  });
  const output=await cli.command('linux uptime');
  assert.match(output,/SHELL DA VPS/);
  assert.match(output,/vps online/);
  assert.equal(cli.requested.some(x=>x.url==='/api/terminal/ssh/unlock'),false);
  const execution=cli.requested.find(x=>x.url==='/api/terminal/ssh/exec');
  assert.deepEqual(JSON.parse(execution.options.body),{command:'uptime'});
});
test('each terminal response has a mobile copy button that copies only that response',async()=>{
  const cli=mount({
    '/api/terminal/ssh/status':{enabled:true,configured:true},
    'POST /api/terminal/ssh/exec':{exitCode:0,output:'linha 1\nlinha 2',timedOut:false,truncated:false}
  });
  await cli.command('linux uptime');
  const lines=cli.elements.get('terminalOutput').children;
  const response=lines.find(line=>line.className==='terminal-line terminal-response');
  const button=response.children[0];
  assert.equal(button.textContent,'Copiar saída');
  await button.handlers.click();
  assert.equal(button.textContent,'Copiado');
  assert.deepEqual(cli.copied,[response.textContent]);
});
