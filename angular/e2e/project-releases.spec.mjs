import { test, expect } from '@playwright/test';

const SHA='a'.repeat(40), OTHER='b'.repeat(40);
const project={
  slug:'alpha-app',repository:'Softdown-prog/alpha',branch:'main',
  workflow:'panel-app-build.yml',services:['alpha-app']
};
function mockReleaseApi(page,{buildsEnabled=true,rollbackBackup=true,publicationPhase=null,importedRevision=SHA}={}){
  const state={requests:[],payloads:[],project:{...project},buildsEnabled,rollbackBackup,
    currentSha:SHA,publicationPhase,importedRevision,importJob:null,candidate:null,
    runStatus:'completed',runConclusion:'success',failProjectValidation:false};
  const ready=page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.slice('/api'.length),
      method=request.method();
    state.requests.push(method+' '+path);
    if(method==='POST'&&request.postData())state.payloads.push({path,payload:request.postDataJSON()});
    let status=200,body;
    if(method==='GET'&&path==='/session')body={authenticated:true,setupRequired:false};
    else if(method==='GET'&&path==='/repositories'){
      body={repositories:[{fullName:project.repository,branch:'main',workflow:'panel-app-build.yml'}],
        tokenConfigured:true,allowedOwner:'Softdown-prog'};
    }else if(method==='GET'&&path==='/repositories/Softdown-prog/alpha/runs'){
      body={runs:[]};
    }else if(method==='GET'&&path==='/projects'){
      body={projects:state.failProjectValidation?[]:[state.project],
        buildsEnabled:state.buildsEnabled,requiredWorkflow:'panel-app-build.yml'};
    }else if(method==='GET'&&path==='/projects/alpha-app/releases'){
      body={enabled:true,slug:project.slug,
        current:{state:'running',revision:state.currentSha,image:'ghcr.io/softdown-prog/alpha:current'},
        candidate:state.candidate,
        backup:state.rollbackBackup?{image:'ghcr.io/softdown-prog/alpha:backup',state:'exited'}:null};
    }else if(method==='GET'&&path==='/projects/alpha-app/publication'){
      body={enabled:true,current:state.publicationPhase?{
        phase:state.publicationPhase,detail:'Executando',runId:414}:null};
    }else if(method==='GET'&&path==='/projects/alpha-app/images/import'){
      body={enabled:true,job:state.importJob,imported:state.importedRevision?{
        revision:state.importedRevision,digest:'sha256:'+'c'.repeat(64),importedAt:'2026-10-30T12:00:00Z'}:null};
    }else if(method==='GET'&&path==='/projects/alpha-app/runs'){
      body={slug:project.slug,runs:[{id:414,sha:SHA,status:state.runStatus,
        conclusion:state.runConclusion,createdAt:'2026-10-30T12:00:00Z'}]};
    }else if(method==='POST'&&path==='/projects/alpha-app/build'){
      body={accepted:true,slug:project.slug,repository:project.repository};
    }else if(method==='POST'&&path==='/projects/alpha-app/images/import'){
      state.importJob={status:'running',message:'Importação iniciada'};
      body={accepted:true,revision:SHA,digest:'sha256:'+'c'.repeat(64)};
    }else if(method==='POST'&&path==='/projects/alpha-app/releases/stage'){
      state.candidate={revision:SHA,state:'running',health:'starting'};
      body={staged:true,revision:SHA};
    }else if(method==='POST'&&path==='/projects/alpha-app/releases/rollback'){
      state.rollbackBackup=false;state.currentSha=OTHER;
      body={rolledBack:true,message:'Backup restaurado pelo executor simulado'};
    }else{
      status=503;body={error:'Endpoint não simulado: '+method+' '+path};
    }
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  return ready.then(()=>state);
}
async function openReleasePanel(page){
  await page.goto('/angular/#projects');
  await expect(page.locator('.managed-link')).toHaveCount(1);
  await page.getByRole('button',{name:'Consultar builds e versões'}).click();
  const panel=page.getByRole('region',{name:'Builds e versões de alpha-app'});
  await expect(panel.getByText('Em execução · '+SHA.slice(0,12))).toBeVisible();
  return panel;
}

test('inspeção de versões e build aprovado é estritamente somente leitura',async ({page})=>{
  const state=await mockReleaseApi(page);
  const panel=await openReleasePanel(page);
  await expect(panel.getByText('ghcr.io/softdown-prog/alpha:backup')).toBeVisible();
  await expect(panel.getByText('Imagem '+SHA.slice(0,12),{exact:false})).toBeVisible();
  await expect(panel.getByText(/#414/)).toBeVisible();
  expect(state.requests.some(r=>r.startsWith('POST ')||r.startsWith('DELETE '))).toBe(false);
});

test('build exige confirmação digitada e revalidação de vínculo e workflow',async ({page})=>{
  const state=await mockReleaseApi(page);
  const panel=await openReleasePanel(page);
  await panel.getByRole('button',{name:'Solicitar novo build'}).click();
  const confirmation=panel.getByRole('group',{name:'Confirmação de build ou rollback'});
  await expect(confirmation.getByRole('button',{name:'Confirmar build'})).toBeDisabled();
  expect(state.requests.some(r=>r.startsWith('POST '))).toBe(false);
  await confirmation.getByRole('textbox',{name:/Digite exatamente/}).fill('alpha-app');
  await confirmation.getByRole('button',{name:'Confirmar build'}).click();
  await expect(panel.getByText(/Build solicitado ao GitHub/)).toBeVisible();
  expect(state.requests.filter(r=>r==='POST /projects/alpha-app/build')).toHaveLength(1);
});

test('build desabilitado pela API nunca gera requisição POST',async ({page})=>{
  const state=await mockReleaseApi(page,{buildsEnabled:false});
  const panel=await openReleasePanel(page);
  await expect(panel.getByRole('button',{name:'Solicitar novo build'})).toBeDisabled();
  await expect(panel.getByText('Builds estão desabilitados nesta configuração da API.')).toBeVisible();
  expect(state.requests.some(r=>r.startsWith('POST '))).toBe(false);
});

test('vínculo alterado durante confirmação cancela solicitação de build',async ({page})=>{
  const state=await mockReleaseApi(page);
  const panel=await openReleasePanel(page);
  await panel.getByRole('button',{name:'Solicitar novo build'}).click();
  state.failProjectValidation=true;
  await panel.getByRole('textbox',{name:/Digite exatamente/}).fill('alpha-app');
  await panel.getByRole('button',{name:'Confirmar build'}).click();
  await expect(panel.getByRole('alert')).toContainText('Vínculo ou workflow do projeto mudou');
  expect(state.requests.some(r=>r==='POST /projects/alpha-app/build')).toBe(false);
});

test('rollback só envia POST após digitação exata e verificações da versão e da publicação',async ({page})=>{
  const state=await mockReleaseApi(page);
  const panel=await openReleasePanel(page);
  await panel.getByRole('button',{name:'Restaurar versão anterior'}).click();
  const confirmation=panel.getByRole('group',{name:'Confirmação de build ou rollback'});
  await expect(confirmation.getByRole('button',{name:'Confirmar rollback'})).toBeDisabled();
  expect(state.requests.some(r=>r.startsWith('POST '))).toBe(false);
  await confirmation.getByRole('textbox',{name:/Digite exatamente/}).fill('RESTAURAR alpha-app');
  await confirmation.getByRole('button',{name:'Confirmar rollback'}).click();
  await expect(panel.getByText(/Rollback confirmado pela API/)).toBeVisible();
  expect(state.requests.filter(r=>r==='POST /projects/alpha-app/releases/rollback')).toHaveLength(1);
  await expect(panel.getByText('Em execução · '+OTHER.slice(0,12))).toBeVisible();
});

for(const phase of ['health','indefinido']){
  test('rollback é bloqueado se a publicação está ativa ou em fase desconhecida: '+phase,async ({page})=>{
    const state=await mockReleaseApi(page,{publicationPhase:phase});
    const panel=await openReleasePanel(page);
    await expect(panel.getByRole('button',{name:'Restaurar versão anterior'})).toBeDisabled();
    expect(state.requests.some(r=>r.startsWith('POST '))).toBe(false);
  });
}

test('rollback cancela se revisão mudou após exibir o botão de confirmação',async ({page})=>{
  const state=await mockReleaseApi(page);
  const panel=await openReleasePanel(page);
  await panel.getByRole('button',{name:'Restaurar versão anterior'}).click();
  state.currentSha=OTHER;
  await panel.getByRole('textbox',{name:/Digite exatamente/}).fill('RESTAURAR alpha-app');
  await panel.getByRole('button',{name:'Confirmar rollback'}).click();
  await expect(panel.getByRole('alert')).toContainText('Estado da versão ou publicação mudou');
  expect(state.requests.some(r=>r==='POST /projects/alpha-app/releases/rollback')).toBe(false);
});

test('painel de versões permanece dentro da largura de 320px',async ({page})=>{
  await mockReleaseApi(page);
  await page.setViewportSize({width:320,height:740});
  const panel=await openReleasePanel(page);
  await expect(panel.getByRole('button',{name:'Solicitar novo build'})).toBeVisible();
  const width=await page.evaluate(()=>({
    visible:document.documentElement.clientWidth,
    total:document.documentElement.scrollWidth
  }));
  expect(width.total).toBeLessThanOrEqual(width.visible+1);
});

test('importação GHCR exige build aprovado, confirmação digitada e payload do run selecionado',async ({page})=>{
  const state=await mockReleaseApi(page,{rollbackBackup:false,importedRevision:null});
  const panel=await openReleasePanel(page);
  const importButton=panel.getByRole('button',{name:'Importar GHCR · #414'});
  await expect(importButton).toBeEnabled();
  await expect(panel.getByRole('button',{name:'Preparar candidata · #414'})).toBeDisabled();
  await importButton.click();
  const confirm=panel.getByRole('group',{name:'Confirmação de build ou rollback'});
  await expect(confirm.getByRole('button',{name:'Confirmar importação'})).toBeDisabled();
  expect(state.requests.filter(r=>r.startsWith('POST '))).toHaveLength(0);
  await confirm.getByRole('textbox',{name:/Digite exatamente/}).fill('IMPORTAR alpha-app');
  await confirm.getByRole('button',{name:'Confirmar importação'}).click();
  await expect(panel.getByText('Importação aceita pela API.',{exact:false})).toBeVisible();
  expect(state.payloads.filter(v=>v.path==='/projects/alpha-app/images/import'))
    .toEqual([{path:'/projects/alpha-app/images/import',payload:{runId:414}}]);
  await expect(panel.getByRole('button',{name:'Preparar candidata · #414'})).toBeDisabled();
});

test('preparação exige importação verificada da mesma revisão e confirmação exata',async ({page})=>{
  const state=await mockReleaseApi(page,{rollbackBackup:false});
  const panel=await openReleasePanel(page);
  await expect(panel.getByRole('button',{name:'Importar GHCR · #414'})).toBeDisabled();
  await panel.getByRole('button',{name:'Preparar candidata · #414'}).click();
  const confirm=panel.getByRole('group',{name:'Confirmação de build ou rollback'});
  await expect(confirm.getByRole('button',{name:'Confirmar preparação'})).toBeDisabled();
  expect(state.requests.filter(r=>r.startsWith('POST '))).toHaveLength(0);
  await confirm.getByRole('textbox',{name:/Digite exatamente/}).fill('PREPARAR alpha-app');
  await confirm.getByRole('button',{name:'Confirmar preparação'}).click();
  await expect(panel.getByText('Candidata solicitada.',{exact:false})).toBeVisible();
  expect(state.payloads.filter(v=>v.path==='/projects/alpha-app/releases/stage'))
    .toEqual([{path:'/projects/alpha-app/releases/stage',payload:{runId:414}}]);
  await expect(panel.getByText('starting · running')).toBeVisible();
});

test('preparação é cancelada se imagem importada mudou antes de confirmar',async ({page})=>{
  const state=await mockReleaseApi(page,{rollbackBackup:false});
  const panel=await openReleasePanel(page);
  await panel.getByRole('button',{name:'Preparar candidata · #414'}).click();
  state.importedRevision=OTHER;
  await panel.getByRole('textbox',{name:/Digite exatamente/}).fill('PREPARAR alpha-app');
  await panel.getByRole('button',{name:'Confirmar preparação'}).click();
  await expect(panel.getByRole('alert')).toContainText('imagem desta revisão não está importada');
  expect(state.requests.some(r=>r==='POST /projects/alpha-app/releases/stage')).toBe(false);
});

test('importação é cancelada se status do build mudar antes da confirmação',async ({page})=>{
  const state=await mockReleaseApi(page,{rollbackBackup:false,importedRevision:null});
  const panel=await openReleasePanel(page);
  await panel.getByRole('button',{name:'Importar GHCR · #414'}).click();
  state.runStatus='completed';state.runConclusion='failure';
  await panel.getByRole('textbox',{name:/Digite exatamente/}).fill('IMPORTAR alpha-app');
  await panel.getByRole('button',{name:'Confirmar importação'}).click();
  await expect(panel.getByRole('alert')).toContainText('build selecionado mudou');
  expect(state.requests.some(r=>r==='POST /projects/alpha-app/images/import')).toBe(false);
});

test('importação e preparação bloqueadas quando publicação persistente está ativa',async ({page})=>{
  const state=await mockReleaseApi(page,{rollbackBackup:false,publicationPhase:'health'});
  const panel=await openReleasePanel(page);
  await expect(panel.getByRole('button',{name:'Importar GHCR · #414'})).toBeDisabled();
  await expect(panel.getByRole('button',{name:'Preparar candidata · #414'})).toBeDisabled();
  expect(state.requests.some(r=>r.startsWith('POST '))).toBe(false);
});
