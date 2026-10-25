import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAppRoute, scanIdleApps, validSlug, validImage } from './apps.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const tags = { 'com.softload.panel.managed': 'true', 'com.softload.panel.slug': 'teste' };
const managed = { Id: 'abc123', Names: ['/softload-app-teste'], Image: 'example:1', State: 'created', Status: 'Created', Labels: tags };
const response = (status, data = {}) => ({ status, buffer: Buffer.from(JSON.stringify(data)) });
const docker = async (path, method = 'GET', payload) => {
  docker.calls.push({ path, method, payload });
  if (path.startsWith('/containers/json')) return response(200, docker.created ? [managed] : []);
  if (path === '/images/json') return response(200, [{ RepoTags: ['example:1'] }]);
  if (path.startsWith('/containers/create')) { docker.created = true; return response(201, { Id: 'abc123' }); }
  if (path.endsWith('/json')) return response(200, { Id: 'abc123', Name: '/softload-app-teste', Config: { Labels: tags, Image: 'example:1' }, State: { Status: 'created' } });
  if (path.includes('/start?')) return response(204);
  if (method === 'DELETE') { docker.created = false; return { status: 204, buffer: Buffer.alloc(0) }; }
  return response(404);
};
docker.calls = [];
docker.created = false;
async function request(url, method = 'GET', data = {}, options = {}) {
  let result;
  const handled = await handleAppRoute({ url, method }, {}, {
    docker, body: async () => data, enabled: true, images: ['example:1'],
    send: (_res, status, payload) => { result = { status, data: payload }; }, ...options
  });
  assert.equal(handled, true);
  assert.ok(result);
  return result;
}
test('slugs reject traversal and images require an explicit allowlist', () => {
  assert.equal(validSlug('site-demo'), true);
  for (const bad of ['x', '../root', 'A-B', 'name/../../root', 'bad--name', 'bad-', '', 'a'.repeat(41)])
    assert.equal(validSlug(bad), false);
  assert.equal(validImage('example:1', ['example:1']), true);
  assert.equal(validImage('other:1', ['example:1']), false);
});
test('create enforces limits and operates on labelled containers', async () => {
  docker.created = false;
  docker.calls = [];
  assert.equal((await request('/apps', 'POST', { slug: 'teste', image: 'evil:1' })).status, 400);
  assert.equal(docker.calls.length, 0);
  assert.equal((await request('/apps', 'POST', { slug: 'teste', image: 'example:1', Privileged: true })).status, 400);
  assert.equal((await request('/apps', 'POST', { slug: 'teste', image: 'example:1' })).status, 201);
  const create = docker.calls.find(v => v.path.startsWith('/containers/create'));
  assert.equal(create.payload.User, '65534:65534');
  assert.equal(create.payload.HostConfig.ReadonlyRootfs, true);
  assert.equal(create.payload.HostConfig.PublishAllPorts, false);
  assert.equal(create.payload.HostConfig.Memory, 268435456);
  assert.equal(create.payload.HostConfig.NanoCpus, 500000000);
  assert.deepEqual(create.payload.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(create.payload.HostConfig.SecurityOpt, ['no-new-privileges']);
  assert.equal(create.payload.HostConfig.NetworkMode, 'bridge');
  assert.equal(Object.keys(create.payload.HostConfig).includes('Binds'), false);
  assert.equal((await request('/apps')).data.applications.length, 1);
  assert.equal((await request('/apps/teste/start', 'POST')).status, 200);
  assert.equal((await request('/apps/teste', 'DELETE')).status, 200);
  assert.equal((await request('/apps')).data.applications.length, 0);
});
test('disabled mutations and unowned containers cannot be controlled', async () => {
  assert.equal((await request('/apps', 'POST', { slug: 'teste', image: 'example:1' }, { enabled: false })).status, 403);
  const unowned = async (path) => {
    if (path.includes('/json')) return response(200, { Id: 'legacy', Name: '/softload-vps-app-1', Config: { Labels: {} } });
    return response(200, []);
  };
  assert.equal((await request('/apps/teste/start', 'POST', {}, { docker: unowned })).status, 403);
});
test('resource changes are bounded and only apply to owned containers', async () => {
  const calls = [];
  const ownedDocker = async (path, method, payload) => {
    calls.push({ path, method, payload });
    if (path.endsWith('/json')) return response(200, { Id: 'abc123', Name: '/softload-app-teste', Config: { Labels: tags }, State: { Status: 'running' } });
    if (path.endsWith('/update')) return response(200);
    return response(404);
  };
  assert.equal((await request('/apps/teste/resources', 'POST', { ramMb: 4096, cpuCores: 1 }, { docker: ownedDocker })).status, 400);
  assert.equal(calls.some(call => call.path.endsWith('/update')), false);
  assert.equal((await request('/apps/teste/resources', 'POST', { ramMb: 512, cpuCores: 1 }, { docker: ownedDocker })).status, 200);
  const update = calls.find(call => call.path.endsWith('/update'));
  assert.deepEqual(update.payload, { Memory: 536870912, MemorySwap: 1073741824, NanoCpus: 1000000000 });
});
test('idle policy stops an opted-in app only after its inactivity window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-idle-'));
  const samples = new Map();
  let stops = 0;
  let received = 100;
  const runningDocker = async (path, method) => {
    if (path.startsWith('/containers/json')) return response(200, [{ ...managed, State: 'running' }]);
    if (path.endsWith('/json')) return response(200, { Id: 'abc123', Name: '/softload-app-teste', Config: { Labels: tags }, State: { Status: 'running' } });
    if (path.includes('/stats?')) return response(200, { networks: { eth0: { rx_bytes: received, tx_bytes: 50 } }, cpu_stats: { cpu_usage: { total_usage: 0 } } });
    if (path.includes('/stop?') && method === 'POST') { stops++; return response(204); }
    return response(404);
  };
  try {
    assert.equal((await request('/apps/teste/idle', 'POST', { minutes: 15 }, { docker: runningDocker, dataDir: dir })).status, 200);
    assert.deepEqual(await scanIdleApps(runningDocker, dir, 1000, samples), []);
    assert.equal(stops, 0);
    received = 200;
    assert.deepEqual(await scanIdleApps(runningDocker, dir, 16 * 60_000, samples), []);
    assert.equal(stops, 0);
    assert.deepEqual(await scanIdleApps(runningDocker, dir, 32 * 60_000, samples), ['teste']);
    assert.equal(stops, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
