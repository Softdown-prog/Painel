import { test, expect } from '@playwright/test';

const SHA='a'.repeat(40), OTHER='b'.repeat(40);
const project={
  slug:'alpha-app',repository:'Softdown-prog/alpha',branch:'main',
  workflow:'panel-app-build.yml',services:['alpha-app']
};
function mockReleaseApi(page,{buildsEnabled=true,rollbackBackup=true,publicationPhase=null,importedRevision=SHA}={}){
  const state={requests:[],payloads:[],project:{...project},buildsEnabled,rollbackBackup,
    currentSha:SHA,publicationPhase,importedRevision,importJob:null,candidate:null,
    runStatus:'completed',runConclusion:'success',failProjectValidation:false,
    publicationEnabled:true,publicationJob:null,alreadyPublished:false,wrongPublishedJob:false};
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
      const previous=state.publicationJob??(state.publicationPhase?{
        phase:state.publicationPhase,detail:'Executando',runId:414}:null);
      body={enabled:state.publicationEnabled,current:previous,
        history:state.publicationJob?[state.publicationJob]:[]};
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
    }else if(method==='POST'&&path==='/projects/alpha-app/publication'){
      const job={id:'00000000-0000-4000-8000-000000000414',
        slug:project.slug,repository:project.repository,
        runId:state.wrongPublishedJob?999:414,phase:'queued',detail:'Na fila para validar o build.'};
      state.publicationJob=job;
      body={ok:true,alreadyExists:state.alreadyPublished,job};
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
async function openReleasePanel(page,revision=SHA){
  await page.goto('/angular/#projects');
  await expect(page.locator('.managed-link')).toHaveCount(1);
  await page.getByRole('button',{name:'Consultar builds e versões'}).click();
  const panel=page.getByRole('region',{name:'Builds e versões de alpha-app'});
  await expect(panel.getByText('Em execução · '+revision.slice(0,12))).toBeVisible();
  return panel;
}

test('inspeção de versões e build aprovado é estritamente somente leitura',async ({page})=>{
  const state=await mockReleaseApi(page);
  const panel=await openReleasePanel(page);
  await expect(panel.getByText('ghcr.io/softdown-prog/alpha:backup')).toBeVisible();
  await expect(panel.getByText('Imagem '+SHA.slice(0,12),{exact:false})).toBeVisible();
  await expect(panel.locator('.release-run a').filter({hasText:'#414'})).toBeVisible();
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

test('publicação persistente é somente leitura até confirmar um build aprovado diferente da revisão atual',async ({page})=>{
  const state=await mockReleaseApi(page,{rollbackBackup:false,importedRevision:null});
  state.currentSha=OTHER;
  const panel=await openReleasePanel(page,OTHER);
  await expect(panel.getByRole('button',{name:'Publicar revisão · #414'})).toBeEnabled();
  await expect(panel.getByText('Nenhum trabalho de publicação registrado.')).toBeVisible();
  expect(state.requests.filter(r=>r.startsWith('POST '))).toEqual([]);
});

test('publicar revisão exige texto exato e registra apenas um trabalho persistente',async ({page})=>{
  const state=await mockReleaseApi(page,{rollbackBackup:false,importedRevision:null});
  state.currentSha=OTHER;
  const panel=await openReleasePanel(page,OTHER);
  await panel.getByRole('button',{name:'Publicar revisão · #414'}).click();
  const confirmation=panel.getByRole('group',{name:'Confirmação de build ou rollback'});
  await expect(confirmation.getByRole('button',{name:'Confirmar publicação'})).toBeDisabled();
  expect(state.requests.filter(r=>r.startsWith('POST '))).toEqual([]);
  await confirmation.getByRole('textbox',{name:/Digite exatamente/}).fill('PUBLICAR alpha-app');
  await confirmation.getByRole('button',{name:'Confirmar publicação'}).click();
  await expect(panel.getByText(/Publicação persistente registrada/)).toBeVisible();
  await expect(panel.getByText(/Na fila.*build #414/)).toBeVisible();
  await expect(panel.getByRole('button',{name:'Publicar revisão · #414'})).toBeDisabled();
  expect(state.payloads.filter(v=>v.path==='/projects/alpha-app/publication'))
    .toEqual([{path:'/projects/alpha-app/publication',payload:{runId:414}}]);
  expect(state.requests.some(r=>r==='POST /projects/alpha-app/releases/promote')).toBe(false);
});

test('não aceita publicação automática quando recurso está desabilitado na API',async ({page})=>{
  const state=await mockReleaseApi(page,{rollbackBackup:false,importedRevision:null});
  state.currentSha=OTHER;state.publicationEnabled=false;
  const panel=await openReleasePanel(page,OTHER);
  await expect(panel.getByRole('button',{name:'Publicar revisão · #414'})).toBeDisabled();
  await expect(panel.getByText('Publicação persistente desabilitada pela API.')).toBeVisible();
  expect(state.requests.filter(r=>r.startsWith('POST '))).toEqual([]);
});

test('não publica quando existe trabalho persistente ativo, backup ou revisão já instalada',async ({page})=>{
  const state=await mockReleaseApi(page,{rollbackBackup:false,importedRevision:null});
  state.currentSha=OTHER;
  const panel=await openReleasePanel(page,OTHER);
  state.publicationPhase='health';
  await panel.getByRole('button',{name:'↻ Conferir versões'}).click();
  await expect(panel.getByRole('button',{name:'Publicar revisão · #414'})).toBeDisabled();
  state.publicationPhase=null;state.rollbackBackup=true;
  await panel.getByRole('button',{name:'↻ Conferir versões'}).click();
  await expect(panel.getByRole('button',{name:'Publicar revisão · #414'})).toBeDisabled();
  state.rollbackBackup=false;state.currentSha=SHA;
  await panel.getByRole('button',{name:'↻ Conferir versões'}).click();
  await expect(panel.getByRole('button',{name:'Publicar revisão · #414'})).toBeDisabled();
  expect(state.requests.filter(r=>r.startsWith('POST '))).toEqual([]);
});

test('build reprovado durante confirmação cancela publicação automática',async ({page})=>{
  const state=await mockReleaseApi(page,{rollbackBackup:false,importedRevision:null});
  state.currentSha=OTHER;
  const panel=await openReleasePanel(page,OTHER);
  await panel.getByRole('button',{name:'Publicar revisão · #414'}).click();
  state.runConclusion='failure';
  await panel.getByRole('textbox',{name:/Digite exatamente/}).fill('PUBLICAR alpha-app');
  await panel.getByRole('button',{name:'Confirmar publicação'}).click();
  await expect(panel.getByRole('alert')).toContainText('build selecionado mudou');
  expect(state.requests.filter(r=>r.startsWith('POST '))).toEqual([]);
});

test('desconexão de projeto durante confirmação cancela publicação automática',async ({page})=>{
  const state=await mockReleaseApi(page,{rollbackBackup:false,importedRevision:null});
  state.currentSha=OTHER;
  const panel=await openReleasePanel(page,OTHER);
  await panel.getByRole('button',{name:'Publicar revisão · #414'}).click();
  state.failProjectValidation=true;
  await panel.getByRole('textbox',{name:/Digite exatamente/}).fill('PUBLICAR alpha-app');
  await panel.getByRole('button',{name:'Confirmar publicação'}).click();
  await expect(panel.getByRole('alert')).toContainText('vínculo, os serviços ou o workflow mudaram');
  expect(state.requests.filter(r=>r.startsWith('POST '))).toEqual([]);
});

test('revisão do container alterada durante confirmação cancela publicação',async ({page})=>{
  const state=await mockReleaseApi(page,{rollbackBackup:false,importedRevision:null});
  state.currentSha=OTHER;
  const panel=await openReleasePanel(page,OTHER);
  await panel.getByRole('button',{name:'Publicar revisão · #414'}).click();
  state.currentSha=SHA;
  await panel.getByRole('textbox',{name:/Digite exatamente/}).fill('PUBLICAR alpha-app');
  await panel.getByRole('button',{name:'Confirmar publicação'}).click();
  await expect(panel.getByRole('alert')).toContainText('Estado GHCR, publicação ou containers mudou');
  expect(state.requests.filter(r=>r.startsWith('POST '))).toEqual([]);
});

test('API que retorna runId inesperado não confirma publicação',async ({page})=>{
  const state=await mockReleaseApi(page,{rollbackBackup:false,importedRevision:null});
  state.currentSha=OTHER;state.wrongPublishedJob=true;
  const panel=await openReleasePanel(page,OTHER);
  await panel.getByRole('button',{name:'Publicar revisão · #414'}).click();
  await panel.getByRole('textbox',{name:/Digite exatamente/}).fill('PUBLICAR alpha-app');
  await panel.getByRole('button',{name:'Confirmar publicação'}).click();
  await expect(panel.getByRole('alert')).toContainText('outro projeto ou build');
  expect(state.requests.filter(r=>r==='POST /projects/alpha-app/publication')).toHaveLength(1);
  await expect(panel.getByText(/Publicação persistente registrada/)).toHaveCount(0);
});

test('publicação já cadastrada é identificada sem prometer nova execução',async ({page})=>{
  const state=await mockReleaseApi(page,{rollbackBackup:false,importedRevision:null});
  state.currentSha=OTHER;state.alreadyPublished=true;
  const panel=await openReleasePanel(page,OTHER);
  await panel.getByRole('button',{name:'Publicar revisão · #414'}).click();
  await panel.getByRole('textbox',{name:/Digite exatamente/}).fill('PUBLICAR alpha-app');
  await panel.getByRole('button',{name:'Confirmar publicação'}).click();
  await expect(panel.getByText(/já possui uma publicação registrada/)).toBeVisible();
  expect(state.requests.filter(r=>r==='POST /projects/alpha-app/publication')).toHaveLength(1);
});

test('atualização de status consulta o job sem enviar outra mutação',async ({page})=>{
  const state=await mockReleaseApi(page,{rollbackBackup:false,importedRevision:null});
  state.currentSha=OTHER;
  const panel=await openReleasePanel(page,OTHER);
  state.publicationJob={id:'job-01',slug:project.slug,repository:project.repository,
    runId:414,phase:'health',detail:'Testando versão saudável'};
  await panel.getByRole('button',{name:'↻ Atualizar andamento'}).click();
  await expect(panel.getByText(/Verificando saúde.*build #414/)).toBeVisible();
  state.publicationJob={...state.publicationJob,phase:'completed',detail:'Publicado e verificado'};
  await panel.getByRole('button',{name:'↻ Atualizar andamento'}).click();
  await expect(panel.getByText(/Publicado na VPS.*build #414/)).toBeVisible();
  expect(state.requests.filter(r=>r.startsWith('POST '))).toEqual([]);
});
