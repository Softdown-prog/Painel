import {test,expect} from '@playwright/test';

const SHA='a'.repeat(40),OTHER='b'.repeat(40);
const job=(id,slug,phase,overrides={})=>({
  id,slug,repository:slug==='alpha-app'?'Softdown-prog/alpha':'Softdown-prog/beta',
  runId:414,revision:SHA,phase,detail:'Estado da publicação '+phase,
  createdAt:'2026-10-31T12:00:00Z',updatedAt:'2026-10-31T12:01:00Z',
  ...overrides
});
const REPOS=[
  {fullName:'Softdown-prog/Painel',branch:'main',workflow:'deploy-vps.yml'},
  {fullName:'Softdown-prog/alpha',branch:'main',workflow:'panel-app-build.yml'}
];
async function fixture(page,{history=[],historyError=false,runError=false,repositoryError=false}={}){
  const state={history,historyError,runError,repositoryError,requests:[]};
  await page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.slice('/api'.length);
    const method=request.method();
    state.requests.push(method+' '+path);
    let status=200,body;
    if(method==='GET'&&path==='/session')body={authenticated:true,setupRequired:false};
    else if(method==='GET'&&path==='/repositories'){
      if(state.repositoryError){status=503;body={error:'GitHub repositórios indisponível'};}
      else body={repositories:REPOS,tokenConfigured:true,allowedOwner:'Softdown-prog'};
    }
    else if(method==='GET'&&path==='/projects')
      body={projects:[{slug:'alpha-app',repository:'Softdown-prog/alpha',
        branch:'main',workflow:'panel-app-build.yml',services:['alpha-app']}],
        requiredWorkflow:'panel-app-build.yml',buildsEnabled:true};
    else if(method==='GET'&&path==='/publications'){
      if(state.historyError){status=503;body={error:'Histórico indisponível'};}
      else body={history:state.history};
    }else if(method==='GET'&&path.endsWith('/runs-all')){
      if(state.runError){status=503;body={error:'GitHub indisponível'};}
      else body={runs:[]};
    }else if(method==='GET'&&path==='/panel-version')
      body={current:{state:'running',revision:OTHER}};
    else if(method==='GET'&&path==='/projects/alpha-app/releases')
      body={current:{state:'running',revision:OTHER},candidate:null,backup:null};
    else{status=503;body={error:'Endpoint fora da simulação: '+method+' '+path};}
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  return state;
}
async function open(page){
  await page.goto('/angular/#deployments');
  const section=page.getByRole('region',{name:'Histórico persistente de publicações'});
  await expect(section.getByRole('heading',{name:'Publicações persistentes na VPS'})).toBeVisible();
  return section;
}
test('sem publicações: API confirmada exibe lista vazia, sem trabalho inventado',async ({page})=>{
  const state=await fixture(page);
  const section=await open(page);
  await expect(section.getByText('Nenhuma publicação persistente registrada pela API nesta consulta.')).toBeVisible();
  await expect(section.getByText('Histórico não confirmado')).toHaveCount(0);
  expect(state.requests.some(x=>!x.startsWith('GET '))).toBe(false);
});
test('trabalhos da VPS aparecem mesmo sem builds correspondentes no GitHub',async ({page})=>{
  const state=await fixture(page,{history:[
    job('job-1','alpha-app','queued'),
    job('job-2','beta-app','attention',{runId:622,detail:'Precisou de recuperação manual'})
  ]});
  const section=await open(page);
  await expect(section.getByText('1 em andamento · 1 exigem atenção')).toBeVisible();
  const rows=section.locator('.durable-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('alpha-app');
  await expect(rows.first()).toContainText('Na fila');
  await expect(rows.last()).toContainText('beta-app');
  await expect(rows.last()).toContainText('Precisou de recuperação manual');
  await expect(rows.last().locator('.durable-stage.danger')).toBeVisible();
  await expect(page.getByText('Nenhuma execução encontrada para esta branch.').first()).toBeVisible();
  expect(state.requests.some(x=>!x.startsWith('GET '))).toBe(false);
});
test('worker concluído não ganha selo verde de versão instalada',async ({page})=>{
  await fixture(page,{history:[job('job-3','alpha-app','completed')]});
  const section=await open(page);
  const row=section.locator('.durable-row');
  await expect(row).toContainText('Worker concluiu; confira o container');
  await expect(row.locator('.durable-stage.warning')).toBeVisible();
  await expect(row.locator('.durable-stage.success')).toHaveCount(0);
  await expect(row).toContainText('não implica container instalado');
});
test('fase desconhecida ou job inválido falham de modo conservador',async ({page})=>{
  await fixture(page,{history:[
    job('job-4','alpha-app','misterioso'),
    job('job-5','alpha-app','completed',{revision:'SHA-inválido'})
  ]});
  const section=await open(page);
  await expect(section.getByText('Histórico não confirmado')).toBeVisible();
  await expect(section.getByText('O histórico contém registros desconhecidos ou inválidos;', {exact:false})).toBeVisible();
  await expect(section.locator('.durable-row')).toHaveCount(0);
});
test('falha do histórico distingue indisponibilidade de zero publicações',async ({page})=>{
  await fixture(page,{historyError:true});
  const section=await open(page);
  await expect(section.getByText('Histórico não confirmado')).toBeVisible();
  await expect(section.getByText('Histórico de publicações não confirmado.',{exact:false})).toBeVisible();
  await expect(section.getByText('Nenhuma publicação persistente registrada pela API nesta consulta.')).toHaveCount(0);
});
test('histórico continua visível se o GitHub não responder',async ({page})=>{
  await fixture(page,{history:[job('job-6','alpha-app','health')],runError:true});
  const section=await open(page);
  await expect(section.locator('.durable-row')).toContainText('Testando saúde');
  await expect(page.getByText('Execuções do GitHub indisponíveis.').first()).toBeVisible();
});
test('após erro de atualização, não mantém job antigo como se fosse atual',async ({page})=>{
  const state=await fixture(page,{history:[job('job-7','alpha-app','queued')]});
  const section=await open(page);
  await expect(section.locator('.durable-row')).toHaveCount(1);
  state.historyError=true;
  await page.getByRole('button',{name:'Atualizar agora'}).click();
  await expect(section.locator('.durable-row')).toHaveCount(0);
  await expect(section.getByText('Histórico não confirmado')).toBeVisible();
  expect(state.requests.some(x=>!x.startsWith('GET '))).toBe(false);
});
test('histórico permanece responsivo em 320px sem scroll horizontal',async ({page})=>{
  await fixture(page,{history:[job('job-8','alpha-app','promoting',{detail:'Inspeção persistida de integração multiprojetos'})]});
  await page.setViewportSize({width:320,height:720});
  const section=await open(page);
  await expect(section.locator('.durable-row')).toBeVisible();
  const width=await page.evaluate(()=>({
    visible:document.documentElement.clientWidth,total:document.documentElement.scrollWidth
  }));
  expect(width.total).toBeLessThanOrEqual(width.visible+1);
});

test('histórico persistente não depende de GET /repositories responder',async ({page})=>{
  const state=await fixture(page,{repositoryError:true,history:[
    job('job-9','alpha-app','attention',{detail:'Intervenção no serviço'})]});
  const section=await open(page);
  await expect(section.locator('.durable-row')).toHaveCount(1);
  await expect(section.locator('.durable-row')).toContainText('Intervenção no serviço');
  await expect(page.getByText('Não foi possível confirmar os repositórios GitHub nesta consulta.')).toBeVisible();
  await expect(page.getByText('Nenhum repositório encontrado')).toHaveCount(0);
  expect(state.requests).toContain('GET /publications');
  expect(state.requests.some(x=>!x.startsWith('GET '))).toBe(false);
});

test('um trabalho inválido impede classificação até dos registros válidos na mesma resposta',async ({page})=>{
  await fixture(page,{history:[
    job('job-10','alpha-app','completed'),
    job('job-11','beta-app','unexpected-phase')
  ]});
  const section=await open(page);
  await expect(section.getByText('Histórico não confirmado')).toBeVisible();
  await expect(section.locator('.durable-row')).toHaveCount(0);
  await expect(section.getByText('O histórico contém registros desconhecidos ou inválidos;', {exact:false})).toBeVisible();
});
