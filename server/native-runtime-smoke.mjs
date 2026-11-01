import assert from 'node:assert/strict';
import { createNativeRuntime } from './native-runtime.mjs';

const runtime = createNativeRuntime({ mode: 'prefer' });
assert.equal((await runtime.probe()).engine, 'rust');
assert.deepEqual(await runtime.memory(8192, 1024, 'MemAvailable: 6 kB\n'),
  { total: 8192, used: 2048, available: 6144, source: 'memavailable' });
const route = { slug: 'isolated-app', port: 3000 };
assert.deepEqual(await runtime.route('isolated.example.test',
  [{ ...route, host: 'isolated.example.test' }], () => route), route);
assert.equal(runtime.status().successes, 3);
assert.equal(runtime.status().fallbacks, 0);
console.log(JSON.stringify({ ok: true, runtime: runtime.status() }));
