import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleProjectRoute, readProjects } from './projects.ts';

const repositories = [
  { fullName: 'Softdown-prog/alpha', branch: 'main', workflow: 'panel-app-build.yml' },
  { fullName: 'Softdown-prog/beta', branch: 'main', workflow: 'panel-app-build.yml' }
];

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'panel-registry-'));
  const inspected = [];
  const docker = async path => {
    inspected.push(path);
    const slug = /^\/containers\/softload-app-([a-z0-9-]+)\/json$/.exec(path)?.[1];
    if (!slug || !['alpha', 'beta', 'worker', 'web'].includes(slug))
      return { status: 404, buffer: Buffer.alloc(0) };
    return { status: 200, buffer: Buffer.from(JSON.stringify({
      Id: 'id-' + slug, Name: '/softload-app-' + slug,
      Config: { Labels: { 'com.softload.panel.managed': 'true', 'com.softload.panel.slug': slug } },
      State: { Status: 'running' }
    })) };
  };
  const request = async (url, method = 'GET', input = {}) => {
    let response;
    const handled = await handleProjectRoute({ url, method }, {}, {
      dataDir, docker, repositories: () => repositories, buildsEnabled: true,
      body: async () => input,
      githubRequest: async () => null,
      send: (_res, status, data) => { response = { status, data }; }
    });
    assert.equal(handled, true);
    return response;
  };
  return { dataDir, inspected, request, close: () => rmSync(dataDir, { recursive: true, force: true }) };
}

test('independent projects own variable service sets without Softload V4', async () => {
  const f = fixture();
  try {
    assert.equal((await f.request('/projects', 'POST', {
      slug: 'alpha', repository: repositories[0].fullName, services: ['web', 'worker']
    })).status, 201);
    assert.equal((await f.request('/projects', 'POST', {
      slug: 'beta', repository: repositories[1].fullName, services: ['beta']
    })).status, 201);
    const listed = (await f.request('/projects')).data.projects;
    assert.deepEqual(listed.map(project => project.services), [['web', 'worker'], ['beta']]);
    assert.equal((await f.request('/projects/beta/services', 'PUT', { services: ['worker'] })).status, 409);
    assert.deepEqual(readProjects(f.dataDir)[1].services, ['beta']);
    assert.equal((await f.request('/projects/alpha/build', 'POST')).status, 409);
    assert.equal((await f.request('/projects/beta/build', 'POST')).status, 202);
  } finally { f.close(); }
});

test('removing a retired service does not inspect its absent image or touch another project', async () => {
  const f = fixture();
  try {
    await f.request('/projects', 'POST', { slug: 'alpha', repository: repositories[0].fullName, services: ['web', 'worker'] });
    await f.request('/projects', 'POST', { slug: 'beta', repository: repositories[1].fullName, services: ['beta'] });
    f.inspected.length = 0;
    const result = await f.request('/projects/alpha/services', 'PUT', { services: ['web'] });
    assert.equal(result.status, 200);
    assert.deepEqual(f.inspected, []);
    assert.deepEqual(readProjects(f.dataDir).map(project => project.services), [['web'], ['beta']]);
  } finally { f.close(); }
});

test('legacy project bindings load without modifying existing data', () => {
  const f = fixture();
  try {
    const legacy = [{ slug: 'alpha', repository: repositories[0].fullName, connectedAt: '2026-01-01T00:00:00Z' }];
    writeFileSync(join(f.dataDir, 'projects.json'), JSON.stringify(legacy));
    assert.deepEqual(readProjects(f.dataDir)[0].services, ['alpha']);
    assert.deepEqual(JSON.parse(readFileSync(join(f.dataDir, 'projects.json'), 'utf8')), legacy);
  } finally { f.close(); }
});
