import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import net from 'node:net';

async function launch(dir, legacy = '0') {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(join(dir, 'network-trap.mjs')).href,
    new URL('./api.mjs', import.meta.url).pathname], {
    env: {...process.env, PORT: String(port), PANEL_DATA_DIR: dir, PANEL_SOFTLOAD_LEGACY: legacy,
      PANEL_EDGE_KEY_FILE: join(dir, 'edge-key'), SOFTLOAD_ENV_FILE: join(dir, 'nonexistent-project.env'),
      PANEL_DOCKER_SOCKET_PATH: join(dir, 'missing-executor.sock'), PANEL_PUBLICATIONS_ENABLED: '0',
      PANEL_REVISIONS_AUTOMATIC: '0', PANEL_APPS_ENABLED: '0', PANEL_RELEASE_SHA: 'a'.repeat(40)}, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';child.stdout.on('data', part => {output += part;});child.stderr.on('data', part => {output += part;});
  const call = async (path, method = 'GET', input, cookie = '') => {
    const response = await fetch('http://127.0.0.1:' + port + path, {method,
      headers: {'x-panel-edge-key': 'a'.repeat(64), 'content-type': 'application/json', cookie},
      ...(input === undefined ? {} : {body: JSON.stringify(input)})});
    return {status: response.status, headers: response.headers, data: await response.json()};
  };
  const close = async () => {if (child.exitCode !== null) return;child.kill();await new Promise(resolve => child.once('exit', resolve));};
  for (let i = 0; i < 100; i++) {
    try {await call('/session');return {call, close, output: () => output};}
    catch {if (child.exitCode !== null) break;await new Promise(resolve => setTimeout(resolve, 20));}
  }
  await close();throw new Error('API did not start: ' + output);
}
test('generic API boots, authenticates and preserves projects without Softload files, containers, executor or project network', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'generic-panel-'));t.after(() => rmSync(dir, {recursive: true, force: true}));
  writeFileSync(join(dir, 'edge-key'), 'a'.repeat(64));
  writeFileSync(join(dir, 'network-trap.mjs'), "globalThis.fetch = async () => { console.log('UNEXPECTED_PROJECT_NETWORK'); throw Error('No project network'); };\n");
  const password = 'Test only account password 2026';
  let api = await launch(dir);
  try {
    assert.deepEqual((await api.call('/session')).data, {authenticated: false, setupRequired: true, legacySoftload: false, revision: 'a'.repeat(40)});
    assert.equal((await api.call('/publications')).status, 401);
    assert.equal((await api.call('/database/status')).status, 401, 'O status administrativo exige sessão');
    const setupToken = readFileSync(join(dir, 'setup-token'), 'utf8').trim();
    assert.equal((await api.call('/setup', 'POST', {setupToken, password})).status, 201);
    const login = await api.call('/login', 'POST', {username: 'admin', password});
    assert.equal(login.status, 200);assert.equal(login.data.legacySoftload, false);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.deepEqual((await api.call('/services', 'GET', undefined, cookie)).data.services, []);
    const database = await api.call('/database/status', 'GET', undefined, cookie);
    assert.equal(database.status, 200);
    assert.equal(database.data.integration, 'not_configured');
    assert.equal(database.data.enabled, false);
    assert.equal(database.data.instance, null);
    assert.equal(database.data.databases, null);
    assert.equal((await api.call('/database/status','POST',{},cookie)).status, 405);
    assert.equal((await api.call('/database/create','POST',{name:'unsafe'},cookie)).status, 503);
    assert.equal((await api.call('/database/query','GET',undefined,cookie)).status, 503);
    assert.deepEqual((await api.call('/repositories', 'GET', undefined, cookie)).data.repositories, []);
    assert.equal((await api.call('/services/app/restart', 'POST', {}, cookie)).status, 404);
    const overview = await api.call('/overview', 'GET', undefined, cookie);
    assert.equal(overview.status, 200);assert.equal(overview.data.containerSummary.available, false);
    assert.ok(overview.data.memory.total > 0);assert.equal(overview.data.currentSha, null);
    assert.equal(overview.data.imagesBytes, null, 'Unavailable Docker accounting is not reported as zero bytes');
    const history = [{id: 'one', slug: 'loja', repository: 'Softdown-prog/Loja', revision: null, runId: 1,
      phase: 'attention', createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z',
      deadlineAt: '2026-10-30T00:20:00Z', detail: 'Conferir container', retryCount: 0}];
    writeFileSync(join(dir, 'publication-jobs.json'), JSON.stringify(history));
    const repositories = [{fullName: 'Softdown-prog/Loja', branch: 'main', workflow: 'panel-app-build.yml'}];
    writeFileSync(join(dir, 'github-repositories.json'), JSON.stringify(repositories));
    assert.deepEqual((await api.call('/publications', 'GET', undefined, cookie)).data.history, history);
    assert.equal((await api.call('/publications', 'POST', {}, cookie)).status, 405);
    const deployments = await api.call('/deploys', 'GET', undefined, cookie);
    assert.equal(deployments.data.scope, 'projects');assert.deepEqual(deployments.data.history, history);
    assert.equal(deployments.data.runtime, null);assert.equal(deployments.data.publicHealth, null);
    assert.doesNotMatch(api.output(), /UNEXPECTED_PROJECT_NETWORK/);
    const admin = readFileSync(join(dir, 'admin.json'), 'utf8');
    await api.close();api = await launch(dir, '1');
    const session = (await api.call('/session', 'GET', undefined, cookie)).data;
    assert.equal(session.setupRequired, false);assert.equal(session.authenticated, false);assert.equal(session.legacySoftload, true);
    assert.equal(readFileSync(join(dir, 'admin.json'), 'utf8'), admin);
    const next = await api.call('/login', 'POST', {username: 'admin', password});
    assert.equal(next.status, 200);assert.equal(next.data.legacySoftload, true);
    const nextCookie = next.headers.get('set-cookie').split(';')[0];
    assert.equal((await api.call('/overview', 'GET', undefined, nextCookie)).status, 200,
      'Optional legacy monitoring cannot block host metrics when Docker is unavailable');
    assert.deepEqual((await api.call('/repositories', 'GET', undefined, nextCookie)).data.repositories, repositories);
    assert.deepEqual((await api.call('/publications', 'GET', undefined, nextCookie)).data.history, history);
  } finally {await api.close();}
});
