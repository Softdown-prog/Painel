import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runPanelUi} from './ui-fixture.mjs';
function client(fetch) { return runPanelUi('', {window: {}, fetch}).window.panelApi; }
test('all requests stay same-origin, use JSON and preserve body and session credentials', async () => {
  const api = client(async (url, options) => {
    assert.equal(url, '/api/login');assert.equal(options.credentials, 'same-origin');assert.equal(options.redirect, 'error');
    assert.equal(options.headers.get('accept'), 'application/json');assert.equal(options.headers.get('content-type'), 'application/json');assert.equal(options.body, '{}');
    return Response.json({ok: true});
  });
  assert.equal((await api.request('/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}', credentials: 'include'})).ok, true);
});
test('HTML, plaintext, Cloudflare JSON and malformed JSON errors retain actionable HTTP context', async () => {
  for (const response of [new Response('Bad Gateway', {status: 502}), new Response('<html>cloudflare</html>', {status: 502}), Response.json({cloudflare_error: true, title: 'Bad gateway'}, {status: 502}), new Response('{bad', {status: 502})]) {
    await assert.rejects(client(async () => response).request('/session'), error => error.status === 502 && /API.*VPS/.test(error.message) && !/[<>]/.test(error.message));
  }
});
test('JSON permissions and expired sessions keep their status, while success HTML/null never become empty data', async () => {
  await assert.rejects(client(async () => Response.json({error: 'Sessão necessária'}, {status: 401})).request('/apps'), error => error.status === 401 && /Sessão/.test(error.message));
  for (const response of [new Response('<html>fallback</html>'), Response.json(null), Response.json('ok'), Response.json([])])
    await assert.rejects(client(async () => response).request('/session'), error => error.code === 'INVALID_RESPONSE');
});
test('network failure and uncertain writes are never repeated automatically', async () => {
  let calls = 0;const api = client(async () => {calls++;throw new TypeError('secret URL');});
  await assert.rejects(api.request('/terminal/ssh/exec', {method: 'POST', body: '{}'}), /resultado da operação não foi confirmado/);
  assert.equal(calls, 1);
  let successfulCalls = 0;const invalid = client(async () => {successfulCalls++;return new Response('<html>not API</html>');});
  await assert.rejects(invalid.request('/apps/demo/start', {method: 'POST'}), /antes de repetir/);assert.equal(successfulCalls, 1);
});
test('cancelled requests stop and disallowed paths never reach fetch', async () => {
  let calls = 0;const api = client(async (_url, options) => {calls++;if (options.signal.aborted) throw Error('aborted');return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted'))));});
  for (const path of ['//foreign.test', '/../login', '/test#fragment', '/\\foreign.test']) await assert.rejects(api.request(path), error => error.code === 'INVALID_PATH');
  assert.equal(calls, 0);const controller = new AbortController(), pending = api.request('/session', {signal: controller.signal});controller.abort();
  await assert.rejects(pending, error => error.code === 'REQUEST_ABORTED');assert.equal(calls, 1);
});
test('every panel loads the shared transport before scripts that use it', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');assert.ok(html.indexOf('src="api-client.js"') < html.indexOf('src="script.js"'));
  for (const file of ['script.js','terminal-ui.ts','github-ui.ts','apps-ui.ts','projects-ui.ts','hosted-projects-ui.ts','domains-ui.ts','revisions-ui.ts','site-detail-ui.ts','secrets-ui.ts','traffic-ui.ts']) {
    const text = readFileSync(new URL('../' + file, import.meta.url), 'utf8');assert.match(text, /window\.panelApi\.request/);assert.doesNotMatch(text, /await fetch\(/, file);
  }
});
