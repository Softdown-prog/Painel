import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {probeApi} from './check-api-connection.mjs';
const key = 'test-only-edge-key-'.repeat(3);
async function server(t, handler) {
  const api = http.createServer(handler);
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => {api.closeAllConnections();return new Promise(resolve => api.close(resolve));});
  return api.address().port;
}
test('readiness requires the actual protected session JSON, not a live TCP socket', async t => {
  const port = await server(t, (req, res) => {
    assert.equal(req.method, 'GET');assert.equal(req.url, '/session');assert.equal(req.headers['x-panel-edge-key'], key);
    res.writeHead(200, {'content-type': 'application/json; charset=utf-8'});res.end(JSON.stringify({authenticated: false, setupRequired: true}));
  });
  assert.deepEqual(await probeApi({port, key}), {ok: true, reason: 'READY'});
});
test('readiness rejects HTML 200, unexpected JSON, malformed data and invalid edge authorization', async t => {
  for (const [status, type, data, reason] of [[200, 'text/html', '<html>site</html>', 'INVALID_RESPONSE'],
    [200, 'application/json', '{}', 'INVALID_RESPONSE'], [200, 'application/json', '{broken', 'INVALID_RESPONSE'],
    [404, 'application/json', '{"error":"Not found"}', 'HTTP_ERROR']]) {
    const port = await server(t, (_req, res) => {res.writeHead(status, {'content-type': type});res.end(data);});
    const result = await probeApi({port, key});assert.equal(result.ok, false);assert.equal(result.reason, reason);
  }
});
test('readiness has a bounded timeout when HTTP hangs on an open socket', async t => {
  const port = await server(t, () => {});assert.deepEqual(await probeApi({port, key, timeout: 15}), {ok: false, reason: 'TIMEOUT'});
});
test('readiness deadline also bounds a response that keeps sending incomplete data', async t => {
  const port = await server(t, (_req, res) => {
    res.writeHead(200, {'content-type': 'application/json'});
    const timer = setInterval(() => res.write(' '), 5);
    res.on('close', () => clearInterval(timer));
  });
  assert.deepEqual(await probeApi({port, key, timeout: 40}), {ok: false, reason: 'TIMEOUT'});
});
test('container command and stdin diagnostic share the probe without exposing secrets', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'panel-readiness-'));t.after(() => rmSync(directory, {recursive: true, force: true}));
  const filename = join(directory, 'edge-key');writeFileSync(filename, key);
  const port = await server(t, (_req, res) => {res.writeHead(200, {'content-type': 'application/json'});res.end('{"authenticated":false,"setupRequired":false}');});
  for (const stdin of [false, true]) {
    const result = await new Promise((resolve, reject) => {
      const args = stdin ? ['--input-type=module', '-', '--check-panel-connection'] : ['server/check-api-connection.mjs', '--check-panel-connection'];
      const child = spawn(process.execPath, args, {env: {...process.env, PORT: String(port), PANEL_EDGE_KEY_FILE: filename}});
      if (stdin) child.stdin.end(readFileSync(new URL('./check-api-connection.mjs', import.meta.url)));
      let output = '';child.stdout.on('data', chunk => {output += chunk;});child.stderr.on('data', chunk => {output += chunk;});child.on('error', reject);child.on('close', code => resolve({code, output}));
    });
    assert.equal(result.code, 0);assert.match(result.output, /PASS: A API respondeu com JSON/);assert.ok(!result.output.includes(key));
  }
});
