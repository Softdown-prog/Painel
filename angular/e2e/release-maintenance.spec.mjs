import { test, expect } from '@playwright/test';

const SHA='a'.repeat(40), NEXT='b'.repeat(40);
const project={
  slug:'alpha-app',repository:'Softdown-prog/alpha',branch:'main',
  workflow:'panel-app-build.yml',services:['alpha-app']
};
async function fixture(page,{mode='candidate-healthy',phase=null}={}){
  const state={mode,phase,requests:[],payloads:[],currentSha:SHA,
    candidateSha:NEXT,candidateHealth:'healthy',candidateState:'running',
    backupState:'exited',recoveryEnabled:true,releaseEnabled:true,failBinding:false};
  await page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.slice('/api'.length),
      method=request.method();
    state.requests.push(method+' '+path);
    if(method==='POST')state.payloads.push({path,payload:request.postDataJSON()});
    const modeNow=state.mode;
    const candidate=['candidate-healthy','candidate-stopped'].includes(modeNow);
    const backup=modeNow==='backup';
    const recoverBackup=modeNow==='recover-backup';
    const recoverCurrent=modeNow==='recover-current';
    const ready=['candidate-healthy','candidate-stopped','backup','ready'].includes(modeNow);
    const slots={
      current:recoverBackup?null:recoverCurrent?'exited':'running',
      candidate:candidate?state.candidateState:null,
      backup:backup||recoverBackup?state.backupState:null
    };
    let status=200,body;
    if(method==='GET'&&path==='/session'){
      body={authenticated:true,setupRequired:false};
    }else if(method==='GET'&&path==='/repositories'){
      body={repositories:[{fullName:project.repository,branch:'main',workflow:project.workflow}],
        allowedOwner:'Softdown-prog',tokenConfigured:false};
    }else if(method==='GET'&&path==='/repositories/Softdown-prog/alpha/runs'){
      body={runs:[]};
    }else if(method==='GET'&&path==='/projects'){
      body={projects:state.failBinding?[]:[project],
        buildsEnabled:false,requiredWorkflow:'panel-app-build.yml'};
    }else if(method==='GET'&&path==='/projects/alpha-app/runs'){
      body={slug:project.slug,runs:[]};
    }else if(method==='GET'&&path==='/projects/alpha-app/images/import'){
      body={enabled:true,job:null,imported:null};
    }else if(method==='GET'&&path==='/projects/alpha-app/publication'){
      body={enabled:true,current:state.phase?{phase:state.phase,runId:1,detail:'Em andamento'}:null};
    }else if(method==='GET'&&path==='/projects/alpha-app/releases/recovery'){
      body={enabled:state.recoveryEnabled,slug:project.slug,
        state:ready?'ready':recoverBackup||recoverCurrent?'recoverable':'manual_review',
        repair:recoverBackup?'restore_backup':recoverCurrent?'restart_current':null,
        detail:ready?'Estado em execução':recoverBackup?'Restaurar backup':'Inspecionar containers',
        slots};
    }else if(method==='GET'&&path==='/projects/alpha-app/releases'){
      if(recoverBackup){status=404;body={error:'Container principal ausente'};}
      else body={enabled:state.releaseEnabled,slug:project.slug,
        current:{state:slots.current,revision:state.currentSha},
        candidate:candidate?{revision:state.candidateSha,state:state.candidateState,
          health:state.candidateHealth}:null,
        backup:backup?{image:'ghcr.io/softdown-prog/alpha:previous',state:state.backupState}:null};
    }else if(method==='POST'&&path==='/projects/alpha-app/releases/promote'){
      state.currentSha=state.candidateSha;
      state.mode='backup';
      body={promoted:true,revision:state.currentSha};
    }else if(method==='POST'&&path==='/projects/alpha-app/releases/finalize'){
      state.mode='ready';
      body={finalized:true,removed:'/slot-previous'};
    }else if(method==='POST'&&path==='/projects/alpha-app/releases/recovery'){
      state.mode='ready';
      body={repaired:true,action:recoverBackup?'restore_backup':'restart_current'};
    }else{
      status=503;body={error:'Endpoint fora da simulação: '+method+' '+path};
    }
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  return state;
}
async function open(page,label='Pronto'){
  await page.goto('/angular/#projects');
  await expect(page.locator('.managed-link')).toHaveCount(1);
  await page.getByRole('button',{name:'Consultar builds e versões'}).click();
  const panel=page.getByRole('region',{name:'Manutenção de releases de alpha-app'});
  await expect(panel.getByText('Diagnóstico: '+label)).toBeVisible();
  return panel;
}
async function confirm(page,panel,action,typed){
  await panel.getByRole('button',{name:action}).click();
  const group=panel.getByRole('group',{name:'Confirmação de manutenção de release'});
  const button=group.getByRole('button',{name:typed.startsWith('PUBLICAR')?'Confirmar promoção':
    typed.startsWith('DESCARTAR')?'Confirmar descarte':'Confirmar recuperação'});
  await expect(button).toBeDisabled();
  await group.getByRole('textbox',{name:/Digite exatamente/}).fill(typed);
  await expect(button).toBeEnabled();
  await button.click();
}
test('consulta inicial de manutenção é estritamente read-only',async ({page})=>{
  const state=await fixture(page);
  const panel=await open(page);
  await expect(panel.getByRole('button',{name:'Preparar promoção'})).toBeEnabled();
  await expect(panel.getByRole('button',{name:'Preparar descarte'})).toBeDisabled();
  await expect(panel.getByRole('button',{name:'Preparar recuperação'})).toBeDisabled();
  expect(state.requests.filter(x=>!x.startsWith('GET '))).toEqual([]);
});
test('promove somente candidata saudável com SHA travado e confirmação digitada',async ({page})=>{
  const state=await fixture(page);
  const panel=await open(page);
  await confirm(page,panel,'Preparar promoção','PUBLICAR alpha-app');
  await expect(panel.getByText(/A API confirmou a promoção/)).toBeVisible();
  expect(state.payloads.filter(x=>x.path==='/projects/alpha-app/releases/promote'))
    .toEqual([{path:'/projects/alpha-app/releases/promote',payload:{expectedRevision:NEXT}}]);
  await expect(panel.getByText('Backup: exited')).toBeVisible();
});
test('não promove candidata sem HEALTHCHECK healthy',async ({page})=>{
  const state=await fixture(page);
  state.candidateHealth='starting';
  const panel=await open(page);
  await expect(panel.getByRole('button',{name:'Preparar promoção'})).toBeDisabled();
  expect(state.payloads).toEqual([]);
});
test('candidata alterada durante confirmação cancela promoção',async ({page})=>{
  const state=await fixture(page);
  const panel=await open(page);
  await panel.getByRole('button',{name:'Preparar promoção'}).click();
  state.candidateSha='c'.repeat(40);
  await panel.getByRole('group',{name:'Confirmação de manutenção de release'})
    .getByRole('textbox',{name:/Digite exatamente/}).fill('PUBLICAR alpha-app');
  await panel.getByRole('button',{name:'Confirmar promoção'}).click();
  await expect(panel.getByRole('alert')).toContainText('Estado da VPS mudou');
  expect(state.payloads).toEqual([]);
});
test('bloqueia promoção com publicação persistente ativa',async ({page})=>{
  const state=await fixture(page,{phase:'health'});
  const panel=await open(page);
  await expect(panel.getByRole('button',{name:'Preparar promoção'})).toBeDisabled();
  expect(state.payloads).toEqual([]);
});
test('libera backup parado somente com confirmação e DELETE_BACKUP',async ({page})=>{
  const state=await fixture(page,{mode:'backup'});
  const panel=await open(page);
  await confirm(page,panel,'Preparar descarte','DESCARTAR alpha-app');
  await expect(panel.getByText(/A API confirmou a liberação do slot parado/)).toBeVisible();
  expect(state.payloads.filter(x=>x.path==='/projects/alpha-app/releases/finalize'))
    .toEqual([{path:'/projects/alpha-app/releases/finalize',payload:{confirm:'DELETE_BACKUP'}}]);
});
test('pode descartar candidata parada sem backup e nunca candidata em execução',async ({page})=>{
  const state=await fixture(page,{mode:'candidate-stopped'});
  state.candidateState='exited';
  const panel=await open(page);
  await expect(panel.getByRole('button',{name:'Preparar descarte'})).toBeEnabled();
  await expect(panel.getByRole('button',{name:'Preparar promoção'})).toBeDisabled();
  expect(state.payloads).toEqual([]);
});
test('bloqueia descarte quando backup continua running',async ({page})=>{
  const state=await fixture(page,{mode:'backup'});
  state.backupState='running';
  const panel=await open(page);
  await expect(panel.getByRole('button',{name:'Preparar descarte'})).toBeDisabled();
  expect(state.payloads).toEqual([]);
});
test('recupera backup sem container principal após diagnóstico e confirmação',async ({page})=>{
  const state=await fixture(page,{mode:'recover-backup'});
  const panel=await open(page,'Recuperação disponível');
  await expect(panel.getByRole('button',{name:'Preparar recuperação'})).toBeEnabled();
  await expect(panel.getByRole('button',{name:'Preparar promoção'})).toBeDisabled();
  await confirm(page,panel,'Preparar recuperação','RECUPERAR alpha-app');
  await expect(panel.getByText(/Recuperação aceita pela API: restore_backup/)).toBeVisible();
  expect(state.payloads.filter(x=>x.path==='/projects/alpha-app/releases/recovery'))
    .toEqual([{path:'/projects/alpha-app/releases/recovery',payload:{confirm:'RESTORE_SAFE_STATE'}}]);
});
test('recuperação de principal parado respeita o diagnóstico',async ({page})=>{
  const state=await fixture(page,{mode:'recover-current'});
  const panel=await open(page,'Recuperação disponível');
  await confirm(page,panel,'Preparar recuperação','RECUPERAR alpha-app');
  await expect(panel.getByText(/Recuperação aceita pela API: restart_current/)).toBeVisible();
  expect(state.payloads.filter(x=>x.path==='/projects/alpha-app/releases/recovery'))
    .toEqual([{path:'/projects/alpha-app/releases/recovery',payload:{confirm:'RESTORE_SAFE_STATE'}}]);
});
test('diagnóstico manual não autoriza recuperação',async ({page})=>{
  const state=await fixture(page,{mode:'manual'});
  const panel=await open(page,'Revisão manual necessária');
  await expect(panel.getByRole('button',{name:'Preparar recuperação'})).toBeDisabled();
  expect(state.payloads).toEqual([]);
});
test('alteração de vínculo antes de promover bloqueia qualquer POST',async ({page})=>{
  const state=await fixture(page);
  const panel=await open(page);
  await panel.getByRole('button',{name:'Preparar promoção'}).click();
  state.failBinding=true;
  await panel.getByRole('group',{name:'Confirmação de manutenção de release'})
    .getByRole('textbox',{name:/Digite exatamente/}).fill('PUBLICAR alpha-app');
  await panel.getByRole('button',{name:'Confirmar promoção'}).click();
  await expect(panel.getByRole('alert')).toContainText('Vínculo, branch ou serviços mudaram');
  expect(state.payloads).toEqual([]);
});
test('manutenção continua responsiva a 320 pixels sem rolagem horizontal',async ({page})=>{
  await fixture(page);
  await page.setViewportSize({width:320,height:700});
  const panel=await open(page);
  await expect(panel.getByRole('button',{name:'Preparar promoção'})).toBeVisible();
  const width=await page.evaluate(()=>({
    viewport:document.documentElement.clientWidth,content:document.documentElement.scrollWidth
  }));
  expect(width.content).toBeLessThanOrEqual(width.viewport+1);
});
