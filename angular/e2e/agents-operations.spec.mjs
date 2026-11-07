import {test,expect} from '@playwright/test';

async function fixture(page,{publish=false,destination=true}={}){
 const requests=[],id='a'.repeat(32),fingerprint='b'.repeat(64);
 const action={id,fingerprint,tool:publish?'publicar_pull_request':'solicitar_comando_vps',mode:'approval',status:'pending',
  destination:destination?(publish?{repository:'Softdown-prog/Painel',branch:'main'}:{host:'fixture-vps',user:'root'}):undefined,
  args:publish?{title:'Fixture PR',description:'Alteração de teste',baseSha:'c'.repeat(40),diff:'diff fixture',files:[{path:'safe.md',content:'<script>window.bad=1</script>'}]}:{command:'uptime',reason:'Consultar a carga'}};
 // Human approval outlives the initial model turn; polling must still work.
 const thread={id:'thread-e2e',project:publish?'Painel':'AdministracaoVPS',title:'Teste',status:'completed',reply:'',messages:[],actions:[action]};
 await page.route('**/api/**',async route=>{
  const r=route.request(),path=new URL(r.url()).pathname.slice('/api'.length),method=r.method();
  requests.push({path,method,body:method==='POST'?r.postDataJSON():null});let body;
  if(path==='/session')body={authenticated:true,setupRequired:false};
  else if(path==='/agents/status')body={enabled:true,ready:true,operationsEnabled:true,projects:['Geral','Painel','AdministracaoVPS']};
  else if(path==='/agents/projects')body={bindings:{Painel:{repository:'Softdown-prog/Painel',branch:'main'}},repositories:[{fullName:'Softdown-prog/Painel',branch:'main'}]};
  else if(path==='/agents/threads')body={threads:[thread]};
  else if(path==='/agents/threads/'+thread.id)body={thread};
  else if(path==='/agents/actions/'+id+'/approve'){
   if(publish){thread.status='completed';thread.actions=[];thread.messages=[{role:'assistant',text:'PR em rascunho criado.'}];}
   else{action.status='awaiting_output';action.result={exitCode:0,state:'completed',output:'uptime fixture output'};}
   body={ok:true};
  }else if(path==='/agents/actions/'+id+'/release'){
   thread.status='completed';thread.actions=[];thread.messages=[{role:'assistant',text:'Resultado recebido: uptime fixture output'}];body={ok:true};
  }else{await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Unmocked '+path})});return;}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 return {requests,action};
}
test('host command needs one approval and output needs explicit release',async({page})=>{
 const f=await fixture(page);await page.goto('/angular/#agents');
 const card=page.getByRole('region',{name:'Confirmação de operação'});
 await expect(card).toContainText('root@fixture-vps');await expect(card).toContainText('uptime');
 expect(f.requests.filter(r=>r.method==='POST')).toHaveLength(0);
 await card.getByRole('button',{name:'Aprovar uma vez'}).click();
 await expect(card).toContainText('uptime fixture output');
 await expect(page.getByRole('log')).not.toContainText('Resultado recebido');
 const approve=f.requests.find(r=>r.path.endsWith('/approve'));expect(approve.body).toEqual({fingerprint:f.action.fingerprint});
 await card.getByRole('button',{name:'Enviar saída ao Codex'}).click();
 await expect(page.getByRole('log')).toContainText('Resultado recebido');
 expect(f.requests.filter(r=>r.path.endsWith('/approve'))).toHaveLength(1);
});
test('approval remains disabled until destination is bound to the refreshed fingerprint',async({page})=>{
 const f=await fixture(page,{destination:false});await page.goto('/angular/#agents');
 await expect(page.getByRole('button',{name:'Aprovar uma vez'})).toBeDisabled();
 f.action.destination={host:'confirmed-vps',user:'root'};f.action.fingerprint='d'.repeat(64);
 await expect(page.getByText('root@confirmed-vps')).toBeVisible({timeout:6000});
 await page.getByRole('button',{name:'Aprovar uma vez'}).click();
 await expect.poll(()=>f.requests.find(r=>r.path.endsWith('/approve'))?.body).toEqual({fingerprint:'d'.repeat(64)});
});
test('draft PR proposal displays repository and file content as inert text',async({page})=>{
 await fixture(page,{publish:true});await page.goto('/angular/#agents');
 const card=page.getByRole('region',{name:'Confirmação de operação'});
 await expect(card).toContainText('Softdown-prog/Painel');
 await card.getByText('Revisar arquivos e diff',{exact:true}).click();await card.getByText('safe.md',{exact:true}).click();
 await expect(card.locator('pre').last()).toContainText('<script>window.bad=1</script>');
 expect(await page.evaluate(()=>window.bad)).toBeUndefined();
 await card.getByRole('button',{name:'Aprovar uma vez'}).click();await expect(page.getByRole('log')).toContainText('PR em rascunho criado.');
});
