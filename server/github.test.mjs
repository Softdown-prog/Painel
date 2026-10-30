import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validRepository, validRef, validWorkflow, handleGitHubRoute, readRepositories } from './github.ts';

test('repository inputs reject foreign owners, routes and unsafe workflows', () => {
  assert.equal(validRepository('Softdown-prog/Painel'), true);
  assert.equal(validRepository('someone-else/Painel'), false);
  assert.equal(validRepository('Softdown-prog/Painel/../../etc'), false);
  assert.equal(validWorkflow('deploy.yml'), true);
  assert.equal(validWorkflow('../deploy.yml'), false);
  assert.equal(validRef('release/v1.0'), true);
  assert.equal(validRef('release/../main'), false);
});

test('GitHub linking and dispatch use a server-side token and registered workflow only', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'panel-github-'));
  const tokenPath = join(dataDir, 'token');
  writeFileSync(tokenPath, 'test-only-credential', { mode: 0o600 });
  const beforeTokenFile = process.env.PANEL_GITHUB_TOKEN_FILE;
  const beforeFetch = globalThis.fetch;
  process.env.PANEL_GITHUB_TOKEN_FILE = tokenPath;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), method: options.method });
    assert.equal(options.headers.authorization, 'Bearer test-only-credential');
    if (options.method === 'POST') return new Response(null, { status: 204 });
    if (String(url).endsWith('/actions/workflows/deploy.yml'))
      return Response.json({ state: 'active' });
    if (String(url).includes('/runs?'))
      return Response.json({ workflow_runs: [{ id: 7, head_sha: 'a'.repeat(40), head_branch: 'main', status: 'completed', conclusion: 'success', created_at: '2026-01-01T00:00:00Z', html_url: 'https://github.com/Softdown-prog/Demo/actions/runs/7' }] });
    return Response.json({});
  };
  const invoke = async (url, method = 'GET', input = {}) => {
    let reply;
    const handled = await handleGitHubRoute({ url, method }, {}, {
      dataDir,
      body: async () => input,
      send: (_res, status, data) => { reply = { status, data }; }
    });
    assert.equal(handled, true);
    assert.ok(reply);
    return reply;
  };
  try {
    const first = await invoke('/repositories');
    assert.equal(first.status, 200);
    assert.deepEqual(first.data.repositories, []);
    assert.equal(first.data.tokenConfigured, true);

    const forbidden = await invoke('/repositories', 'POST', { fullName: 'outside/Demo', branch: 'main', workflow: 'deploy.yml' });
    assert.equal(forbidden.status, 400);
    assert.equal(requests.length, 0);

    const connected = await invoke('/repositories', 'POST', { fullName: 'Softdown-prog/Demo', branch: 'main', workflow: 'deploy.yml' });
    assert.equal(connected.status, 201);
    assert.equal((await invoke('/repositories')).data.repositories.length, 1);
    assert.equal((await invoke('/repositories', 'POST', { fullName: 'Softdown-prog/Demo' })).status, 409);

    const dispatch = await invoke('/repositories/Softdown-prog/Demo/deploy', 'POST');
    assert.equal(dispatch.status, 202);
    assert.ok(requests.some(req => req.url.endsWith('/actions/workflows/deploy.yml/dispatches') && req.method === 'POST'));

    const runs = await invoke('/repositories/Softdown-prog/Demo/runs');
    assert.equal(runs.status, 200);
    assert.equal(runs.data.runs[0].id, 7);

    assert.equal((await invoke('/repositories/Softdown-prog/Demo', 'DELETE')).status, 200);
    assert.equal((await invoke('/repositories/Softdown-prog/Demo/deploy', 'POST')).status, 404);
  } finally {
    globalThis.fetch = beforeFetch;
    if (beforeTokenFile === undefined) delete process.env.PANEL_GITHUB_TOKEN_FILE;
    else process.env.PANEL_GITHUB_TOKEN_FILE = beforeTokenFile;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
test('only explicit compatibility supplies an initial legacy repository; saved projects always survive', t => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-repository-profile-'));t.after(() => rmSync(dir, {recursive: true, force: true}));
  assert.deepEqual(readRepositories(dir, false), []);
  assert.equal(readRepositories(dir, true)[0].fullName, 'Softdown-prog/Softloadv4');
  const saved = [{fullName: 'Softdown-prog/OutroProjeto', branch: 'main', workflow: 'build.yml'}];
  writeFileSync(join(dir, 'github-repositories.json'), JSON.stringify(saved));
  assert.deepEqual(readRepositories(dir, true), saved);assert.deepEqual(readRepositories(dir, false), saved);
});
