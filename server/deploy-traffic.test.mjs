import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimate, observeDeployRuns } from './deploy-traffic.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'panel-deploy-traffic-'));
const run = (status, conclusion = null) => ({ id: 71, sha: 'a'.repeat(40), status, conclusion, createdAt: '2026-10-26T12:00:00Z' });
test('records the RX and TX delta bounded by a deploy observed in progress', () => {
  const folder = dir();
  observeDeployRuns(folder, [run('in_progress')], { rx: 100, tx: 50 }, new Date('2026-10-26T12:01:00Z'));
  const result = observeDeployRuns(folder, [run('completed', 'success')], { rx: 360, tx: 90 }, new Date('2026-10-26T12:06:00Z')).get(71);
  assert.deepEqual(result, { available: true, rx: 260, tx: 40, total: 300, startedAt: '2026-10-26T12:01:00.000Z', finishedAt: '2026-10-26T12:06:00.000Z' });
});
test('does not invent traffic for a deploy that ended before the collector observed it', () => {
  const result = observeDeployRuns(dir(), [run('completed', 'success')], { rx: 100, tx: 50 }).get(71);
  assert.equal(result.available, false); assert.match(result.reason, /terminou antes/i);
});
test('treats a network counter reset as unavailable rather than a negative measurement', () => {
  const result = estimate({ id: 1, sha: null, createdAt: null, observedAt: '', status: 'completed', conclusion: 'success', start: { rx: 100, tx: 100, at: 'a' }, end: { rx: 1, tx: 1, at: 'b' } });
  assert.equal(result.available, false); assert.match(result.reason, /reiniciado/i);
});
