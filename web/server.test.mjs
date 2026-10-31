import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPanelWebServer } from './server.mjs';

const KEY = 'staging-edge-key-that-is-at-least-32-bytes-long';
async function setup(t) {
  const staticDir = mkdtempSync(join(tmpdir(), 'panel-web-test-'));
  writeFileSync(join(staticDir, 'index.html'), '<h1>Painel local</h1>');
  writeFileSync(join(staticDir, 'app.js'), 'console.log("safe")');
  writeFileSync(join(staticDir, 'app.css'), 'body{}');
  mkdirSync(join(staticDir, 'angular'));
  writeFileSync(join(staticDir, 'angular', 'index.html'), '<base href="/angular/"><panel-app></panel-app>');
  writeFileSync(join(staticDir, 'angular', 'main-123.js'), 'console.log("angular")');
  writeFileSync(join(staticDir, 'angular', 'styles-123.css'), 'body{color:red}');
  const calls = [];
  const api = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString('utf8');
    calls.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.setHeader('content-type', 'application/json');
    res.setHeader('set-cookie', [
      'panel_session=abc123; Path=/api; HttpOnly; Secure; SameSite=Strict',
      'other_cookie=unsafe; Path=/'
    ]);
    res.end(JSON.stringify({authenticated:false,setupRequired:false,method:req.method,body}));
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const port = api.address().port;
  const web = createPanelWebServer({
    edgeKey:KEY,staticDir,publicOrigin:'http://panel.test',
    apiHost:'127.0.0.1',apiPort:port
  });
  web.listen(0,'127.0.0.1');
  await once(web,'listening');
  const origin = 'http://127.0.0.1:' + web.address().port;
  t.after(async () => {
    await Promise.all([new Promise(resolve=>web.close(resolve)),new Promise(resolve=>api.close(resolve))]);
    rmSync(staticDir,{recursive:true,force:true});
  });
  return {origin,calls};
}
test('serves index and JS from the VPS while forbidding private files and path traversal',async t=>{
  const {origin}=await setup(t);
  const html=await fetch(origin+'/');assert.equal(html.status,200);
  assert.match(await html.text(),/Painel local/);
  assert.match(html.headers.get('cache-control'),/no-cache/);
  const js=await fetch(origin+'/app.js?v=abcd');
  assert.equal(js.status,200);assert.match(js.headers.get('content-type'),/javascript/);
  for(const path of ['/server/api.mjs','/.env','/package.json','/%2e%2e/README.md','//outside','/app%2fsecret.js']){
    const res=await fetch(origin+path,{redirect:'manual'});
    assert.notEqual(res.status,200,'Sensitive path must not succeed: '+path);
  }
});
test('does not expose or trust the browser supplied internal edge key',async t=>{
  const {origin,calls}=await setup(t);
  const result=await fetch(origin+'/api/session?check=1',{headers:{
    'x-panel-edge-key':'attacker-secret','cf-connecting-ip':'8.8.8.8',
    'x-forwarded-for':'9.9.9.9'
  }});
  assert.equal(result.status,200);
  assert.equal(calls.length,1);
  assert.equal(calls[0].headers['x-panel-edge-key'],KEY);
  assert.equal(calls[0].url,'/session?check=1');
  assert.equal(calls[0].headers['cf-connecting-ip'],undefined);
  assert.equal(calls[0].headers['x-forwarded-for'],undefined);
  assert(!result.headers.has('x-panel-edge-key'));
});
test('preserves admin session cookie, JSON and HTTP statuses without exposing extra cookies',async t=>{
  const {origin,calls}=await setup(t);
  const res=await fetch(origin+'/api/session',{headers:{cookie:'panel_session=testing'}});
  assert.equal(res.status,200);
  assert.equal((await res.json()).authenticated,false);
  assert.match(res.headers.get('set-cookie'),/^panel_session=/);
  assert(!res.headers.get('set-cookie').includes('other_cookie'));
  assert.equal(calls[0].headers.cookie,'panel_session=testing');
});
test('rejects cross-origin state changes before contacting API',async t=>{
  const {origin,calls}=await setup(t);
  const res=await fetch(origin+'/api/login',{method:'POST',headers:{
    origin:'https://attacker.invalid','content-type':'application/json'
  },body:'{}'});
  assert.equal(res.status,403);
  assert.equal(calls.length,0);
});
test('permits exact configured origin for POST while rejecting unsupported methods',async t=>{
  const {origin,calls}=await setup(t);
  const post=await fetch(origin+'/api/login',{method:'POST',headers:{
    origin:'http://panel.test','content-type':'application/json'
  },body:'{"username":"admin"}'});
  assert.equal(post.status,200);
  assert.equal(calls[0].body,'{"username":"admin"}');
  const invalid=await fetch(origin+'/api/login',{method:'PUT',headers:{origin:'http://panel.test'}});
  assert.equal(invalid.status,405);
  assert.equal(calls.length,1);
});
test('only forwards API paths and never redirects API calls to static index',async t=>{
  const {origin,calls}=await setup(t);
  for(const path of ['/api','/api//session','/api/%2e%2e/secret','/api/..%2fsecret']){
    const res=await fetch(origin+path,{redirect:'manual'});
    assert.notEqual(res.status,200,path);
  }
  assert.equal(calls.length,0);
});
test('health route does not require the backend or authentication',async t=>{
  const {origin,calls}=await setup(t);
  const health=await fetch(origin+'/__panel_web_health');
  assert.equal(health.status,200);
  assert.equal(calls.length,0);
});
test('invalid secret or external HTTP API target fails closed at startup',()=>{
  assert.throws(()=>createPanelWebServer({edgeKey:'short',staticDir:'/tmp',publicOrigin:'http://panel.test'}),/secret/);
  assert.throws(()=>createPanelWebServer({edgeKey:KEY,staticDir:'/tmp',publicOrigin:'http://panel.test',apiHost:'evil.test/path'}),/target/);
});

test('serves Angular entrypoint and hashed JS/CSS from private VPS frontend', async t => {
  const {origin}=await setup(t);
  const redirect=await fetch(origin+'/angular',{redirect:'manual'});
  assert.equal(redirect.status,308);
  assert.equal(redirect.headers.get('location'),'/angular/');
  const page=await fetch(origin+'/angular/');
  assert.equal(page.status,200);
  assert.match(await page.text(),/<panel-app>/);
  const js=await fetch(origin+'/angular/main-123.js');
  assert.equal(js.status,200);
  assert.match(js.headers.get('content-type'),/javascript/);
  assert.equal((await fetch(origin+'/angular/styles-123.css')).status,200);
  for (const path of ['/angular/tsconfig.json','/angular/package.json','/angular/src/main.ts',
    '/angular/%2e%2e%2fserver.mjs','/angular/nested/main.js','/angular/evil%5c.js']) {
    const r=await fetch(origin+path,{redirect:'manual'});
    assert.notEqual(r.status,200,path);
  }
});
