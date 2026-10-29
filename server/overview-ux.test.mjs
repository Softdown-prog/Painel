import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const file = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('dashboard does not display made-up values and offers manual refresh', () => {
  const html = file('index.html');
  const script = file('script.js');
  for (const id of ['overviewHealth', 'overviewRefresh', 'overviewAlerts']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  for (const id of ['serviceCount', 'memoryValue', 'cpuValue', 'diskValue']) {
    assert.match(html, new RegExp('id="' + id + '">—<'));
  }
  assert.doesNotMatch(html, /▁▂▂▁▃▂/);
  assert.match(html, /Não é porcentagem de uso/);
  assert.match(script, /memory.source === 'memavailable'/);
  assert.match(script, /Última leitura:/);
  assert.match(script, /Dados anteriores/);
  assert.match(script, /Falha ao consultar/);
  assert.match(script, /document.hidden/);
  assert.match(script, /Sem serviços cadastrados no inventário/);
  assert.doesNotMatch(script, /fillServices\(demoServices\)/);
});

test('inventory displays every Docker container separately from legacy Softload and never creates management controls', () => {
  const html = file('index.html');
  const script = file('script.js');
  assert.match(html, /data-view="containers"/);
  for (const id of ['overviewHostContainers', 'allHostContainers', 'hostContainersRefresh',
    'hostContainersNotice', 'overviewHostCount']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(script, /api\('\/containers'\)/);
  assert.match(script, /Somente consulta/);
  assert.match(script, /function clearHostContainers/);
  assert.match(script, /if \(view.id === 'containers'/);
  assert.doesNotMatch(script, /\/containers\/[^'"]*(start|stop|restart|delete)/);
});
