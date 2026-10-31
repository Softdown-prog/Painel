import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../revision-activity-ui.js', import.meta.url), 'utf8');
const SHA = 'a'.repeat(40);
function harness(overrides = {}) {
  const nodes = new Map();
  const node = (tag = 'div') => ({
    tag, textContent: '', className: '', children: [], attributes: {},
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener() {}
  });
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  };
  const calls = [];
  const payloads = {
    '/repositories': { repositories: [{ fullName: 'Softdown-prog/Loja', branch: 'main', workflow: 'deploy.yml' }] },
    '/projects': { projects: [{ slug: 'loja', repository: 'Softdown-prog/Loja' }] },
    '/publications': { history: [] },
    '/repositories/Softdown-prog/Loja/runs': { runs: [{
      id: 42, sha: SHA, branch: 'main', status: 'completed',
      conclusion: 'success', createdAt: '2026-10-30T20:00:00Z'
    }] },
    '/projects/loja/releases': { current: { state: 'running', revision: SHA } },
    ...overrides
  };
  const window = {
    panelApi: { async request(path) {
      calls.push(path);
      if (payloads[path] instanceof Error) throw payloads[path];
      return payloads[path];
    } },
    setTimeout() { return 1; }, clearTimeout() {}
  };
  const document = { hidden: false, getElementById: get, createElement: node, addEventListener() {} };
  const location = { hash: '#revisions' };
  runInNewContext(source, { window, document, location });
  return { get, calls, window, document, location, refresh: window.refreshRevisionActivity };
}
test('green VPS badge only when running Docker revision equals the GitHub SHA', async () => {
  const ui = harness();
  await ui.refresh();
  const card = ui.get('revisionActivity').children[0];
  const stages = card.children[1].children;
  assert.match(stages[0].className, /revision-ci-success/);
  assert.match(stages[2].className, /revision-ci-success/);
  assert.equal(stages[2].children[1].textContent, 'Ativa na VPS');
  assert.match(stages[4].className, /revision-ci-neutral/);
  assert.match(ui.get('revisionActivitySummary').textContent, /1 revisão/);
  assert.equal(ui.calls.includes('/projects/loja/releases'), true);
});
test('GitHub green never marks VPS active without matching release evidence', async () => {
  const ui = harness({
    '/projects/loja/releases': { current: { state: 'running', revision: 'b'.repeat(40) } }
  });
  await ui.refresh();
  const stages = ui.get('revisionActivity').children[0].children[1].children;
  assert.match(stages[0].className, /revision-ci-success/);
  assert.match(stages[2].className, /revision-ci-warning/);
  assert.equal(stages[2].children[1].textContent, 'Outra revisão ativa');
  assert.match(ui.get('revisionActivitySummary').textContent, /0 revisão/);
});
test('CI in progress and VPS publication in progress show animated running indicators', async () => {
  const ui = harness({
    '/repositories/Softdown-prog/Loja/runs': { runs: [{
      id: 42, sha: SHA, status: 'in_progress', conclusion: null, createdAt: '2026-10-30T20:00:00Z'
    }] },
    '/publications': { history: [{ repository: 'Softdown-prog/Loja', slug: 'loja', runId: 42, phase: 'health' }] },
    '/projects/loja/releases': { current: { state: 'running', revision: 'b'.repeat(40) } }
  });
  await ui.refresh();
  const stages = ui.get('revisionActivity').children[0].children[1].children;
  assert.match(stages[0].className, /revision-ci-running/);
  assert.match(stages[2].className, /revision-ci-running/);
  assert.equal(stages[2].children[1].textContent, 'Testando container');
});
test('failed actions and unavailable releases are not presented as successful deployments', async () => {
  const ui = harness({
    '/repositories/Softdown-prog/Loja/runs': { runs: [{
      id: 42, sha: SHA, status: 'completed', conclusion: 'failure', createdAt: '2026-10-30T20:00:00Z'
    }] },
    '/projects/loja/releases': new Error('VPS inacessível')
  });
  await ui.refresh();
  const stages = ui.get('revisionActivity').children[0].children[1].children;
  assert.match(stages[0].className, /revision-ci-failed/);
  assert.match(stages[2].className, /revision-ci-neutral/);
  assert.equal(stages[2].children[1].textContent, 'VPS não verificada');
  assert.match(ui.get('revisionActivitySummary').textContent, /0 revisão/);
});
test('invisible tab performs no polling or API requests', async () => {
  const ui = harness();
  ui.document.hidden = true;
  await ui.refresh();
  assert.equal(ui.calls.length, 0);
  ui.document.hidden = false;
  ui.location.hash = '#overview';
  await ui.refresh();
  assert.equal(ui.calls.length, 0);
});
