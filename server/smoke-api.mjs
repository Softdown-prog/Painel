import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';

const key = readFileSync('/run/secrets/panel-edge-key', 'utf8').trim();
const password = 'CI-Only-A11y-Passphrase-2026';
function call(path, method='GET', body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port: 8080, path, method, timeout: 5000,
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
  assert.equal(services.data.services.length, 6);
  const apps = await call('/apps','GET',undefined,cookie);
  assert.equal(apps.status, 200, JSON.stringify(apps.data));
  assert.ok(Array.isArray(apps.data.applications));
  assert.deepEqual(apps.data.applications, []);
  assert.equal(apps.data.enabled, false);

  const overview = await call('/overview','GET',undefined,cookie);
  assert.equal(overview.status, 200, JSON.stringify(overview.data));
  assert.equal(overview.data.services.length, 6);
  const blocked = await call('/apps','POST',{slug:'blocked',image:'fake:1'},cookie);
  assert.equal(blocked.status, 403, 'New apps must remain disabled by default');

  console.log('PASS: edge auth, admin login, Docker executor-backed services, empty apps and disabled mutations');
}
main().catch(error => {console.error(error.message);process.exitCode=1;});
