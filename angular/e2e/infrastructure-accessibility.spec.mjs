import {test,expect} from '@playwright/test';

// All API calls are intercepted: no real VPS, containers or MCP services are touched.
const at='2026-11-01T12:00:00Z';
const plan=(projectSlug,kind,name,extra={})=>({
  id:projectSlug+'.'+kind+'.'+name,projectSlug,kind,name,replicas:kind==='mcp'?1:2,
  topology:'single-node',transport:kind==='mcp'?'streamable-http':null,
  exposure:'private',runtime:'not-provisioned',projectLinked:true,
  createdAt:at,updatedAt:at,...extra
});
async function fixture(page){
  const state={requests:[],plans:[
    plan('terrania','mcp','navigator'),
    plan('painel','cluster','workers')
  ]};
  await page.route('**/api/**',async route=>{
    const request=route.request();
    const path=new URL(request.url()).pathname.slice(4);
    const method=request.method();
    const payload=method==='GET'?null:request.postDataJSON();
    state.requests.push({method,path,payload});
    let status=200,body;
    if(method==='GET'&&path==='/session'){
      body={authenticated:true,setupRequired:false};
    }else if(method==='GET'&&path==='/infrastructure'){
      body={projects:['terrania','painel'],plans:state.plans,
        capabilities:{configuration:true,provisioning:false,healthMonitoring:false,lifecycle:false},
        limits:{total:32,perProject:8,maxClusterReplicas:8}};
    }else if(method==='POST'&&path==='/infrastructure'){
      if(!['terrania','painel'].includes(payload?.projectSlug)){
        status=403;body={error:'Projeto não autorizado'};
      }else{
        const newPlan=plan(payload.projectSlug,payload.kind,payload.name,{
          replicas:payload.replicas,topology:payload.topology,transport:payload.transport});
        state.plans=[...state.plans,newPlan];
        body={plan:newPlan};
      }
    }else if(method==='DELETE'&&path==='/infrastructure/terrania.mcp.navigator'){
      if(payload?.confirmId!=='terrania.mcp.navigator'||payload?.projectSlug!=='terrania'){
        status=403;body={error:'Confirmação de identidade divergente'};
      }else{
        state.plans=state.plans.filter(p=>p.id!==payload.confirmId);
        body={ok:true};
      }
    }else{
      status=503;body={error:'Endpoint não simulado '+method+' '+path};
    }
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  return state;
}
const writes=state=>state.requests.filter(r=>r.method!=='GET');

test('MCP: confirmação recebe foco, anuncia risco e cancelar devolve foco ao nome',async ({page})=>{
  const state=await fixture(page);
  await page.setViewportSize({width:320,height:740});
  await page.goto('/angular/#infrastructure');
  const name=page.getByLabel('Nome técnico (letras minúsculas e hífen)');
  await name.fill('search-index');
  await page.getByRole('button',{name:'Preparar cadastro'}).click();
  const group=page.getByRole('group',{name:'Confirmar alteração no cadastro'});
  await expect(group).toContainText('terrania.mcp.search-index');
  await expect(group).toHaveAttribute('aria-describedby','infra-confirm-warning');
  await expect(group.getByRole('textbox',{name:'Confirmação'})).toBeFocused();
  await expect(group.getByRole('button',{name:'Confirmar no cadastro'})).toBeDisabled();
  await group.getByRole('button',{name:'Cancelar'}).click();
  await expect(group).toHaveCount(0);
  await expect(name).toBeFocused();
  expect(writes(state)).toEqual([]);
  const layout=await page.evaluate(()=>({w:document.documentElement.clientWidth,
    scroll:document.documentElement.scrollWidth}));
  expect(layout.scroll).toBeLessThanOrEqual(layout.w+1);
});

test('MCP: criação usa somente projeto vinculado, nome e confirmação exata',async ({page})=>{
  const state=await fixture(page);
  await page.goto('/angular/#infrastructure');
  await page.getByLabel('Nome técnico (letras minúsculas e hífen)').fill('search-index');
  await page.getByRole('button',{name:'Preparar cadastro'}).click();
  const group=page.getByRole('group',{name:'Confirmar alteração no cadastro'});
  const submit=group.getByRole('button',{name:'Confirmar no cadastro'});
  const confirm=group.getByRole('textbox',{name:'Confirmação'});
  await confirm.fill('terrania.mcp.search-indeX');
  await expect(submit).toBeDisabled();
  expect(writes(state)).toEqual([]);
  await confirm.fill('terrania.mcp.search-index');
  await submit.click();
  await expect(page.getByText('search-index',{exact:true})).toBeVisible();
  expect(writes(state)).toEqual([{
    method:'POST',path:'/infrastructure',
    payload:{projectSlug:'terrania',replicas:1,topology:'single-node',
      transport:'streamable-http',kind:'mcp',name:'search-index'}
  }]);
  await expect(page.getByText('Serviços provisionados por este módulo')).toBeVisible();
  await expect(page.getByText('Cadastro salvo · não provisionado').first()).toBeVisible();
});

test('Remoção: alvo de outro projeto é identificado e cancelamento preserva os dois',async ({page})=>{
  const state=await fixture(page);
  await page.goto('/angular/#infrastructure');
  const first=page.getByRole('button',{name:'Remover cadastro terrania.mcp.navigator'});
  const second=page.getByRole('button',{name:'Remover cadastro painel.cluster.workers'});
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await second.click();
  const group=page.getByRole('group',{name:'Confirmar alteração no cadastro'});
  await expect(group).toContainText('painel.cluster.workers');
  await expect(group.getByRole('textbox',{name:'Confirmação'})).toBeFocused();
  await group.getByRole('textbox',{name:'Confirmação'}).fill('terrania.mcp.navigator');
  await expect(group.getByRole('button',{name:'Confirmar no cadastro'})).toBeDisabled();
  await group.getByRole('button',{name:'Cancelar'}).click();
  await expect(second).toBeFocused();
  await expect(first).toBeVisible();
  expect(writes(state)).toEqual([]);
  expect(state.plans).toHaveLength(2);
});

test('Remoção confirmada envia ID e projeto exatos, sem tocar em outros cadastros',async ({page})=>{
  const state=await fixture(page);
  await page.goto('/angular/#infrastructure');
  await page.getByRole('button',{name:'Remover cadastro terrania.mcp.navigator'}).click();
  const group=page.getByRole('group',{name:'Confirmar alteração no cadastro'});
  await group.getByRole('textbox',{name:'Confirmação'}).fill('terrania.mcp.navigator');
  await group.getByRole('button',{name:'Confirmar no cadastro'}).click();
  await expect(page.getByRole('button',{name:'Remover cadastro terrania.mcp.navigator'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Remover cadastro painel.cluster.workers'})).toBeVisible();
  expect(writes(state)).toEqual([{method:'DELETE',path:'/infrastructure/terrania.mcp.navigator',
    payload:{projectSlug:'terrania',confirmId:'terrania.mcp.navigator'}}]);
});
