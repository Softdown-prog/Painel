import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const code = readFileSync(new URL('../publication-history-ui.js', import.meta.url), 'utf8');
function mount() {
  const elements = new Map();
  const node = () => ({textContent: '', children: [], className: '', firstElementChild: null,
    append(...items) {this.children.push(...items);}, replaceChildren(...items) {this.children = items;}});
  const get = id => {if (!elements.has(id)) elements.set(id, node());return elements.get(id);};
  const window = {};runInNewContext(code, {window, document: {getElementById: get, createElement: node, querySelector: get}});
  return {get, render: window.renderProjectPublicationHistory};
}
test('publication history displays independent projects without claiming their sites are healthy', () => {
  const ui = mount();ui.render([
    {slug: 'loja', repository: 'Softdown-prog/Loja', revision: 'a'.repeat(40), phase: 'completed', detail: 'Etapas concluídas', createdAt: '2026-10-30T00:00:00Z'},
    {slug: 'jogo', repository: 'Softdown-prog/Jogo', revision: null, phase: 'attention', detail: 'Conferir imagem', createdAt: '2026-10-30T01:00:00Z'}
  ]);
  const rows = ui.get('deployTable').children;assert.equal(rows.length, 2);
  assert.equal(rows[0].children[0].children[0].href, '#site?slug=loja');
  assert.equal(rows[1].children[0].children[0].textContent, 'jogo');
  assert.equal(rows[0].children[2].children[0].textContent, 'ETAPAS CONCLUÍDAS');
  assert.match(ui.get('deployRuntimeDetails').textContent, /conferir.*acesso ao site/);
  assert.equal(ui.get('activityTag').textContent, 'PROJETOS');
});
test('empty history, unsafe project names and connection failure clear old rows honestly', () => {
  const ui = mount();ui.render([{slug: '../other'}]);
  assert.match(ui.get('activityList').textContent, /Ainda não há publicações/);
  ui.render([], 'API indisponível');assert.equal(ui.get('deployTag').textContent, 'INDISPONÍVEL');
  assert.equal(ui.get('activityList').textContent, 'API indisponível');
});
