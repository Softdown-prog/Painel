import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleProjectRoute } from './projects.ts';

const repo = { fullName: 'Softdown-prog/example', branch: 'main', workflow: 'panel-app-build.yml' };
const docker = async (path) => {
  if (path === '/containers/softload-app-demo/json') return {
    status: 200, buffer: Buffer.from(JSON.stringify({
      Id: 'owned', Name: '/softload-app-demo',
      Config: { Labels: { 'com.softload.panel.managed': 'true', 'com.softload.panel.slug': 'demo' } },
      State: { Status: 'running' }
    }))
  };
  if (path === '/containers/softload-app-foreign/json') return {
    status: 200, buffer: Buffer.from(JSON.stringify({
      Id: 'foreign', Name: '/softload-vps-app-1', Config: { Labels: {} }
    }))
  };
  return { status: 404, buffer: Buffer.alloc(0) };
};
test('projects only bind owned containers to registered GitHub repositories; build is opt-in', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'panel-projects-'));
  const sent = [];
  const githubCalls = [];
  const request = async (url, method = 'GET', input = {}, options = {}) => {
    let response;
    const recognized = await handleProjectRoute({ url, method }, {}, {
      dataDir, body: async () => input, docker, repositories: () => [repo],
      githubRequest: async (...args) => {
        githubCalls.push(args);
        if (args[0].includes('/runs?')) return { workflow_runs: [{
          id: 9, head_sha: 'c'.repeat(40), status: 'completed', conclusion: 'success',
          head_branch: 'main', created_at: '2026-10-25T00:00:00Z',
          html_url: 'https://github.com/Softdown-prog/example/actions/runs/9'
        }] };
        return null;
      },
      buildsEnabled: false,
      send: (_res, status, data) => { response = { status, data }; },
      ...options
    });
    assert.equal(recognized, true);
    assert.ok(response);
    sent.push(response);
    return response;
  };
  try {
    assert.equal((await request('/projects')).data.projects.length, 0);
    assert.equal((await request('/projects', 'POST', { slug: 'foreign', repository: repo.fullName })).status, 403);
    assert.equal((await request('/projects', 'POST', { slug: 'demo', repository: 'foreign/bad' })).status, 404);
    assert.equal((await request('/projects', 'POST', { slug: '../bad', repository: repo.fullName })).status, 400);
    assert.equal((await request('/projects', 'POST', { slug: 'demo', repository: repo.fullName })).status, 201);
    assert.equal((await request('/projects', 'POST', { slug: 'demo', repository: repo.fullName })).status, 409);
    assert.equal((await request('/projects')).data.projects[0].workflow, 'panel-app-build.yml');
    assert.equal((await request('/projects/demo/build', 'POST')).status, 403);
    assert.equal(githubCalls.length, 0);
    const runs = await request('/projects/demo/runs');
    assert.equal(runs.status, 200);
    assert.equal(runs.data.runs[0].id, 9);
    assert.equal((await request('/projects/demo/build', 'POST', {}, { buildsEnabled: true })).status, 202);
    assert.equal(githubCalls[1][0], '/repos/Softdown-prog/example/actions/workflows/panel-app-build.yml/dispatches');
    assert.equal(githubCalls[1][1], 'POST');
    assert.deepEqual(githubCalls[1][2], { ref: 'main' });
    assert.equal((await request('/projects/demo', 'DELETE')).status, 200);
    assert.equal((await request('/projects')).data.projects.length, 0);
    assert.equal((await request('/projects/demo/build', 'POST', {}, { buildsEnabled: true })).status, 404);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
test('project build rejects unrelated workflows even when builds enabled', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'panel-projects-'));
  const other = { ...repo, workflow: 'deploy.yml' };
  const invoke = async (url, method, input = {}) => {
    let result;
    await handleProjectRoute({ url, method }, {}, {
      dataDir, body: async () => input, docker, buildsEnabled: true,
      repositories: () => [other], githubRequest: async () => { throw new Error('must not dispatch'); },
      send: (_res, status, data) => { result = { status, data }; }
    });
    return result;
  };
  try {
    assert.equal((await invoke('/projects', 'POST', { slug: 'demo', repository: other.fullName })).status, 201);
    assert.equal((await invoke('/projects/demo/build', 'POST')).status, 409);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
