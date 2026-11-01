import {test,expect} from '@playwright/test';

const now='2026-10-31T12:00:00Z';
const entries=[
  {name:'cloudflare-dns',label:'DNS projeto alfa',category:'sistema',installed:true,
    sizeBytes:30,createdAt:now,updatedAt:now},
  {name:'github-token',label:'GitHub beta',category:'aplicacao',installed:true,
    sizeBytes:40,createdAt:now,updatedAt:now}
];

async function mockSecrets(page){
  const state={requests:[],entries:[...entries]};
  await page.route('**/api/**',async route=>{
    const request=route.request();
    const path=new URL(request.url()).pathname.slice('/api'.length);
    const method=request.method();
    const payload=request.postDataJSON?.()??null;
    state.requests.push({method,path,payload});
    let status=200,body;
    if(method==='GET'&&path==='/session')
      body={authenticated:true,setupRequired:false};
    else if(method==='GET'&&path==='/secrets')
      body={enabled:true,entries:state.entries,
        connections:[{id:'dns',label:'Cloudflare',configured:true,managed:true}]};
    else if(method==='DELETE'&&path==='/secrets/cloudflare-dns'&&
      payload?.password==='demo-pass-no-real'&&payload.confirm==='cloudflare-dns'){
      state.entries=state.entries.filter(x=>x.name!=='cloudflare-dns');
      body={ok:true,message:'Remoção confirmada pelo mock'};
    }else{
      status=503;body={error:'Endpoint não simulado: '+method+' '+path};
    }
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  return state;
}

test('cada exclusão identifica a chave de destino para leitores de tela',async ({page})=>{
  const state=await mockSecrets(page);
  await page.goto('/angular/#secrets');
  await expect(page.getByRole('button',{name:'Excluir chave cloudflare-dns'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Excluir chave github-token'})).toBeVisible();
  expect(state.requests.every(req=>req.method==='GET')).toBe(true);
});

test('exclusão pede senha e foca o primeiro controle da confirmação; cancelar retorna ao botão original',async ({page})=>{
  const state=await mockSecrets(page);
  await page.goto('/angular/#secrets');
  const source=page.getByRole('button',{name:'Excluir chave cloudflare-dns'});
  await source.click();
  const confirmation=page.getByRole('group',{name:'Confirmar alteração de chave'});
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByLabel('Senha administrativa')).toBeFocused();
  await expect(confirmation.getByRole('button',{name:'Confirmar exclusão'})).toBeDisabled();
  await confirmation.getByRole('button',{name:'Cancelar'}).click();
  await expect(confirmation).toHaveCount(0);
  await expect(source).toBeFocused();
  expect(state.requests.every(req=>req.method==='GET')).toBe(true);
});

test('gravação foca texto de confirmação; cancelar apaga segredo e retorna ao nome',async ({page})=>{
  const state=await mockSecrets(page);
  await page.goto('/angular/#secrets');
  const name=page.getByLabel('Nome da chave');
  await name.fill('chave-teste');
  await page.getByLabel('Descrição').fill('Chave fictícia');
  await page.getByLabel('Valor secreto').fill('apenas-teste');
  await page.getByLabel('Senha administrativa').fill('demo-pass-no-real');
  await page.getByRole('button',{name:'Preparar gravação'}).click();
  const confirmation=page.getByRole('group',{name:'Confirmar alteração de chave'});
  await expect(confirmation.getByLabel(/Digite.*chave-teste.*para confirmar/)).toBeFocused();
  await expect(confirmation.getByRole('button',{name:'Confirmar gravação'})).toBeDisabled();
  await confirmation.getByRole('button',{name:'Cancelar'}).click();
  await expect(confirmation).toHaveCount(0);
  await expect(name).toBeFocused();
  await expect(page.getByLabel('Valor secreto')).toHaveValue('');
  await expect(page.getByLabel('Senha administrativa')).toHaveValue('');
  expect(state.requests.every(req=>req.method==='GET')).toBe(true);
});

test('exclusão só envia DELETE após senha e nome confirmados exatamente',async ({page})=>{
  const state=await mockSecrets(page);
  await page.goto('/angular/#secrets');
  await page.getByRole('button',{name:'Excluir chave cloudflare-dns'}).click();
  const confirmation=page.getByRole('group',{name:'Confirmar alteração de chave'});
  const submit=confirmation.getByRole('button',{name:'Confirmar exclusão'});
  await confirmation.getByLabel('Senha administrativa').fill('demo-pass-no-real');
  await confirmation.getByLabel(/Digite.*cloudflare-dns.*para confirmar/).fill('cloudflare');
  await expect(submit).toBeDisabled();
  expect(state.requests.every(req=>req.method==='GET')).toBe(true);
  await confirmation.getByLabel(/Digite.*cloudflare-dns.*para confirmar/).fill('cloudflare-dns');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole('button',{name:'Excluir chave cloudflare-dns'})).toHaveCount(0);
  const deletes=state.requests.filter(req=>req.method==='DELETE');
  expect(deletes).toHaveLength(1);
  expect(deletes[0]).toEqual({method:'DELETE',path:'/secrets/cloudflare-dns',
    payload:{password:'demo-pass-no-real',confirm:'cloudflare-dns'}});
  await expect(page.getByLabel('Senha administrativa').first()).toHaveValue('');
});

test('confirmação de exclusão permanece acessível e sem rolagem horizontal em 320px',async ({page})=>{
  await mockSecrets(page);
  await page.setViewportSize({width:320,height:720});
  await page.goto('/angular/#secrets');
  await page.getByRole('button',{name:'Excluir chave github-token'}).click();
  const confirmation=page.getByRole('group',{name:'Confirmar alteração de chave'});
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByLabel('Senha administrativa')).toBeFocused();
  const size=await page.evaluate(()=>({
    viewport:document.documentElement.clientWidth,
    content:document.documentElement.scrollWidth
  }));
  expect(size.content).toBeLessThanOrEqual(size.viewport+1);
});
