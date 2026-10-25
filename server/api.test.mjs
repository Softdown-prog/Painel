import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('setup, login, session and logout require the edge key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'softload-panel-test-'));
  const key = 'a'.repeat(64);
  const keyPath = join(dir, 'edge-key');
  writeFileSync(keyPath, key);
  const port = await freePort();
  const child = spawn(process.execPath, ['--experimental-strip-types', join(import.meta.dirname, 'api.mjs')], {
    env: { ...process.env, PORT: String(port), PANEL_DATA_DIR: dir, PANEL_EDGE_KEY_FILE: keyPath },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const request = async (path, method = 'GET', data, edge = key, cookie = '') => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'x-panel-edge-key': edge, 'content-type': 'application/json', cookie },
      body: data ? JSON.stringify(data) : undefined
    });
    return { response, data: await response.json() };
  };
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await request('/session'); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.equal((await request('/session', 'GET', undefined, 'wrong')).response.status, 404);
    assert.equal((await request('/session')).data.setupRequired, true);
    assert.equal((await request('/setup', 'POST', { setupToken: 'wrong', password: 'A long password!123' })).response.status, 403);
    const setupToken = readFileSync(join(dir, 'setup-token'), 'utf8').trim();
    assert.equal((await request('/setup', 'POST', { setupToken, password: 'A long password!123' })).response.status, 201);
    assert.equal((await request('/setup', 'POST', { setupToken, password: 'another long password' })).response.status, 409);
    assert.equal((await request('/login', 'POST', { username: 'admin', password: 'wrong' })).response.status, 401);
    const login = await request('/login', 'POST', { username: 'admin', password: 'A long password!123' });
    assert.equal(login.response.status, 200);
    const cookie = login.response.headers.get('set-cookie').split(';')[0];
    assert.match(login.response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
    assert.equal((await request('/session', 'GET', undefined, key, cookie)).data.authenticated, true);
    assert.equal((await request('/services')).response.status, 401);
    assert.equal((await request('/password', 'POST', { currentPassword: 'wrong', newPassword: 'Even longer password 456' }, key, cookie)).response.status, 403);
    assert.equal((await request('/password', 'POST', { currentPassword: 'A long password!123', newPassword: 'Even longer password 456' }, key, cookie)).response.status, 200);
    assert.equal((await request('/session', 'GET', undefined, key, cookie)).data.authenticated, false);
    assert.equal((await request('/login', 'POST', { username: 'admin', password: 'A long password!123' })).response.status, 401);
    const nextLogin = await request('/login', 'POST', { username: 'admin', password: 'Even longer password 456' });
    const nextCookie = nextLogin.response.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/logout', 'POST', undefined, key, nextCookie)).response.status, 200);
    assert.equal((await request('/session', 'GET', undefined, key, nextCookie)).data.authenticated, false);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
