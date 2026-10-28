import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendResourceSample, readResourceHistory, sampleResourceHistory } from './resource-history.ts';

const point = (at, ram = 35, disk = 46) => ({ at: new Date(at).toISOString(), memoryPercent: ram, diskPercent: disk });
test('histórico limita o período a 24 horas e não duplica coletas próximas', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  const old = point('2026-10-27T11:00:00Z');
  const current = point('2026-10-28T11:55:00Z');
  const next = point(now.toISOString(), 41, 50);
  assert.deepEqual(appendResourceSample([old, current], next, now), [current, next]);
  assert.deepEqual(appendResourceSample([current], point('2026-10-28T11:59:00Z'), now), [current]);
});
test('histórico não inventa percentuais ausentes ou inválidos', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  assert.deepEqual(appendResourceSample([], point(now, null, null), now), []);
  assert.deepEqual(appendResourceSample([], point(now, 130, 10), now), []);
  assert.deepEqual(appendResourceSample([], point(now, 10, 20), now).length, 1);
  assert.deepEqual(appendResourceSample([], point('2026-10-28T12:10:00Z'), now), []);
});
test('histórico persistido permite leitura, evita gravação repetida e preserva arquivo inválido', () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-history-'));
  const now = new Date('2026-10-28T12:00:00Z');
  try {
    assert.equal(sampleResourceHistory(dir, point(now, 42, 55), now), true);
    assert.equal(sampleResourceHistory(dir, point(now, 42, 55), now), false);
    const result = readResourceHistory(dir, now);
    assert.equal(result.available, true);
    assert.deepEqual(result.samples, [point(now, 42, 55)]);
    writeFileSync(join(dir, 'resource-history.json'), '{broken', { mode: 0o600 });
    assert.equal(readResourceHistory(dir, now).available, false);
    assert.throws(() => sampleResourceHistory(dir, point(now), now));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('histórico tem limite estrito de 288 amostras e ignora arquivos futuros', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  const samples = Array.from({ length: 289 }, (_, i) => point(new Date(now.getTime() - (289-i)*300000)));
  const result = appendResourceSample(samples, point(now), now);
  assert.equal(result.length, 288);
  assert.equal(result.at(-1).at, now.toISOString());
});
