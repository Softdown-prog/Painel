import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';

const key = readFileSync('/run/secrets/panel-edge-key', 'utf8').trim();
const password = 'CI-Only-A11y-Passphrase-2026';
function call(path, method='GET', body, cookie, timeout=5000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port: 8080, path, method, timeout,
      headers: {
        'x-panel-edge-key': key,
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        ...(cookie ? { cookie } : {})
      }
    }, res => {
      let result = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if ((result += chunk).length > 100000) req.destroy(new Error('Oversized response')); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(result), cookie: res.headers['set-cookie']?.[0] }); }
        catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('API timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}
async function main() {
  let ready = false;
  for (let i=0;i<45;i++) {
    try {
      const result = await call('/session');
      if (result.status === 200 && result.data?.setupRequired === true) { ready=true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready, 'Panel API did not start in clean CI sandbox');

  const protectedResponse = await call('/services');
  assert.equal(protectedResponse.status, 401, 'Service data must require an admin session');
  const badEdge = await new Promise((resolve, reject) => {
    http.get({hostname:'127.0.0.1',port:8080,path:'/session'}, r => {r.resume();resolve(r.statusCode);}).on('error',reject);
  });
  assert.equal(badEdge, 404, 'No API should be returned without an edge key');

  const setupToken = readFileSync('/data/setup-token', 'utf8').trim();
  assert.equal((await call('/setup', 'POST', { setupToken, password })).status, 201);
  const auth = await call('/login', 'POST', { username:'admin', password });
  assert.equal(auth.status, 200);
  const cookie = auth.cookie?.split(';')[0];
  assert.match(cookie || '', /^panel_session=[a-f0-9]{64}$/);

  const services = await call('/services','GET',undefined,cookie);
  assert.equal(services.status, 200, JSON.stringify(services.data));
  assert.ok(Array.isArray(services.data.services));
  assert.deepEqual(services.data.services.map(service => service.id), ['app', 'agent', 'caddy']);
  assert.equal(services.data.services.find(service => service.id === 'caddy')?.controllable, false);
  assert.ok(services.data.services.every(service => !service.controllable), 'No missing Docker container can be controlled');
  const apps = await call('/apps','GET',undefined,cookie);
  assert.equal(apps.status, 200, JSON.stringify(apps.data));
  assert.ok(Array.isArray(apps.data.applications));
  assert.deepEqual(apps.data.applications, []);
  assert.equal(apps.data.enabled, false);
  const hosted = await call('/hosted-projects','GET',undefined,cookie);
  assert.equal(hosted.status, 200, JSON.stringify(hosted.data));
  assert.deepEqual(hosted.data.projects, [], 'A clean VPS must not invent a Softload project');

  const revisions = await call('/maintenance/revisions','GET',undefined,cookie);
  assert.equal(revisions.status,200,JSON.stringify(revisions.data));
  assert.equal(revisions.data.totalImports,0);
  assert.equal(revisions.data.oldCount,0);
  assert.equal(revisions.data.enabled,false);
  assert.equal(revisions.data.hostInventory.available,true);
  assert.ok(revisions.data.hostInventory.total>=0);
  const overview = await call('/overview','GET',undefined,cookie);
  assert.equal(overview.status, 200, JSON.stringify(overview.data));
  assert.deepEqual(overview.data.services.map(service => service.id), ['app', 'agent', 'caddy']);
  // CI has Docker but no Softload containers and no external network. The UI must not invent an active release.
  const deploy = await call('/deploys','GET',undefined,cookie,18000);
  assert.equal(deploy.status,200,JSON.stringify(deploy.data));
  // The executor rejects introspection of a nonexistent allowlisted container (403).
  // This must remain inconclusive; it is not proof of a running or inactive version.
  assert.equal(deploy.data.runtime?.app?.status,'unavailable');
  assert.equal(deploy.data.publicHealth?.status,'unavailable');
  assert.equal(deploy.data.runtime?.services?.app?.revision,null);
  assert.deepEqual(Object.keys(deploy.data.runtime?.services || {}), ['app', 'agent']);
  const blocked = await call('/apps','POST',{slug:'blocked',image:'fake:1'},cookie);
  assert.equal(blocked.status, 403, 'New apps must remain disabled by default');

  console.log('PASS: edge auth, admin login, Docker executor-backed services, empty apps and disabled mutations');
}
main().catch(error => {console.error(error.message);process.exitCode=1;});
