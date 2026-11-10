import {test,expect} from '@playwright/test';

test('mobile database browser edits only confirmed rows and requires opt-in for SQL writes',async({page})=>{
  const writes=[];
  await page.setViewportSize({width:390,height:844});
  await page.route('**/api/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname.slice(4),payload=req.method()==='POST'?req.postDataJSON():null;
    if(payload)writes.push({path,payload});
    let data={error:'Not mocked'},status=503;
    if(path==='/session'){data={authenticated:true,setupRequired:false};status=200;}
    if(path==='/database/status'){status=200;data={engine:'postgresql',integration:'connected',enabled:true,instance:{version:'18.6'},
      databases:[{name:'postgres',owner:'postgres',sizeBytes:8000000},{name:'alpha',owner:'owner_alpha',sizeBytes:8000000}],roles:[],
      metrics:{databaseCount:2,connections:3,totalBytes:16000000},security:{hostAuthentication:'trust',adminAuthentication:'verified-certificate',provisioningEnabled:true,message:'Certificado verificado'},checkedAt:new Date().toISOString(),message:'Conectado'};}
    if(path==='/database/admin/alpha/tables'){status=200;data={database:'alpha',owner:'owner_alpha',tables:[{schema:'public',name:'items',kind:'r',size_bytes:'8192',estimated_rows:'1'}]};}
    if(path==='/database/admin/alpha/rows'){
      status=200;data=payload?{ok:true,affectedRows:1}:{columns:[{name:'id',type:'bigint',primary:true,generated:true,nullable:false},{name:'name',type:'text',primary:false,generated:false,nullable:false}],rows:[{id:'9007199254740993',name:'Original',__panel_version:'12'}],offset:0,hasMore:false};}
    if(path==='/database/admin/alpha/sql'){status=200;data={columns:['n'],rows:[{n:1}],truncated:false,affectedRows:1,command:'SELECT'};}
    if(path==='/database/admin/alpha/backups'){status=200;data={backups:[]};}
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto('/angular/#database');
  await page.getByRole('button',{name:'Gerenciar banco',exact:true}).click();
  await page.getByRole('button',{name:'Abrir dados',exact:true}).click();
  await expect(page.getByText('9007199254740993',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Editar',exact:true}).click();
  await page.getByLabel('Valores (JSON)').fill('{"name":"Atualizado"}');
  const confirm=page.getByRole('button',{name:'Confirmar gravação'});
  await expect(confirm).toBeDisabled();await expect(writes).toHaveLength(0);
  await page.getByLabel('Digite alpha para confirmar a alteração').fill('alpha');
  await confirm.click();await expect(page.getByRole('status').filter({hasText:'Registro atualizado'})).toBeVisible();
  expect(writes[0].payload).toMatchObject({key:{id:'9007199254740993'},version:'12',values:{name:'Atualizado'},confirmation:'alpha'});
  await page.getByRole('button',{name:'Editor SQL',exact:true}).click();
  await page.getByLabel('SQL',{exact:true}).fill('SELECT 1 AS n');await page.getByRole('button',{name:'Executar consulta',exact:true}).click();
  await expect(page.getByRole('button',{name:'Copiar resultado'})).toBeVisible();
  expect(writes.at(-1).payload.write).toBe(false);
  await page.getByLabel('Permitir alteração de dados e estrutura').check();
  await expect(page.getByRole('button',{name:'Confirmar e executar SQL'})).toBeDisabled();
  await page.getByLabel('Digite alpha para autorizar').fill('alpha');
  await expect(page.getByRole('button',{name:'Confirmar e executar SQL'})).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});


test('manual primary keys are editable while PostgreSQL defaults stay omitted',async({page})=>{
  const writes=[];
  await page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.slice(4);
    const payload=request.method()==='POST'?request.postDataJSON():null;
    if(path==='/session')return route.fulfill({contentType:'application/json',body:JSON.stringify({authenticated:true,setupRequired:false})});
    if(path==='/database/status')return route.fulfill({contentType:'application/json',body:JSON.stringify({
      engine:'postgresql',integration:'connected',enabled:true,instance:{version:'18.6'},
      databases:[{name:'postgres',owner:'postgres',sizeBytes:1000},{name:'alpha',owner:'owner_alpha',sizeBytes:1000}],
      roles:[],metrics:{databaseCount:2,connections:1,totalBytes:2000},
      security:{hostAuthentication:'trust',adminAuthentication:'verified-certificate',provisioningEnabled:true,message:'OK'},
      checkedAt:new Date().toISOString(),message:'Conectado'})});
    if(path==='/database/admin/alpha/tables')return route.fulfill({contentType:'application/json',body:JSON.stringify({
      tables:[{schema:'public',name:'catalogo',kind:'r',size_bytes:'8192',estimated_rows:'0'}]})});
    if(path==='/database/admin/alpha/rows'){
      if(payload){writes.push(payload);return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,affectedRows:1})});}
      return route.fulfill({contentType:'application/json',body:JSON.stringify({
        columns:[
          {name:'codigo',type:'text',primary:true,generated:false,nullable:false,defaulted:false},
          {name:'criado_em',type:'timestamp',primary:false,generated:false,nullable:false,defaulted:true},
          {name:'observacao',type:'text',primary:false,generated:false,nullable:true,defaulted:false}],
        rows:[],offset:0,hasMore:false})});
    }
    return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Not mocked'})});
  });
  await page.goto('/angular/#database');
  await page.getByRole('button',{name:'Gerenciar banco',exact:true}).click();
  await page.getByRole('button',{name:'Abrir dados',exact:true}).click();
  await page.getByRole('button',{name:'Adicionar registro'}).click();
  const input=page.getByLabel('Valores (JSON)');
  expect(JSON.parse(await input.inputValue())).toEqual({codigo:null});
  await input.fill('{"codigo":"MANUAL-001"}');
  await page.getByLabel('Digite alpha para confirmar a alteração').fill('alpha');
  await page.getByRole('button',{name:'Confirmar gravação'}).click();
  await expect(page.getByRole('status').filter({hasText:'Registro adicionado'})).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].values).toEqual({codigo:'MANUAL-001'});
});
