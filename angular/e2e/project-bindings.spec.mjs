import { test, expect } from '@playwright/test';

const app=slug=>({slug,name:slug,image:'ghcr.io/softdown-prog/'+slug+':sha',
  state:'running',status:'Up',ramMb:256,cpuCores:0.5,diskUsedBytes:100, idleMinutes:30});
const apps=['alpha-app','alpha-worker','beta-app','beta-worker','free-app','free-worker'].map(app);
const repositoryA={fullName:'Softdown-prog/alpha',branch:'main',workflow:'panel-app-build.yml'};
const repositoryB={fullName:'Softdown-prog/beta',branch:'main',workflow:'panel-app-build.yml'};
const bindingA={slug:'alpha-app',repository:repositoryA.fullName,
  branch:'main',workflow:'panel-app-build.yml',services:['alpha-app']};
function fixture(page,{failApps=false}={}){
  const state={projects:[structuredClone(bindingA)],apps:[...apps],requests:[],
    failApps,failProjects:false,failRepositories:false,enabled:true};
  return page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.slice('/api'.length),
      method=request.method();
    const entry={method,path,body:request.postData()?request.postDataJSON():null};
    state.requests.push(entry);
    let status=200,body={};
    if(method==='GET'&&path==='/session')body={authenticated:true,setupRequired:false};
    else if(method==='GET'&&path==='/repositories'){
      if(state.failRepositories){status=503;body={error:'Repositórios indisponíveis'};}
      else body={repositories:[repositoryA,repositoryB],tokenConfigured:false,allowedOwner:'Softdown-prog'};
    }else if(method==='GET'&&path==='/repositories/Softdown-prog/alpha/runs')body={runs:[]};
    else if(method==='GET'&&path==='/repositories/Softdown-prog/beta/runs')body={runs:[]};
    else if(method==='GET'&&path==='/apps'){
      if(state.failApps){status=503;body={error:'Inventário indisponível'};}
      else body={enabled:state.enabled,applications:state.apps,maxApps:8,
        allowedImages:[],ramChoices:[256],cpuChoices:[0.5],idleChoices:[30]};
    }else if(method==='GET'&&path==='/projects'){
      if(state.failProjects){status=503;body={error:'Vínculos indisponíveis'};}
      else body={projects:state.projects,buildsEnabled:false,requiredWorkflow:'panel-app-build.yml'};
    }else if(method==='POST'&&path==='/projects'){
      const p=entry.body;
      state.projects.push({...p,branch:'main',workflow:'panel-app-build.yml'});
      status=201;body={project:p};
    }else if(method==='PUT'&&path==='/projects/alpha-app/services'){
      state.projects=state.projects.map(p=>p.slug==='alpha-app'?{...p,services:entry.body.services}:p);
      body={project:{slug:'alpha-app',repository:repositoryA.fullName,services:entry.body.services},
        message:'Serviços vinculados; containers preservados.'};
    }else if(method==='DELETE'&&path==='/projects/alpha-app'){
      state.projects=state.projects.filter(p=>p.slug!=='alpha-app');
      body={ok:true,message:'Vínculo removido; o container foi preservado.'};
    }else{status=503;body={error:'Rota não simulada: '+method+' '+path};}
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  }).then(()=>state);
}
async function open(page){
  await page.goto('/angular/#projects');
  const section=page.getByRole('region',{name:'Gerenciamento de vínculos e serviços'});
  await expect(section.getByRole('heading',{name:'Gerenciar vínculos e serviços'})).toBeVisible();
  await expect(page.locator('.managed-link')).toHaveCount(1);
  await expect(section.getByRole('button',{name:'Vincular aplicação'})).toBeEnabled();
  return section;
}
function changes(state){return state.requests.filter(x=>x.method!=='GET');}
test('inventário e listagem de vínculos são somente leitura',async ({page})=>{
  const state=await fixture(page);
  const section=await open(page);
  await expect(section.getByText('6 aplicações gerenciadas identificadas.',{exact:false})).toBeVisible();
  await expect(section.locator('.binding-row strong').first()).toHaveText('alpha-app');
  expect(changes(state)).toEqual([]);
});
test('novo vínculo exige confirmar slug e preserva os containers',async ({page})=>{
  const state=await fixture(page);
  const section=await open(page);
  await section.getByRole('button',{name:'Vincular aplicação'}).click();
  const editor=section.getByRole('group',{name:'Editor de vínculos e serviços'});
  await editor.getByRole('combobox',{name:'Aplicação principal'}).selectOption('free-app');
  await editor.getByRole('combobox',{name:'Repositório previamente conectado'}).selectOption(repositoryB.fullName);
  await editor.getByRole('checkbox',{name:'free-worker'}).check();
  await expect(editor.getByRole('button',{name:'Confirmar vínculo'})).toBeDisabled();
  expect(changes(state)).toEqual([]);
  await editor.getByRole('textbox',{name:/Digite exatamente/}).fill('VINCULAR free-app');
  await editor.getByRole('button',{name:'Confirmar vínculo'}).click();
  await expect(section.getByText('Aplicação vinculada ao repositório.',{exact:false})).toBeVisible();
  await expect(page.locator('.managed-link')).toHaveCount(2);
  expect(changes(state)).toEqual([{method:'POST',path:'/projects',
    body:{slug:'free-app',repository:repositoryB.fullName,services:['free-app','free-worker']}}]);
  expect(state.apps).toHaveLength(6);
});
test('edição de serviços valida o inventário e envia apenas PUT de associação',async ({page})=>{
  const state=await fixture(page);
  const section=await open(page);
  await section.getByRole('button',{name:'Editar serviços'}).click();
  const editor=section.getByRole('group',{name:'Editor de vínculos e serviços'});
  await expect(editor.getByRole('checkbox',{name:/alpha-app/})).toBeChecked();
  await expect(editor.getByRole('checkbox',{name:/alpha-app/})).toBeDisabled();
  await editor.getByRole('checkbox',{name:'alpha-worker'}).check();
  await expect(editor.getByRole('button',{name:'Salvar serviços'})).toBeDisabled();
  await editor.getByRole('textbox',{name:/Digite exatamente/}).fill('SERVICOS alpha-app');
  await editor.getByRole('button',{name:'Salvar serviços'}).click();
  await expect(section.getByText('Serviços associados no registro do painel.',{exact:false})).toBeVisible();
  await expect(page.locator('.managed-link').first()).toContainText('alpha-worker');
  expect(changes(state)).toEqual([{method:'PUT',path:'/projects/alpha-app/services',
    body:{services:['alpha-app','alpha-worker']}}]);
});
test('desvinculação não apaga aplicação e exige confirmação digitada',async ({page})=>{
  const state=await fixture(page);
  const section=await open(page);
  await section.getByRole('button',{name:'Desvincular'}).click();
  const editor=section.getByRole('group',{name:'Editor de vínculos e serviços'});
  await expect(editor.getByRole('button',{name:'Confirmar desvinculação'})).toBeDisabled();
  expect(changes(state)).toEqual([]);
  await editor.getByRole('textbox',{name:/Digite exatamente/}).fill('DESVINCULAR alpha-app');
  await editor.getByRole('button',{name:'Confirmar desvinculação'}).click();
  await expect(section.getByText('Vínculo removido.',{exact:false})).toBeVisible();
  await expect(page.locator('.managed-link')).toHaveCount(0);
  expect(changes(state)).toEqual([{method:'DELETE',path:'/projects/alpha-app',body:null}]);
  expect(state.apps.some(a=>a.slug==='alpha-app')).toBe(true);
});
test('atribuição concorrente de serviço a outro projeto impede PUT',async ({page})=>{
  const state=await fixture(page);
  const section=await open(page);
  await section.getByRole('button',{name:'Editar serviços'}).click();
  const editor=section.getByRole('group',{name:'Editor de vínculos e serviços'});
  await editor.getByRole('checkbox',{name:'alpha-worker'}).check();
  state.projects.push({slug:'beta-app',repository:repositoryB.fullName,branch:'main',
    workflow:'panel-app-build.yml',services:['beta-app','alpha-worker']});
  await editor.getByRole('textbox',{name:/Digite exatamente/}).fill('SERVICOS alpha-app');
  await editor.getByRole('button',{name:'Salvar serviços'}).click();
  await expect(section.getByRole('alert')).toContainText('Serviços alterados ou vinculados');
  expect(changes(state)).toEqual([]);
});
test('mudança de serviços vinculados enquanto confirma impede desvinculação',async ({page})=>{
  const state=await fixture(page);
  const section=await open(page);
  await section.getByRole('button',{name:'Desvincular'}).click();
  state.projects[0].services.push('alpha-worker');
  await section.getByRole('textbox',{name:/Digite exatamente/}).fill('DESVINCULAR alpha-app');
  await section.getByRole('button',{name:'Confirmar desvinculação'}).click();
  await expect(section.getByRole('alert')).toContainText('vínculo ou os serviços mudaram');
  expect(changes(state)).toEqual([]);
});
test('falha do inventário bloqueia associação sem bloquear desvinculação autenticada',async ({page})=>{
  const state=await fixture(page,{failApps:true});
  await page.goto('/angular/#projects');
  const section=page.getByRole('region',{name:'Gerenciamento de vínculos e serviços'});
  await expect(section.getByText('Inventário não confirmado:',{exact:false})).toBeVisible();
  await expect(section.getByRole('button',{name:'Vincular aplicação'})).toBeDisabled();
  await expect(section.getByRole('button',{name:'Editar serviços'})).toBeDisabled();
  await expect(section.getByRole('button',{name:'Desvincular'})).toBeEnabled();
  expect(changes(state)).toEqual([]);
});
test('controle de vínculos cabe na largura de 320 pixels',async ({page})=>{
  await fixture(page);
  await page.setViewportSize({width:320,height:750});
  const section=await open(page);
  await section.getByRole('button',{name:'Vincular aplicação'}).click();
  await expect(section.getByRole('group',{name:'Editor de vínculos e serviços'})).toBeVisible();
  const sizes=await page.evaluate(()=>({
    document:document.documentElement.scrollWidth,viewport:document.documentElement.clientWidth
  }));
  expect(sizes.document).toBeLessThanOrEqual(sizes.viewport+1);
});
