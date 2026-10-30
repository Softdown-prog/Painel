import test from 'node:test';
import assert from 'node:assert/strict';
import {proxyPanelRequest} from '../functions/api/[[path]].ts';
const env = {PANEL_EDGE_KEY: ' e'.trim() + 'a'.repeat(40) + '\n', CF_ACCESS_CLIENT_ID: 'test-access-id', CF_ACCESS_CLIENT_SECRET: 'test-private-access-secret'};
const request = (path = '/session', options = {}) => new Request('https://panel.test/api' + path, options);
const context = (req = request(), bindings = env) => ({request: req, env: bindings});
test('proxy keeps the fixed private origin, path, query, cookie and private credentials', async () => {
  const result = await proxyPanelRequest(context(request('/services/app/logs?tail=10', {headers: {cookie: 'panel_session=fake', authorization: 'do-not-forward'}})), async (url, options) => {
    assert.equal(url.origin, 'https://panel-api.analysepro.com'); assert.equal(url.pathname, '/services/app/logs');
    assert.equal(url.search, '?tail=10'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.get('x-panel-edge-key'), env.PANEL_EDGE_KEY.trim());
    assert.equal(options.headers.get('cf-access-client-secret'), env.CF_ACCESS_CLIENT_SECRET);
    assert.equal(options.headers.get('cookie'), 'panel_session=fake'); assert.equal(options.headers.get('authorization'), null);
    return Response.json({lines: 'log real'});
  });
  assert.deepEqual(await result.json(), {lines: 'log real'}); assert.equal(result.headers.get('cache-control'), 'no-store');
});
test('only a validated server binding can configure another installation origin', async () => {
  const result = await proxyPanelRequest(context(request('/session', {headers: {'x-api-origin': 'https://untrusted.invalid'}}),
    {...env, PANEL_API_ORIGIN: 'https://api.other-example.com/'}), async url => {
    assert.equal(url.origin, 'https://api.other-example.com');assert.equal(url.pathname, '/session');
    return Response.json({authenticated: false, setupRequired: false});
  });
  assert.equal(result.status, 200);
  let calls = 0;
  for(const origin of ['http://api.example.com','https://user:password@api.example.com','https://api.example.com/path',
    'https://api.example.com/?token=secret','https://localhost','https://127.0.0.1','https://api.example.com:8080']) {
    const failure = await proxyPanelRequest(context(request(), {...env, PANEL_API_ORIGIN: origin}), () => {calls++;throw Error('Must not send credentials');});
    assert.equal(failure.status, 503);assert.equal((await failure.json()).code, 'EDGE_NOT_CONFIGURED');
  }
  assert.equal(calls, 0);
});
test('same-origin POST preserves its body without redirecting or replaying the operation', async () => {
  let calls = 0;
  const result = await proxyPanelRequest(context(request('/terminal/ssh/exec', {method: 'POST', headers: {origin: 'https://panel.test', 'content-type': 'application/json'}, body: '{"command":"uptime"}'})), async (_url, options) => {
    calls++; assert.equal(options.method, 'POST'); assert.equal(await new Response(options.body).text(), '{"command":"uptime"}');
    throw Error('Private network failed with a sensitive URL');
  });
  assert.equal(calls, 1); assert.equal(result.status, 502); assert.equal((await result.json()).code, 'UPSTREAM_UNAVAILABLE');
});
test('missing configuration, foreign origin, methods and URL-like paths never contact upstream', async () => {
  const noFetch = () => { throw Error('Upstream must not be called'); };
  for (const [input, status] of [[context(request(), {}), 503], [context(request('/login', {method: 'POST', body: '{}'})), 403],
    [context(request('/login', {method: 'PUT'})), 405], [context(request('//foreign.invalid/path')), 400]]) {
    assert.equal((await proxyPanelRequest(input, noFetch)).status, status);
  }
});
for (const status of [301, 302, 307, 308]) test('Cloudflare Access redirect ' + status + ' becomes JSON without cookies, location or secrets', async () => {
  const result = await proxyPanelRequest(context(), async () => new Response('<html>private challenge</html>', {status, headers: {location: 'https://login.invalid/secret', 'set-cookie': 'CF_Authorization=sensitive'}}));
  const text = await result.text(); assert.equal(result.status, 502); assert.match(text, /UPSTREAM_ACCESS/);
  assert.doesNotMatch(text, /private challenge|sensitive|login.invalid|test-private-access-secret/);
  assert.equal(result.headers.get('location'), null); assert.equal(result.headers.get('set-cookie'), null);
});
for (const status of [502, 503, 530]) test('HTML/text gateway failure ' + status + ' is translated to a safe actionable API error', async () => {
  const result = await proxyPanelRequest(context(), async () => new Response('<html>provider details</html>', {status}));
  assert.equal(result.status, 502); const data = await result.json(); assert.equal(data.code, 'UPSTREAM_UNAVAILABLE'); assert.equal(data.upstreamStatus, status);
  assert.match(data.error, /API.*túnel/); assert.doesNotMatch(JSON.stringify(data), /provider details/);
});
test('Cloudflare problem JSON and Access JSON are not confused with application responses', async () => {
  for (const response of [Response.json({cloudflare_error: true, status: 502, detail: 'private provider detail'}, {status: 502}),
    Response.json({message: 'Forbidden', status_code: 403, aud: 'private-audience'}, {status: 403})]) {
    const result = await proxyPanelRequest(context(), async () => response);assert.equal(result.status, 502);
    assert.doesNotMatch(await result.text(), /aud|private provider|private-audience/);
  }
});
test('legitimate API authentication and permission errors keep their status and message', async () => {
  for (const status of [400, 401, 403, 404, 409, 429]) {
    const result = await proxyPanelRequest(context(), async () => Response.json({error: 'Mensagem da aplicação'}, {status}));
    assert.equal(result.status, status);assert.equal((await result.json()).error, 'Mensagem da aplicação');
  }
});
test('login and logout cookies preserve their secure attributes on the panel origin', async () => {
  for (const value of ['token', '']) {
    const cookie = 'panel_session=' + value + '; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
    const result = await proxyPanelRequest(context(), async () => Response.json({ok: true}, {headers: {'set-cookie': cookie}}));
    assert.equal(result.headers.get('set-cookie'), cookie);
  }
});
test('HTML 200 and malformed JSON cannot masquerade as a connected API', async () => {
  for (const response of [new Response('<html>site, not API</html>', {status: 200}), new Response('{broken', {headers: {'content-type': 'application/json'}})]) {
    const result = await proxyPanelRequest(context(), async () => response); assert.equal(result.status, 502);assert.equal((await result.json()).code, 'UPSTREAM_INVALID_RESPONSE');
  }
});
test('network timeout and a stalled JSON body become 504 with no retry', async () => {
  let calls = 0;
  const stalled = (_url, options) => {calls++; return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted'))));};
  const result = await proxyPanelRequest(context(), stalled, 5);assert.equal(result.status, 504);assert.equal(calls, 1);
  const body = await proxyPanelRequest(context(), async (_url, options) => ({status: 200, ok: true, headers: new Headers({'content-type': 'application/json'}), json: () => stalled(_url, options)}), 5);
  assert.equal(body.status, 504);assert.equal((await body.json()).code, 'UPSTREAM_TIMEOUT');
});
