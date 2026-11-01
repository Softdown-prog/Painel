import { test, expect } from '@playwright/test';

// No real VPS API is contacted. Each browser test intercepts every /api request.
async function mockApi(page, initial = {}) {
  const state = {
    authenticated: initial.authenticated === true,
    logoutFailure: initial.logoutFailure === true,
    requests: []
  };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice('/api'.length);
    const method = request.method();
    state.requests.push(method+' '+path);
    let status = 200;
    let body;
    if (method === 'GET' && path === '/session') {
      body={authenticated:state.authenticated,setupRequired:false};
    } else if (method === 'POST' && path === '/login') {
      const credentials=request.postDataJSON();
      if (credentials.username==='admin' && credentials.password==='e2e-password-not-real') {
        state.authenticated=true;
        body={ok:true};
      } else {
        status=401;
        body={error:'Credenciais de teste inválidas'};
      }
    } else if (method === 'POST' && path === '/logout') {
      if (state.logoutFailure) {
        status=503;
        body={error:'Falha simulada na saída'};
      } else {
        state.authenticated=false;
        body={ok:true};
      }
    } else if (!state.authenticated) {
      status=401;
      body={error:'Sessão de teste encerrada'};
    } else if (method === 'GET' && path === '/overview') {
      body={
        updatedAt:new Date().toISOString(),
        containerSummary:{available:true,running:2,total:3,truncated:false},
        memory:{used:1073741824,available:3221225472,total:4294967296,source:'memavailable'},
        disk:{used:10737418240,total:53687091200},
        cpu:{load1:0.4,cores:4}
      };
    } else if (method === 'GET' && path === '/containers') {
      body={readOnly:true,updatedAt:new Date().toISOString(),truncated:false,containers:[
        {name:'painel-ui',image:'panel:test',state:'running',status:'Up',project:'painel'},
        {name:'terrania-api',image:'terrania:test',state:'running',status:'Up',project:'terrania'},
        {name:'outro-app',image:'app:test',state:'exited',status:'Exited',project:'outro'}
      ]};
    } else if (method === 'GET' && path === '/repositories') {
      body={repositories:[],tokenConfigured:false,allowedOwner:'Softdown-prog'};
    } else if (method === 'GET' && path === '/services') {
      body={services:[]};
    } else if (method === 'GET' && path === '/infrastructure') {
      body={
        projects:['painel'],plans:[],
        capabilities:{configuration:true,provisioning:false,healthMonitoring:false,lifecycle:false},
        limits:{total:32,perProject:8,maxClusterReplicas:8}
      };
    } else {
      status=503;
      body={error:'Endpoint não simulado: '+method+' '+path};
    }
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  return state;
}
async function signIn(page) {
  await expect(page.getByRole('heading',{name:'Acesso administrativo'})).toBeVisible();
  await page.getByLabel('Senha',{exact:true}).fill('e2e-password-not-real');
  await page.getByRole('button',{name:'Entrar',exact:true}).click();
  await expect(page.getByRole('button',{name:'Sair'})).toBeVisible();
}

test('login real no navegador usa somente mock e exibe as métricas recebidas', async ({page})=>{
  const state=await mockApi(page);
  await page.goto('/angular/#overview');
  await signIn(page);
  await expect(page.locator('.metric').first()).toContainText('2');
  await expect(page.locator('.metric').first()).toContainText('Total: 3');
  expect(state.requests).toContain('POST /login');
  expect(state.requests).toContain('GET /overview');
  expect(state.requests).not.toContain('POST /apps');
});

test('sessão revogada bloqueia os dados sem reutilizar a leitura anterior',async ({page})=>{
  const state=await mockApi(page,{authenticated:true});
  await page.goto('/angular/#overview');
  await expect(page.locator('.metric').first()).toContainText('2');
  state.authenticated=false;
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('heading',{name:'Acesso administrativo'})).toBeVisible();
  await expect(page.locator('.metric')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Entrar',exact:true})).toBeVisible();
});

test('logout que falhou bloqueia login até a confirmação de nova tentativa',async ({page})=>{
  const state=await mockApi(page,{authenticated:true,logoutFailure:true});
  await page.goto('/angular/#overview');
  await page.getByRole('button',{name:'Sair'}).click();
  await expect(page.getByRole('button',{name:'Tentar encerrar sessão novamente'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Entrar',exact:true})).toHaveCount(0);
  state.logoutFailure=false;
  await page.getByRole('button',{name:'Tentar encerrar sessão novamente'}).click();
  await expect(page.getByRole('button',{name:'Entrar',exact:true})).toBeVisible();
  expect(state.requests.filter(req=>req==='POST /logout')).toHaveLength(2);
});

test('atalho legado de infraestrutura abre a página Angular sem provisionar nada',async ({page})=>{
  const state=await mockApi(page,{authenticated:true});
  await page.goto('/#infrastructure');
  await expect(page).toHaveURL(/\/angular\/#infrastructure$/);
  await expect(page.locator('main h1')).toHaveText('Clusters e servidores MCP');
  await expect(page.getByText('Somente cadastro de configuração.')).toBeVisible();
  expect(state.requests.some(req=>req.startsWith('POST ')||req.startsWith('DELETE '))).toBe(false);
});

test('navegação mobile usa hash e Voltar, com filtros reais do inventário mockado',async ({page})=>{
  await mockApi(page,{authenticated:true});
  await page.setViewportSize({width:390,height:844});
  await page.goto('/angular/#overview');
  const tabs=page.getByRole('navigation',{name:'Navegação rápida'});
  await tabs.getByRole('button',{name:'Containers'}).click();
  await expect(page).toHaveURL(/#containers$/);
  await expect(page.getByText('3 containers encontrados')).toBeVisible();
  await page.getByRole('searchbox',{name:'Buscar container ou imagem'}).fill('terrania');
  await expect(page.getByText('Mostrando 1 de 3 containers')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#overview$/);
  await expect(page.locator('main h1')).toHaveText('Visão geral');
});

for (const width of [320,360,390,768,1280]) {
  test('layout responsivo '+width+'px não cria rolagem horizontal',async ({page})=>{
    const state=await mockApi(page,{authenticated:true});
    await page.setViewportSize({width,height:844});
    await page.goto('/angular/#overview');
    await expect(page.locator('main h1')).toHaveText('Visão geral');
    await expect(page.locator('.metric').first()).toContainText('2');
    const size=await page.evaluate(()=>({
      viewport:document.documentElement.clientWidth,
      content:document.documentElement.scrollWidth
    }));
    expect(size.content,'overflow horizontal de página').toBeLessThanOrEqual(size.viewport+1);
    if(width<=900){
      const toggle=page.getByRole('button',{name:'Abrir ferramentas e navegação'});
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect(page.getByRole('navigation',{name:'Ferramentas de administração'})).toBeVisible();
      await page.getByRole('button',{name:/Clusters e MCP/}).click();
      await expect(page).toHaveURL(/#infrastructure$/);
      await expect(page.locator('main h1')).toHaveText('Clusters e servidores MCP');
      await expect(page.getByText('Somente cadastro de configuração.')).toBeVisible();
      expect(state.requests.some(req=>req.startsWith('POST '))).toBe(false);
    } else {
      await expect(page.getByRole('navigation',{name:'Navegação principal'})).toBeVisible();
    }
  });
}
