import {test,expect} from '@playwright/test';

const id='f'.repeat(32);
const makeJob=(state='running',output='')=>({
 id,state,startedAt:'2026-10-31T20:00:00.000Z',
 finishedAt:state==='running'?null:'2026-10-31T20:00:10.000Z',
 exitCode:state==='completed'?0:null,output,truncated:false,
 durationMs:10000,error:null,fingerprint:'a'.repeat(16)
});

async function fixture(page,{onCurrent,onCancel,initialOutput=''}={}){
 const requests=[];
 let started=false;
 await page.route('**/api/**',async route=>{
  const req=route.request();
  const path=new URL(req.url()).pathname.slice('/api'.length);
  const method=req.method();
  requests.push({method,path});
  let status=200,body;
  if(path==='/session'&&method==='GET'){
   body={authenticated:true,setupRequired:false};
  }else if(path==='/terminal/ssh/status'&&method==='GET'){
   body={enabled:true,configured:true};
  }else if(path==='/terminal/ssh/jobs/current'&&method==='GET'){
   body=started?(await onCurrent?.())??{job:null}:{job:null};
  }else if(path==='/terminal/ssh/jobs'&&method==='POST'){
   started=true;
   body={job:makeJob('running',initialOutput)};
   status=202;
  }else if(path==='/terminal/ssh/jobs/'+id+'/cancel'&&method==='POST'){
   body=onCancel?await onCancel():{job:makeJob('cancelled','interrompida')};
  }else{
   status=503;
   body={error:'Mock não configurado: '+method+' '+path};
  }
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });
 return {requests};
}
async function startJob(page){
 await page.goto('/angular/#terminal');
 await expect(page.getByText('Terminal SSH habilitado e configurado')).toBeVisible();
 await page.locator('#sshCommand').fill('printf teste');
 await page.getByRole('button',{name:'Preparar execução'}).click();
 await page.getByRole('button',{name:'Confirmar execução'}).click();
 await expect(page.getByRole('region',{name:'Acompanhamento da tarefa SSH'})).toContainText('Em execução');
}

test('Terminal bloqueia sobreposição de polls e ignora resposta antiga após cancelar',async({page})=>{
 let pollingCount=0,releaseOld;
 const oldResponse=new Promise(resolve=>{releaseOld=resolve;});
 const state=await fixture(page,{
  onCurrent:async()=>{
   pollingCount++;
   if(pollingCount===1){
    await oldResponse;
    return {job:makeJob('running','saída antiga')};
   }
   return {job:makeJob('cancelled','interrompida')};
  }
 });
 await startJob(page);
 await expect.poll(()=>pollingCount,{timeout:7000}).toBe(1);
 await page.getByRole('button',{name:'Atualizar saída'}).click();
 expect(pollingCount).toBe(1); // one HTTP GET per generation
 await page.getByRole('button',{name:'Solicitar interrupção'}).click();
 await page.getByRole('button',{name:'Confirmar interrupção'}).click();
 await expect(page.getByRole('region',{name:'Acompanhamento da tarefa SSH'})).toContainText('Cancelamento solicitado');
 releaseOld();
 await expect(page.getByRole('region',{name:'Acompanhamento da tarefa SSH'})).not.toContainText('Em execução');
 await expect(page.getByRole('region',{name:'Resultado do terminal'})).toContainText('interrompida');
 expect(state.requests.filter(r=>r.method==='POST'&&r.path==='/terminal/ssh/jobs')).toHaveLength(1);
});

test('Terminal conserva tarefa incerta e bloqueia segunda execução quando API perde registro',async({page})=>{
 let pollCount=0;
 const state=await fixture(page,{
  onCurrent:async()=>{
   pollCount++;
   return {job:null}; // API restarted; remote command might still be active.
  }
 });
 await startJob(page);
 await expect.poll(()=>pollCount,{timeout:7000}).toBeGreaterThan(0);
 await expect(page.getByRole('alert')).toContainText('A API perdeu o acompanhamento');
 await expect(page.getByRole('region',{name:'Acompanhamento da tarefa SSH'})).toContainText('Em execução');
 await expect(page.getByRole('button',{name:'Preparar execução'})).toBeDisabled();
 await expect(page.locator('#sshCommand')).toBeDisabled();
 expect(state.requests.filter(r=>r.method==='POST'&&r.path==='/terminal/ssh/jobs')).toHaveLength(1);
});

test('Terminal recupera atualização confirmada depois de consulta incerta',async({page})=>{
 let count=0;
 await fixture(page,{
  onCurrent:async()=>{
   count++;
   return count===1?{job:null}:{job:makeJob('completed','operação concluída')};
  }
 });
 await startJob(page);
 await expect(page.getByRole('alert')).toContainText('A API perdeu o acompanhamento',{timeout:7000});
 await page.getByRole('button',{name:'Atualizar saída'}).click();
 await expect(page.getByRole('region',{name:'Resultado do terminal'})).toContainText('operação concluída');
 await expect(page.getByRole('alert')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Preparar execução'})).toBeDisabled(); // Empty command after success.
 await page.locator('#sshCommand').fill('uptime');
 await expect(page.getByRole('button',{name:'Preparar execução'})).toBeEnabled();
});

test('Botão copiar no final da saída parcial e concluída transfere texto exato para a área de transferência',async({page,context})=>{
 await context.grantPermissions(['clipboard-read','clipboard-write']);
 const partial='linha um\n{ "status": "ok" }\n<texto puro>\n';
 const final=partial+'final: sucesso\n';
 let completed=false;
 await fixture(page,{
  initialOutput:partial,
  onCurrent:async()=>({job:makeJob(completed?'completed':'running',completed?final:partial)})
 });
 await startJob(page);
 const running=page.getByRole('region',{name:'Saída parcial do terminal'});
 await expect(running.locator('pre')).toHaveText(partial);
 const copyPartial=running.getByRole('button',{name:'Copiar saída'});
 await expect(copyPartial).toBeVisible();
 await copyPartial.click();
 await expect(running.getByRole('button',{name:/Copiado/})).toBeVisible();
 expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(partial);

 completed=true;
 await page.getByRole('button',{name:'Atualizar saída'}).click();
 const result=page.getByRole('region',{name:'Resultado do terminal'});
 await expect(result.locator('pre')).toHaveText(final);
 await expect(running).toHaveCount(0);
 const copyFinal=result.getByRole('button',{name:'Copiar saída'});
 await expect(copyFinal).toBeVisible(); // feedback reiniciado após nova saída
 await copyFinal.click();
 await expect(result.getByRole('button',{name:/Copiado/})).toBeVisible();
 expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(final);
});

test('Falha na permissão de clipboard exibe erro sem anunciar cópia concluída',async({page})=>{
 await page.addInitScript(()=>{
  Object.defineProperty(navigator,'clipboard',{
   configurable:true,value:{writeText:async()=>{throw new Error('Permissão bloqueada');}}
  });
 });
 await fixture(page,{initialOutput:'saída administrativa'});
 await startJob(page);
 const running=page.getByRole('region',{name:'Saída parcial do terminal'});
 await running.getByRole('button',{name:'Copiar saída'}).click();
 await expect(running.getByRole('alert')).toContainText('Não foi possível copiar');
 await expect(running.getByRole('button',{name:'Copiar saída'})).toBeVisible();
 await expect(running.getByRole('button',{name:/Copiado/})).toHaveCount(0);
});

test('Não oferece cópia de texto fictício enquanto saída está vazia',async({page})=>{
 await fixture(page);
 await startJob(page);
 const running=page.getByRole('region',{name:'Saída parcial do terminal'});
 await expect(running.locator('pre')).toContainText('aguardando saída');
 await expect(running.getByRole('button',{name:'Copiar saída'})).toBeDisabled();
});
