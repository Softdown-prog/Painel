import {test,expect} from '@playwright/test';

test('model, effort, weekly quota and saved chat history are presented without invented billing',async({page})=>{
 const calls=[];
 const active={id:'thread-live',project:'Painel',title:'Auditoria da API',status:'completed',reply:'',
  model:null,effort:null,effectiveModel:null,usage:{inputTokens:100,outputTokens:20,totalTokens:120},
  updatedAt:'2026-11-07T18:00:00.000Z',messages:[{role:'user',text:'Revisar API'}]};
 const other={id:'thread-old',project:'Geral',title:'Planejamento',status:'idle',reply:'',
  model:null,effort:null,updatedAt:'2026-11-06T10:00:00.000Z',messages:[]};
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()).pathname,method=req.method();
  calls.push({url,method,body:method==='POST'?req.postDataJSON():null});
  let data={},status=200;
  if(url==='/api/session')data={authenticated:true,setupRequired:false};
  else if(url==='/api/agents/status')data={enabled:true,ready:true,operationsEnabled:false,
   features:{modelSelection:true,quotaWindows:true,historySearch:true},projects:['Geral','Painel']};
  else if(url==='/api/agents/models')data={supported:true,configuredModel:'codex-test',configuredEffort:'medium',
   models:[{id:'codex-test',label:'Codex Test',efforts:['low','medium','high'],
    defaultEffort:'medium',isDefault:true}]};
  else if(url==='/api/agents/usage')data={checkedAt:'2026-11-07T18:00:00.000Z',
   quota:{available:true,resetCreditsAvailable:2,ordinaryUsageAllowed:true,
    buckets:[{id:'codex',label:'codex',
    primary:{usedPercent:23,windowDurationMins:300,resetsAt:1800000000},
    secondary:{usedPercent:43,windowDurationMins:10080,resetsAt:1800080000}}]},
   tokens:{available:true,lifetimeTokens:123456,daily:[{date:'2026-11-07',tokens:300}]}};
  else if(url==='/api/agents/threads')data={threads:[active,other]};
  else if(url==='/api/agents/threads/thread-live')data={thread:active};
  else if(url==='/api/agents/threads/thread-old')data={thread:other};
  else if(url==='/api/agents/threads/thread-live/settings'){
   Object.assign(active,req.postDataJSON());data={ok:true};
  }else if(url==='/api/agents/threads/thread-live/title'){
   active.title=req.postDataJSON().title;data={ok:true};
  }else{data={error:'Não simulado'};status=404;}
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.goto('/angular/#agents');
 await expect(page.getByRole('heading',{name:'Agentes · Codex'})).toBeVisible();
 await expect(page.getByRole('button',{name:/Auditoria da API/})).toBeVisible();
 await page.getByText('Uso e limites do Codex').click();
 await expect(page.getByText('Janela de 7 dias')).toBeVisible();
 await expect(page.getByText('43% utilizado')).toBeVisible();
 await expect(page.getByText('57% disponível')).toBeVisible();
 await expect(page.getByText('77% disponível')).toBeVisible();
 await expect(page.getByText('Créditos de redefinição disponíveis:')).toBeVisible();
 await expect(page.getByText('Consulta informativa. Nenhum crédito será usado automaticamente pelo Painel.')).toBeVisible();
 await expect(page.getByText('restantes',{exact:false}).first()).toBeVisible();
 await expect(page.getByText('Tokens totais informados pela conta:')).toBeVisible();
 await expect(page.getByText('Tokens não representam valor em reais',{exact:false})).toBeVisible();
 await expect(page.getByText('Modelo configurado no servidor:',{exact:false})).toContainText('codex-test');
 await page.getByLabel('Modelo do Codex').selectOption('codex-test');
 await page.getByLabel('Nível de raciocínio').selectOption('high');
 await page.getByRole('button',{name:'Aplicar ao chat atual'}).click();
 await expect.poll(()=>calls.findLast(c=>c.url.endsWith('/settings'))?.body).toEqual({model:'codex-test',effort:'high'});
 await page.getByLabel('Título da conversa').fill('Diagnóstico de sessão');
 await page.getByRole('button',{name:'Renomear'}).click();
 await expect(page.getByRole('button',{name:/Diagnóstico de sessão/})).toBeVisible();
 await page.getByLabel('Pesquisar conversas').fill('planeja');
 await expect(page.getByRole('button',{name:/Planejamento/})).toBeVisible();
 await expect(page.getByRole('button',{name:/Diagnóstico de sessão/})).toHaveCount(0);
 expect(calls.filter(c=>c.method==='POST').map(c=>c.url)).toEqual([
  '/api/agents/threads/thread-live/settings','/api/agents/threads/thread-live/title']);
});
