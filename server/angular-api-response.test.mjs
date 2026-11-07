import test from 'node:test';
import assert from 'node:assert/strict';
import {readPanelApiObject} from '../angular/src/api-response.ts';

test('HTML 200 fallback cannot be treated as session JSON or leak upstream markup',async()=>{
  const html='<!DOCTYPE html><html><body>edge-access-secret-never-expose</body></html>';
  const res=new Response(html,{status:200,headers:{'content-type':'text/html'}});
  await assert.rejects(()=>readPanelApiObject(res),error=>{
    assert.match(error.message,/API da VPS.*HTTP 200.*\/api\/session/);
    assert.doesNotMatch(error.message,/DOCTYPE|edge-access-secret/);
    return true;
  });
});
test('HTML Cloudflare outage returns a meaningful message without raw response',async()=>{
  const res=new Response('<!DOCTYPE html>Challenge internal token',{status:502,
    headers:{'content-type':'text/html; charset=utf-8'}});
  await assert.rejects(()=>readPanelApiObject(res),error=>{
    assert.match(error.message,/HTTP 502/);
    assert.doesNotMatch(error.message,/DOCTYPE|Challenge|token/i);
    return true;
  });
});
test('truncated JSON yields controlled diagnostic, not Unexpected token',async()=>{
  const res=new Response('{"authenticated":',{headers:{'content-type':'application/json'}});
  await assert.rejects(()=>readPanelApiObject(res),error=>{
    assert.match(error.message,/JSON inválido/);
    assert.doesNotMatch(error.message,/Unexpected token|SyntaxError/i);
    return true;
  });
});
test('valid session and valid API error JSON are preserved',async()=>{
  const session=await readPanelApiObject(Response.json({authenticated:false,setupRequired:false}));
  assert.equal(session.authenticated,false);
  assert.equal(session.setupRequired,false);
  const denied=await readPanelApiObject(Response.json({error:'Sessão necessária'},{status:401}));
  assert.equal(denied.error,'Sessão necessária');
});
test('non-object JSON payload is rejected regardless of status',async()=>{
  for (const x of ['[]','null','1','"ok"']) {
    const res=new Response(x,{headers:{'content-type':'application/json'}});
    await assert.rejects(()=>readPanelApiObject(res),/objeto JSON inesperado/);
  }
});
