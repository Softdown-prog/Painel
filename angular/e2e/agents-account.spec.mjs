import {test,expect} from '@playwright/test';

async function fixture(page){
 const requests=[],projects=['Geral','Painel'];let active=false;
 const bindings={Painel:{repository:'Owner/Painel',branch:'main'}};
 const threads=[{id:'thread-existing',title:'Conversa existente',project:'Geral',status:'completed',reply:'',messages:[],model:null,effort:null}];
 await page.route('**/api/**',async route=>{
  const r=route.request(),path=new URL(r.url()).pathname,method=r.method(),input=method==='POST'?r.postDataJSON():null;
  requests.push({path,method,input});let result;
  if(path==='/api/session')result={authenticated:true,setupRequired:false};
  else if(path==='/api/agents/status')result={enabled:true,ready:true,operationsEnabled:true,projects,features:{accountRepositories:true,quotaWindows:true}};
  else if(path==='/api/agents/models')result={supported:true,configuredModel:null,configuredEffort:null,models:[{id:'codex-fixture',label:'Modelo da conta',efforts:['low','high'],isDefault:true}]};
  else if(path==='/api/agents/usage')result={checkedAt:'2026-11-08T10:00:00Z',quota:{available:false,buckets:[]},tokens:{available:false,daily:[]}};
  else if(path==='/api/agents/projects')result={bindings,repositories:[{fullName:'Owner/Painel',branch:'main'}]};
  else if(path==='/api/agents/github'){
   if(method==='POST')active=input.mode==='account';result={mode:active?'account':'registered',owner:'Owner',active};
  }else if(path==='/api/agents/github/repositories')result={repositories:[{fullName:'Owner/Private',branch:'trunk',private:true,readOnly:false},{fullName:'Owner/Another',branch:'main',private:false,readOnly:false}],hasMore:false};
  else if(path==='/api/agents/projects/open'){
   const project='gh_99_01234567';projects.push(project);bindings[project]={repository:input.repository,branch:'trunk'};result={project};
  }else if(path==='/api/agents/threads'){
   if(method==='POST'){const created={...threads[0],...input,id:'thread-new',title:'Novo projeto',messages:[]};threads.push(created);result={thread:created};}
   else result={threads};
  }else if(path.endsWith('/settings')){Object.assign(threads[0],input);result={ok:true};}
  else if(path.startsWith('/api/agents/threads/'))result={thread:threads.find(t=>path.endsWith(t.id))};
  else{await route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'Not mocked'})});return;}
  await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
 });
 return {requests};
}
test('reasoning is usable with automatic model and pins only the announced default when applied',async({page})=>{
 const f=await fixture(page);await page.goto('/angular/#agents');
 await expect(page.getByLabel('Modelo do Codex',{exact:true})).toHaveValue('');
 const effort=page.getByLabel('Nível de raciocínio',{exact:true});await expect(effort).toBeEnabled();
 await expect(effort.getByRole('option',{name:'Alto',exact:true})).toHaveCount(1);
 await effort.selectOption('high');await page.getByRole('button',{name:'Aplicar ao chat atual'}).click();
 await expect.poll(()=>f.requests.find(r=>r.path.endsWith('/settings'))?.input).toEqual({model:'codex-fixture',effort:'high'});
});
test('authorize account once and open an unregistered private repo without per-repo deploy registration',async({page})=>{
 const f=await fixture(page);await page.goto('/angular/#agents');
 expect(f.requests.filter(r=>r.method==='POST')).toHaveLength(0);
 await page.getByRole('button',{name:'Autorizar todos os meus repositórios',exact:true}).click();
 await expect(page.getByLabel('Repositório para trabalhar',{exact:true}).getByRole('option',{name:'Owner/Private · privado',exact:true})).toHaveCount(1);
 expect(f.requests.filter(r=>r.path==='/api/agents/projects/open')).toHaveLength(0,'authorization must not clone all repos');
 await page.getByLabel('Repositório para trabalhar',{exact:true}).selectOption('Owner/Private');
 await page.getByRole('button',{name:'Abrir no Codex',exact:true}).click();
 await expect(page.getByLabel('Tipo de conversa / projeto',{exact:true})).toHaveValue('gh_99_01234567');
 await expect(page.locator('.agent-thread-meta')).toContainText('gh_99_01234567');
 expect(f.requests.find(r=>r.path==='/api/agents/github'&&r.method==='POST').input).toEqual({mode:'account'});
 expect(f.requests.filter(r=>r.path==='/api/repositories')).toHaveLength(0);
 expect(f.requests.filter(r=>r.path==='/api/agents/projects/open')).toHaveLength(1);
});
