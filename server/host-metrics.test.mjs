import test from 'node:test';
import assert from 'node:assert/strict';
import { memorySnapshot } from './host-metrics.ts';

test('RAM: MemAvailable exclui cache recuperável', () => {
  const value = memorySnapshot(8 * 1024 ** 3, 1 * 1024 ** 3, 'MemTotal: 8388608 kB\nMemAvailable: 6291456 kB\n');
  assert.equal(value.used, 2 * 1024 ** 3);
  assert.equal(value.available, 6 * 1024 ** 3);
  assert.equal(value.source, 'memavailable');
});
test('RAM: fallback limitado e identificado para dados inválidos', () => {
  const expected = { total: 1000, used: 800, available: 200, source: 'os-freemem' };
  assert.deepEqual(memorySnapshot(1000, 200, 'MemAvailable: 999999 kB\n'), expected);
  assert.deepEqual(memorySnapshot(1000, 200, ''), expected);
});
