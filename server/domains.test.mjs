import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleDomainRoute, renderManagedCaddy, validDomainZone, readDomainRoutes } from './domains.ts';
import { renderCaddyInstallCommand, renderPublicCaddy } from './domain-publish.ts';

const managed = {
  Id: 'abc123', Name: '/softload-app-demo',
  Config: { Labels: { 'com.softload.panel.managed': 'true', 'com.softload.panel.slug': 'demo' } },
  HostConfig: { NetworkMode: 'softload_panel_apps' },
  State: { Status: 'running' }
};
const dockerResult = (code, data = {}) => ({ status: code, buffer: Buffer.from(JSON.stringify(data)) });
function fakeDocker(network = 'softload_panel_apps') {
  const calls = [];
  const fn = async path => {
    calls.push(path);
    if (path === '/containers/softload-app-demo/json')
      return dockerResult(200, { ...managed, HostConfig: { NetworkMode: network } });
    if (path === '/containers/softload-app-foreign/json')
      return dockerResult(200, { ...managed, Name: '/softload-vps-app-1', Config: { Labels: {} } });
    return dockerResult(404);
  };
  return { fn, calls };
}
async function request(dataDir, url, method = 'GET', body = {}, options = {}) {
  let result;
  const docker = fakeDocker();
  const recognized = await handleDomainRoute({ url, method }, {}, {
    dataDir, docker: docker.fn, enabled: true, zone: 'apps.analysepro.com',
    body: async () => body,
    send: (_res, status, data) => { result = { status, data }; },
    ...options
  });
  assert.equal(recognized, true);
  return result;
}
test('zone and Caddy renderer reject wildcard and host injection', () => {
  assert.equal(validDomainZone('apps.analysepro.com'), true);
  assert.equal(validDomainZone('analysepro.com'), false);
  assert.equal(validDomainZone('apps.example.com\nrespond 200'), false);
  assert.equal(validDomainZone('apps.*.com'), false);
  assert.equal(validDomainZone('apps.example.co.uk'), true);
  assert.throws(() => renderManagedCaddy([{
    slug: 'demo', host: 'demo.apps.example.com\nreverse_proxy evil:80', port: 3000, createdAt: ''
  }]));
  assert.match(renderManagedCaddy([{ slug: 'demo', host: 'demo.apps.analysepro.com', port: 3000, createdAt: '' }]),
    /@panel_demo host demo\.apps\.analysepro\.com\nhandle @panel_demo \{\n    reverse_proxy softload-app-demo:3000/);
});
test('public gateway renderer accepts only stored routes and transports config without shell interpolation', () => {
  const route = { slug: 'demo', host: 'demo.apps.analysepro.com', port: 3000, createdAt: '' };
  const publicConfig = renderPublicCaddy([route]);
  assert.match(publicConfig, /https:\/\/demo\.apps\.analysepro\.com/);
  assert.match(publicConfig, /reverse_proxy app-gateway:8081/);
  const command = renderCaddyInstallCommand(publicConfig);
  assert.match(command, /docker network connect softload_panel_apps softload-caddy/);
  assert.match(command, /caddy validate/);
  assert.doesNotMatch(command, /demo\.apps\.analysepro\.com/);
});
test('domains only register panel-owned apps on isolated network; removal updates Caddy snippet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-domains-'));
  try {
    assert.equal((await request(dir, '/domains', 'GET')).data.routes.length, 0);
    assert.equal((await request(dir, '/domains', 'POST', { slug: 'demo', port: 3000 }, { enabled: false })).status, 403);
    assert.equal((await request(dir, '/domains', 'POST', { slug: 'demo', port: 3000 }, { zone: 'analysepro.com' })).status, 403);
    assert.equal((await request(dir, '/domains', 'POST', { slug: 'demo', port: 80 })).status, 400);
    assert.equal((await request(dir, '/domains', 'POST', { slug: 'demo', port: 3000, domain: 'evil.com' })).status, 400);
    assert.equal((await request(dir, '/domains', 'POST', { slug: 'admin', port: 3000 })).status, 400);
    assert.equal((await request(dir, '/domains', 'POST', { slug: 'foreign', port: 3000 })).status, 403);
    assert.equal((await request(dir, '/domains', 'POST', { slug: 'demo', port: 3000 }, { docker: fakeDocker('bridge').fn })).status, 409);
    const created = await request(dir, '/domains', 'POST', { slug: 'demo', port: 3000 });
    assert.equal(created.status, 201);
    assert.equal(created.data.live, false);
    assert.equal(created.data.route.host, 'demo.apps.analysepro.com');
    assert.equal((await request(dir, '/domains', 'POST', { slug: 'demo', port: 3100 })).status, 409);
    assert.equal(readDomainRoutes(dir).length, 1);
    const config = readFileSync(join(dir, 'caddy', 'managed-apps.caddy'), 'utf8');
    assert.match(config, /reverse_proxy softload-app-demo:3000/);
    assert.equal((await request(dir, '/domains/caddy')).data.content, config);
    const deleted = await request(dir, '/domains/demo', 'DELETE');
    assert.equal(deleted.status, 200);
    assert.deepEqual(readDomainRoutes(dir), []);
    assert.doesNotMatch(readFileSync(join(dir, 'caddy', 'managed-apps.caddy'), 'utf8'), /demo\.apps/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
