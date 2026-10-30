import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runPanelUi} from './ui-fixture.mjs';
const source = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function mount(respond) {
  const elements = new Map(), requests = [];
  function node(id) {
    if (!elements.has(id)) elements.set(id, {id, textContent: '', value: '', hidden: id === 'authOverlay', disabled: false, dataset: {title: id}, children: [], lastChild: {textContent: ''}, handlers: {}, style: {},
      classList: {toggle() {}, remove() {}, add() {}}, addEventListener(event, fn) {this.handlers[event] = fn;},
      append(...items) {this.children.push(...items);}, replaceChildren(...items) {this.children = items;},
      setAttribute() {}, focus() {}, querySelectorAll: () => [], querySelector: () => null});
    return elements.get(id);
  }
  const document = {hidden: false, getElementById: node, createElement: tag => node('created-' + tag + '-' + elements.size), querySelectorAll: () => [], querySelector: node};
  const scope = runPanelUi(source, {document, window: {addEventListener() {}}, location: {hash: '#settings'},
    setInterval() {}, clearInterval() {}, fetch: async (url, options) => {requests.push({url, options});return respond(url, options);}});
  return {elements, requests, node, scope};
}
test('gateway errors show the real connection failure, not login/setup or a fake connected state', async () => {
  const ui = mount(() => new Response('<html>Bad gateway</html>', {status: 502}));await tick();
  assert.match(ui.node('apiStatus').textContent, /indisponível/);assert.match(ui.node('apiConnectionMessage').textContent, /HTTP 502/);
  assert.equal(ui.node('authOverlay').hidden, true);assert.equal(ui.node('apiRetryButton').disabled, false);
});
test('Testar conexão recovers after an outage and queries only session before requesting login', async () => {
  let online = false;
  const ui = mount(() => online ? Response.json({authenticated: false, setupRequired: false}) : new Response('Bad gateway', {status: 502}));await tick();
  online = true;ui.node('apiRetryButton').handlers.click();await tick();
  assert.equal(ui.node('apiStatus').textContent, '● API conectada');assert.equal(ui.node('authOverlay').hidden, false);
  assert.equal(ui.node('authHeading').textContent, 'Entrar no painel');assert.deepEqual(ui.requests.map(r => r.url), ['/api/session', '/api/session']);
});
test('multiple reconnect clicks share one probe and never repeat administrative writes', async () => {
  let release;const ui = mount(() => new Promise(resolve => {release = resolve;}));
  ui.node('apiRetryButton').handlers.click();ui.node('authRetryConnection').handlers.click();assert.equal(ui.requests.length, 1);
  release(Response.json({authenticated: false, setupRequired: true}));await tick();
  assert.equal(ui.node('authHeading').textContent, 'Criar acesso administrativo');assert.equal(ui.node('authRetryConnection').disabled, false);
});
test('successful HTTP with an unrelated JSON body does not claim an API connection', async () => {
  const ui = mount(() => Response.json({message: 'proxy page'}));await tick();
  assert.match(ui.node('apiStatus').textContent, /indisponível/);assert.match(ui.node('apiConnectionMessage').textContent, /não confirmou/);
  assert.equal(ui.node('authOverlay').hidden, true);
});
