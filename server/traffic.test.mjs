import test from 'node:test';
import assert from 'node:assert/strict';
import { addCounters, parseProcNetDev, summarizeTraffic } from './traffic.ts';
const store = () => ({ version:1, interface:'eth0', days:[], settings:{allowanceBytes:1000,resetDay:1} });
test('parses only the selected external interface',()=>{
  const data='  lo: 1 0 0 0 0 0 0 0 2 0 0 0 0 0 0 0\neth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\ndocker0: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0';
  assert.deepEqual(parseProcNetDev(data,'eth0'),{rx:100,tx:200}); assert.equal(parseProcNetDev(data,'ens3'),null);
});
test('calculates the configured billing cycle and warning thresholds',()=>{
  const s=store(); s.settings={allowanceBytes:1000,resetDay:10};s.days=[{date:'2026-09-10',rx:900,tx:50},{date:'2026-10-09',rx:999,tx:999},{date:'2026-10-10',rx:500,tx:250}];
  const summary=summarizeTraffic(s,new Date('2026-10-20T00:00:00Z'));
  assert.equal(summary.total,750);assert.equal(summary.alert,'warning');assert.equal(summary.periodStart,'2026-10-10');
  assert.equal(parseProcNetDev('bad data','eth0'),null);
});
test('records deltas, groups the day and treats counter reset as unknown zero',()=>{
  const s=store(); addCounters(s,{rx:100,tx:50},new Date('2026-10-01T00:00:00Z')); addCounters(s,{rx:160,tx:90},new Date('2026-10-01T00:05:00Z')); addCounters(s,{rx:3,tx:4},new Date('2026-10-01T00:10:00Z'));
  assert.deepEqual(s.days,[{date:'2026-10-01',rx:60,tx:40}]);
});
