import { test, expect } from '@playwright/test';

const repositories=[
  {fullName:'Softdown-prog/alpha',branch:'main',workflow:'deploy.yml'},
  {fullName:'Softdown-prog/beta',branch:'main',workflow:'deploy.yml'}
];
const projects=[
  {slug:'alpha-app',repository:'Softdown-prog/alpha',branch:'main',
    workflow:'deploy.yml',services:['alpha-app']},
  {slug:'beta-app',repository:'Softdown-prog/beta',branch:'main',
    workflow:'deploy.yml',services:['beta-app','beta-worker']}
];
function run(id){
  return {id,sha:String(id).padStart(40,'a'),branch:'main',status:'completed',
    conclusion:'success',createdAt:'2026-10-31T12:00:00Z'};
}
const revisionReport={
  checkedAt:'2026-10-31T12:00:00Z',enabled:true,automatic:false,
  ageDays:14,keepPerApp:2,oldCount:1,oldBytesEstimate:1048576,totalImports:1,
  entries:[{slug:'alpha-app',revision:'a'.repeat(40),importedAt:'2026-10-01T12:00:00Z',
    sizeBytes:1048576,status:'antiga',reason:'Imagem antiga elegível'}],
  history:[],
  hostInventory:{available:true,total:1,untagged:0,totalBytesEstimate:1048576,
    images:[],multipleVersionRepositories:[]}
};

async function fixture(page,{failLinks=false,holdFirstRun=false}={}){
  const state={requests:[],releaseFirst:null};
  await page.route('**/api/**',async route=>{
    const req=route.request();
    const path=new URL(req.url()).pathname.slice('/api'.length);
    const method=req.method();
    state.requests.push({method,path});
    if(holdFirstRun&&path==='/repositories/Softdown-prog/alpha/runs'){
      await new Promise(resolve=>{state.releaseFirst=resolve;});
    }
    let body, status=200;
    if(method==='GET'&&path==='/session'){
      body={authenticated:true,setupRequired:false};
    }else if(method==='GET'&&path==='/repositories'){
      body={repositories,tokenConfigured:false,allowedOwner:'Softdown-prog'};
    }else if(method==='GET'&&path==='/projects'){
      if(failLinks){status=503;body={error:'Vínculos não disponíveis no teste'};}
      else body={projects,buildsEnabled:false,requiredWorkflow:'panel-app-build.yml'};
    }else if(method==='GET'&&path==='/repositories/Softdown-prog/alpha/runs'){
      body={runs:[run(101)]};
    }else if(method==='GET'&&path==='/repositories/Softdown-prog/beta/runs'){
      body={runs:[run(202)]};
    }else if(method==='GET'&&path==='/terminal/ssh/status'){
      body={enabled:true,configured:true};
    }else if(method==='POST'&&path==='/terminal/ssh/exec'){
      body={exitCode:0,output:'saída de teste, sem VPS',truncated:false,timedOut:false};
    }else if(method==='GET'&&path==='/maintenance/revisions'){
      body=revisionReport;
    }else if(method==='POST'&&path==='/maintenance/revisions/cleanup'){
      body={removed:1,failed:0};
    }else{
      status=503;body={error:'Endpoint ausente da fixture: '+method+' '+path};
    }
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  return state;
}

test('Projetos GitHub recupera os vínculos clássicos sem alterar o backend',async ({page})=>{
  const state=await fixture(page);
  await page.goto('/angular/#projects');
  await expect(page.getByRole('heading',{name:'Vínculos de aplicações'})).toBeVisible();
  await expect(page.locator('.managed-link')).toHaveCount(2);
  await expect(page.locator('.managed-link').first()).toContainText('alpha-app');
  await expect(page.locator('.managed-link').last()).toContainText('beta-worker');
  await expect(page.locator('.managed-link a').first()).toHaveAttribute('href','/angular/#site?slug=alpha-app');
  expect(state.requests.filter(r=>r.method!=='GET')).toEqual([]);
});

test('falha parcial dos vínculos não transforma API indisponível em lista vazia',async ({page})=>{
  await fixture(page,{failLinks:true});
  await page.goto('/angular/#projects');
  await expect(page.getByRole('heading',{name:'Repositórios cadastrados'})).toBeVisible();
  await expect(page.locator('.repo-choice')).toHaveCount(2);
  await expect(page.getByRole('alert',{name:''})).toContainText('Vínculos indisponíveis:');
  await expect(page.getByText('Nenhuma aplicação vinculada a um projeto segundo a API.')).toHaveCount(0);
});

test('troca rápida de repositório descarta resposta antiga de execuções',async ({page})=>{
  const state=await fixture(page,{holdFirstRun:true});
  await page.goto('/angular/#projects');
  await expect.poll(()=>state.releaseFirst!==null).toBe(true);
  await page.locator('.repo-choice').filter({hasText:'Softdown-prog/beta'}).click();
  await expect(page.locator('.recent-run')).toContainText('#202');
  state.releaseFirst();
  await expect(page.locator('.recent-run')).toContainText('#202');
  await expect(page.locator('.recent-run')).not.toContainText('#101');
  await expect(page.getByText('Consultando execuções do GitHub…')).toHaveCount(0);
});

test('Terminal Angular não executa comando antes da confirmação explícita',async ({page})=>{
  const state=await fixture(page);
  await page.goto('/angular/#terminal');
  await expect(page.getByText('Terminal SSH habilitado e configurado')).toBeVisible();
  await page.locator('#sshCommand').fill('uname -a');
  await page.getByRole('button',{name:'Preparar execução'}).click();
  await expect(page.getByRole('group',{name:'Confirmar execução na VPS'})).toBeVisible();
  expect(state.requests.some(r=>r.method==='POST')).toBe(false);
  await page.getByRole('button',{name:'Cancelar'}).click();
  expect(state.requests.some(r=>r.method==='POST')).toBe(false);
  await page.getByRole('button',{name:'Preparar execução'}).click();
  await page.getByRole('button',{name:'Confirmar execução'}).click();
  await expect(page.getByText('saída de teste, sem VPS')).toBeVisible();
  expect(state.requests.filter(r=>r.method==='POST'&&r.path==='/terminal/ssh/exec')).toHaveLength(1);
});

test('Revisões exige digitar LIMPAR para habilitar limpeza de imagens',async ({page})=>{
  const state=await fixture(page);
  await page.goto('/angular/#revisions');
  await expect(page.getByText('Imagem antiga elegível')).toBeVisible();
  await page.getByRole('button',{name:'Limpar imagens antigas elegíveis'}).click();
  const confirm=page.getByRole('group',{name:'Confirmar alteração de revisões'});
  await expect(confirm.getByRole('button',{name:'Confirmar alteração'})).toBeDisabled();
  expect(state.requests.some(r=>r.method==='POST')).toBe(false);
  await confirm.getByRole('textbox',{name:'Digite LIMPAR para confirmar'}).fill('LIMPAR');
  await expect(confirm.getByRole('button',{name:'Confirmar alteração'})).toBeEnabled();
  await confirm.getByRole('button',{name:'Cancelar'}).click();
  expect(state.requests.some(r=>r.method==='POST')).toBe(false);
});

test('vínculos GitHub permanecem responsivos em tela de 320 pixels',async ({page})=>{
  await fixture(page);
  await page.setViewportSize({width:320,height:640});
  await page.goto('/angular/#projects');
  await expect(page.locator('.managed-link')).toHaveCount(2);
  const size=await page.evaluate(()=>({
    viewport:document.documentElement.clientWidth,
    content:document.documentElement.scrollWidth
  }));
  expect(size.content).toBeLessThanOrEqual(size.viewport+1);
});
