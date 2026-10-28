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
});
