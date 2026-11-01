import {test,expect} from '@playwright/test';

async function mockSettings(page,{passwordError=false}={}){
 const state={passwordError,requests:[]};
 await page.route('**/api/**',async route=>{
   const req=route.request(),path=new URL(req.url()).pathname.slice('/api'.length);
   const method=req.method();
   const payload=req.postDataJSON?.()??null;
   state.requests.push({method,path,payload});
   let status=200,body;
   if(method==='GET'&&path==='/session')
     body={authenticated:true,setupRequired:false};
   else if(method==='POST'&&path==='/password'){
     status=state.passwordError?503:200;
     body=state.passwordError?{error:'Falha de teste sem alterar senha'}:{ok:true};
   }else{status=503;body={error:'Endpoint não simulado '+method+' '+path};}
   await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });
 return state;
}
async function prepare(page){
 await page.goto('/angular/#settings');
 await page.getByLabel('Senha atual').fill('senha-antiga-somente-teste');
 await page.getByLabel('Nova senha',{exact:true}).fill('senha-nova-somente-teste-123');
 await page.getByLabel('Confirme a nova senha').fill('senha-nova-somente-teste-123');
 await page.getByRole('button',{name:'Preparar troca de senha'}).click();
 return page.getByRole('group',{name:'Confirmar mudança de senha'});
}
test('troca administrativa foca confirmação e proíbe envio sem texto exato',async ({page})=>{
 const state=await mockSettings(page);
 const group=await prepare(page);
 await expect(group).toBeVisible();
 await expect(group.getByLabel('Confirmação')).toBeFocused();
 const confirm=group.getByRole('button',{name:'Confirmar troca'});
 await expect(confirm).toBeDisabled();
 await group.getByLabel('Confirmação').fill('ALTERAR');
 await expect(confirm).toBeDisabled();
 expect(state.requests.filter(x=>x.method==='POST')).toEqual([]);
});

test('cancelar troca limpa ambas as senhas e devolve foco ao formulário',async ({page})=>{
 const state=await mockSettings(page);
 const group=await prepare(page);
 await group.getByLabel('Confirmação').fill('ALTERAR SENHA');
 await group.getByRole('button',{name:'Cancelar'}).click();
 await expect(group).toHaveCount(0);
 await expect(page.getByLabel('Senha atual')).toBeFocused();
 await expect(page.getByLabel('Senha atual')).toHaveValue('');
 await expect(page.getByLabel('Nova senha',{exact:true})).toHaveValue('');
 await expect(page.getByLabel('Confirme a nova senha')).toHaveValue('');
 expect(state.requests.filter(x=>x.method==='POST')).toEqual([]);
});

test('falha na API não preserva credenciais, não afirma mudança e restaura foco',async ({page})=>{
 const state=await mockSettings(page,{passwordError:true});
 const group=await prepare(page);
 await group.getByLabel('Confirmação').fill('ALTERAR SENHA');
 await group.getByRole('button',{name:'Confirmar troca'}).click();
 await expect(page.getByText('Falha de teste sem alterar senha')).toBeVisible();
 await expect(group).toHaveCount(0);
 await expect(page.getByLabel('Senha atual')).toHaveValue('');
 await expect(page.getByLabel('Nova senha',{exact:true})).toHaveValue('');
 await expect(page.getByLabel('Senha atual')).toBeFocused();
 expect(state.requests.filter(x=>x.method==='POST'&&x.path==='/password')).toHaveLength(1);
});

test('confirmação de troca de senha mantém navegação mobile sem rolagem horizontal',async ({page})=>{
 await mockSettings(page);
 await page.setViewportSize({width:320,height:720});
 const group=await prepare(page);
 await expect(group.getByLabel('Confirmação')).toBeFocused();
 const dims=await page.evaluate(()=>({
   viewport:document.documentElement.clientWidth,
   content:document.documentElement.scrollWidth
 }));
 expect(dims.content).toBeLessThanOrEqual(dims.viewport+1);
});
