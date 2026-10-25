import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleReleaseRoute } from './releases.ts';
const repo = 'Softdown-prog/sample';
const sha = 'a'.repeat(40);
const tag = 'ghcr.io/softdown-prog/sample:sha-' + sha;
const role = 'com.softload.panel.release-role';
const revision = 'com.softload.panel.revision';
const repository = 'com.softload.panel.repository';
const owner = 'com.softload.panel.managed';
const slug = 'com.softload.panel.slug';
const labels = { [owner]: 'true', [slug]: 'demo' };
function fakeDocker() {
  const images = new Map();
  const calls = [];
  images.set('softload-app-demo', { Id: 'old', Name: '/softload-app-demo',
    Config: { Image: 'test-old:1', Labels: { ...labels } }, State: { Status: 'running' } });
  const fn = async (path, method = 'GET', payload) => {
    calls.push({ path, method, payload });
    const key = decodeURIComponent(path.split('/')[2] || '').split('?')[0];
    const found = images.get(key) || [...images.values()].find(c => c.Id === key);
    const response = (status, data = {}) => ({ status, buffer: Buffer.from(JSON.stringify(data)) });
    if (path.startsWith('/images/')) return response(200, { Id: 'sha256:' + 'b'.repeat(64),
      RepoTags: [tag], Config: { Labels: {
        'org.opencontainers.image.source': 'https://github.com/' + repo,
        'org.opencontainers.image.revision': sha
      }, Healthcheck: { Test: ['CMD', '/healthcheck'] } } });
    if (path.startsWith('/containers/create?')) {
      const name = decodeURIComponent(path.split('name=')[1]);
      if (images.has(name)) return response(409);
      images.set(name, { Id: 'id-' + name, Name: '/' + name, Config: { Image: payload.Image, Labels: payload.Labels },
        State: { Status: 'created', Health: { Status: 'starting' } } });
      return response(201);
    }
    if (path.startsWith('/containers/') && path.endsWith('/json'))
      return found ? response(200, found) : response(404);
    if (!found) return response(404);
    if (path.endsWith('/start')) { found.State.Status = 'running'; return response(204); }
    if (path.includes('/stop?')) { found.State.Status = 'exited'; return response(204); }
    if (path.includes('/rename?')) {
      const name = decodeURIComponent(path.split('name=')[1]);
      if (images.has(name)) return response(409);
      images.delete(found.Name.slice(1));
      found.Name = '/' + name;
      images.set(name, found);
      return response(204);
    }
    if (method === 'DELETE') {
      if (found.State.Status === 'running') return response(409);
      images.delete(found.Name.slice(1)); return response(204);
    }
    return response(404);
  };
  return { fn, images, calls };
}
test('staging requires approved run, immutable local image and healthy promotion; rollback restores old container', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-releases-'));
  writeFileSync(join(dir, 'projects.json'), JSON.stringify([{ slug: 'demo', repository: repo,
    connectedAt: '2026-10-25T00:00:00Z' }]));
  const docker = fakeDocker();
  let githubApproved = true;
  const githubRequest = async (path) => {
    assert.equal(path, '/repos/' + repo + '/actions/runs/987');
    return { head_sha: sha, status: 'completed', conclusion: githubApproved ? 'success' : 'failure',
      head_branch: 'main', repository: { full_name: repo }, head_repository: { full_name: repo },
      path: '.github/workflows/panel-app-build.yml', event: 'workflow_dispatch' };
  };
  const request = async (path, method = 'GET', data = {}, enable = true) => {
    let response;
    assert.equal(await handleReleaseRoute({ url: path, method }, {}, {
      dataDir: dir, docker: docker.fn, enabled: enable, githubRequest,
      repositories: () => [{ fullName: repo, workflow: 'panel-app-build.yml', branch: 'main' }],
      body: async () => data, send: (_res, status, value) => { response = { status, data: value }; }
    }), true);
    return response;
  };
  try {
    assert.equal((await request('/projects/demo/releases')).data.enabled, true);
    assert.equal((await request('/projects/demo/releases/stage', 'POST', { runId: 987 }, false)).status, 403);
    githubApproved = false;
    assert.equal((await request('/projects/demo/releases/stage', 'POST', { runId: 987 })).status, 422);
    assert.equal(docker.images.size, 1);
    githubApproved = true;
    const stage = await request('/projects/demo/releases/stage', 'POST', { runId: 987 });
    assert.equal(stage.status, 200);
    assert.equal(docker.images.get('softload-candidate-demo').Config.Image, 'sha256:' + 'b'.repeat(64));
    assert.equal(docker.images.get('softload-candidate-demo').Config.Labels[revision], sha);
    const createCall = docker.calls.find(c => c.path.startsWith('/containers/create?'));
    assert.equal(createCall.payload.HostConfig.ReadonlyRootfs, true);
    assert.equal(createCall.payload.HostConfig.PublishAllPorts, false);
    assert.equal((await request('/projects/demo/releases/promote', 'POST')).status, 409);
    docker.images.get('softload-candidate-demo').State.Health.Status = 'healthy';
    assert.equal((await request('/projects/demo/releases/promote', 'POST')).status, 200);
    assert.equal(docker.images.get('softload-app-demo').Config.Labels[role], 'candidate');
    assert.equal(docker.images.get('softload-backup-demo').State.Status, 'exited');
    const blocked = await request('/projects/demo/releases/stage', 'POST', { runId: 987 });
    assert.equal(blocked.status, 409, JSON.stringify(blocked));
    assert.equal((await request('/projects/demo/releases/rollback', 'POST')).status, 200);
    assert.equal(docker.images.get('softload-app-demo').Id, 'old');
    assert.equal(docker.images.get('softload-app-demo').State.Status, 'running');
    assert.equal(docker.images.get('softload-candidate-demo').State.Status, 'exited');
    assert.equal((await request('/projects/demo/releases/finalize', 'POST', { confirm: 'DELETE_BACKUP' })).status, 200);
    assert.equal(docker.images.has('softload-candidate-demo'), false);
    assert.equal(docker.images.has('softload-backup-demo'), false);
    assert.equal(docker.images.get('softload-app-demo').Id, 'old');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('release endpoints fail closed for unknown project', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-releases-'));
  try {
    let result;
    await handleReleaseRoute({ url: '/projects/unknown/releases/stage', method: 'POST' }, {}, {
      dataDir: dir, enabled: true, docker: async () => { throw new Error('must not access Docker'); },
      body: async () => ({}), send: (_res, status, data) => { result = { status, data }; }
    });
    assert.equal(result.status, 404);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
