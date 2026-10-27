import test from 'node:test';
import assert from 'node:assert/strict';
import { hostedProjects } from './hosted-projects.ts';

const project = (slug, services) => ({ slug, repository: 'Softdown-prog/' + slug,
  connectedAt: '2026-10-27T00:00:00Z', services });
const app = (slug, state = 'running') => ({ Names: ['/softload-app-' + slug],
  Labels: { 'com.softload.panel.managed': 'true', 'com.softload.panel.slug': slug },
  Image: 'example:' + slug, State: state, Status: state });

test('overview lists independent projects and variable service counts without Softload V4', () => {
  const result = hostedProjects([project('shop', ['web', 'worker']), project('api', ['api'])],
    [app('web'), app('worker', 'exited'), app('api')], []);
  assert.deepEqual(result.map(item => item.id), ['shop', 'api']);
  assert.deepEqual(result.map(item => item.services.length), [2, 1]);
  assert.deepEqual(result.map(item => item.state), ['partial', 'running']);
  assert.equal(result[0].repository, 'Softdown-prog/shop');
});

test('retired service is shown missing, while unrelated and unbound apps stay intact', () => {
  const result = hostedProjects([project('shop', ['web', 'retired']), project('api', ['api'])],
    [app('web'), app('api'), app('other')], []);
  assert.equal(result[0].services[1].state, 'missing');
  assert.equal(result[1].state, 'running');
  assert.equal(result[2].id, 'other');
  assert.equal(result[2].repository, null);
});

test('Softload V4 appears as a hosted legacy project only when installed', () => {
  const legacy = [{ id: 'app', name: 'softload-vps-app-1', state: 'exited', status: 'Exited', image: 'softload-app:old' },
    { id: 'agent', name: 'softload-vps-agent-1', state: 'exited', status: 'Exited', image: 'softload-agent:old' },
    { id: 'caddy', name: 'softload-caddy', state: 'running', status: 'Up', image: 'caddy:2' }];
  const result = hostedProjects([], [], legacy);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'legacy:softload-v4');
  assert.equal(result[0].state, 'stopped');
  assert.deepEqual(result[0].services.map(service => service.id), ['app', 'agent']);
  assert.deepEqual(hostedProjects([], [], legacy.map(service => ({ ...service, state: 'missing' }))), []);
});
