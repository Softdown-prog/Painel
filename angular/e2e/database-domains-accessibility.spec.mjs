import {test,expect} from '@playwright/test';

const at='2026-11-01T12:00:00Z';
async function mockAdministrativeApi(page){
  const state={
    requests:[],
    databases:[{name:'postgres',owner:'postgres',sizeBytes:524288}],
    routes:[{slug:'alpha',host:'alpha.apps.example.com',port:3000,createdAt:at}],
    publications:{alpha:{state:'reserved',updatedAt:at,message:'Aguardando publicação'}}
  };
  await page.route('**/api/**',async route=>{
    const request=route.request();
    const path=new URL(request.url()).pathname.slice('/api'.length);
    const method=request.method();
    const payload=request.postDataJSON?.()??null;
    state.requests.push({method,path,payload});
    let body,status=200;
    if(method==='GET'&&path==='/session'){
      body={authenticated:true,setupRequired:false};
    }else if(method==='GET'&&path==='/database/status'){
      body={engine:'postgresql',integration:'connected',enabled:true,
        instance:{version:'18.6'},databases:state.databases,
        roles:[{name:'postgres',canLogin:true,superuser:true}],
        security:{hostAuthentication:'cert',provisioningEnabled:true,
          message:'Certificados de teste ativos, sem senha em navegador'},
        metrics:{databaseCount:state.databases.length,connections:2,totalBytes:524288},
        checkedAt:at,message:'PostgreSQL conectado no mock'};
    }else if(method==='POST'&&path==='/database/projects'){
      if(payload?.project!=='beta'){status=400;body={error:'Projeto inesperado'};}
      else{
        state.databases=[...state.databases,{name:'db_beta',owner:'role_beta',sizeBytes:0}];
        body={ok:true,project:'beta',database:'db_beta',username:'role_beta',
          credentialsStored:true,message:'Provisionamento simulado'};
      }
    }else if(method==='GET'&&path==='/domains'){
      body={enabled:true,publicationEnabled:true,zone:'apps.example.com',
        network:'softload_panel_apps',routes:state.routes,publications:state.publications};
    }else if(method==='GET'&&path==='/apps'){
      body={applications:[
        {slug:'alpha',image:'alpha:test',network:'softload_panel_apps'},
        {slug:'beta',image:'beta:test',network:'softload_panel_apps'}]};
    }else if(method==='GET'&&path==='/domains/caddy'){
      body={content:'# Test gateway preview only'};
    }else if(method==='POST'&&path==='/domains/alpha/publish'){
      state.publications.alpha={state:'certificate_pending',updatedAt:at,
        message:'HTTPS ainda não confirmado'};
      body={live:false,publication:state.publications.alpha};
    }else{
      status=503;body={error:'Endpoint não simulado: '+method+' '+path};
    }
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  return state;
}
const writes=state=>state.requests.filter(x=>x.method!=='GET');

test('PostgreSQL foca confirmação de risco e devolve foco ao projeto ao cancelar',async ({page})=>{
  const state=await mockAdministrativeApi(page);
  await page.setViewportSize({width:320,height:720});
  await page.goto('/angular/#database');
  const project=page.getByLabel('Identificador do projeto');
  await project.fill('beta');
  await page.getByRole('button',{name:'Preparar criação'}).click();
  const group=page.getByRole('group',{name:'Confirmação de novo banco'});
  await expect(group).toBeVisible();
  await expect(group.getByLabel('Digite o identificador do projeto')).toBeFocused();
  await expect(group).toHaveAttribute('aria-describedby','db-confirm-warning');
  await expect(group.getByRole('button',{name:'Confirmar criação'})).toBeDisabled();
  await group.getByRole('button',{name:'Cancelar'}).click();
  await expect(group).toHaveCount(0);
  await expect(project).toBeFocused();
  expect(writes(state)).toEqual([]);
  const size=await page.evaluate(()=>({vw:document.documentElement.clientWidth,
    total:document.documentElement.scrollWidth}));
  expect(size.total).toBeLessThanOrEqual(size.vw+1);
});

test('PostgreSQL só envia a criação ao confirmar o slug exato',async ({page})=>{
  const state=await mockAdministrativeApi(page);
  await page.goto('/angular/#database');
  await page.getByLabel('Identificador do projeto').fill('beta');
  await page.getByRole('button',{name:'Preparar criação'}).click();
  const group=page.getByRole('group',{name:'Confirmação de novo banco'});
  const confirmation=group.getByLabel('Digite o identificador do projeto');
  const submit=group.getByRole('button',{name:'Confirmar criação'});
  await confirmation.fill('Beta');
  await expect(submit).toBeDisabled();
  expect(writes(state)).toEqual([]);
  await confirmation.fill('beta');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByText(/Criado: db_beta/)).toBeVisible();
  await expect(page.getByText('db_beta',{exact:true})).toBeVisible();
  expect(writes(state)).toEqual([{method:'POST',path:'/database/projects',payload:{project:'beta'}}]);
});

test('domínio: reservar mostra confirmação acessível e cancelar não envia requisição',async ({page})=>{
  const state=await mockAdministrativeApi(page);
  await page.goto('/angular/#domains');
  const reserve=page.getByRole('button',{name:'Preparar reserva'});
  await expect(reserve).toBeEnabled();
  await reserve.click();
  const group=page.getByRole('group',{name:'Confirmar operação de domínio'});
  await expect(group).toContainText('Reservar beta.apps.example.com');
  await expect(group.getByRole('textbox',{name:/Digite o nome da aplicação/})).toBeFocused();
  await expect(group).toHaveAttribute('aria-describedby','domain-operation-warning');
  await expect(group.getByRole('button',{name:'Confirmar operação'})).toBeDisabled();
  await group.getByRole('button',{name:'Cancelar'}).click();
  await expect(group).toHaveCount(0);
  await expect(reserve).toBeFocused();
  expect(writes(state)).toEqual([]);
});

test('domínio: remoção identifica alvo e restaura foco ao botão de origem',async ({page})=>{
  const state=await mockAdministrativeApi(page);
  await page.goto('/angular/#domains');
  const remove=page.getByRole('button',{name:'Despublicar e remover'});
  await remove.click();
  const group=page.getByRole('group',{name:'Confirmar operação de domínio'});
  await expect(group).toContainText('Despublicar e remover alpha.apps.example.com');
  const confirmation=group.getByRole('textbox',{name:/Digite o nome da aplicação/});
  await expect(confirmation).toBeFocused();
  await confirmation.fill('alph');
  await expect(group.getByRole('button',{name:'Confirmar operação'})).toBeDisabled();
  await group.getByRole('button',{name:'Cancelar'}).click();
  await expect(remove).toBeFocused();
  expect(writes(state)).toEqual([]);
});

test('publicação exige confirmação exata e não declara HTTPS sem evidência',async ({page})=>{
  const state=await mockAdministrativeApi(page);
  await page.goto('/angular/#domains');
  await page.getByRole('button',{name:'Publicar DNS e HTTPS'}).click();
  const group=page.getByRole('group',{name:'Confirmar operação de domínio'});
  const submit=group.getByRole('button',{name:'Confirmar operação'});
  await expect(submit).toBeDisabled();
  expect(writes(state)).toEqual([]);
  await group.getByRole('textbox',{name:/Digite o nome da aplicação/}).fill('alpha');
  await submit.click();
  await expect(page.getByText(/HTTPS ainda não confirmado/).first()).toBeVisible();
  await expect(page.getByText('Certificado HTTPS pendente')).toBeVisible();
  expect(writes(state)).toEqual([{method:'POST',path:'/domains/alpha/publish',payload:null}]);
});
