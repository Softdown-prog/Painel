import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeRuntime, executeNative } from './native-runtime.mjs';
import { memorySnapshot } from './host-metrics.ts';
import { routeForHost, createWakeServer } from './app-wake.mjs';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const routes = [
  { host: 'alpha.example.test', slug: 'alpha', port: 3000 },
  { host: 'beta.example.test', slug: 'beta', port: 4000 }
];
const measured = { total: 8192, used: 2048, available: 6144, source: 'memavailable' };

test('native RAM and routing use fixed operations and preserve the existing contracts', async () => {
  const operations = [];
  const runtime = createNativeRuntime({ mode: 'prefer', execute: async (binary, operation, input) => {
    assert.equal(binary, '/usr/local/bin/panel-runtime');
    operations.push(operation);
    if (operation === 'memory') { assert.match(input, /^8192\n1024\n/); return measured; }
    assert.match(input, /^beta.example.test\n/);
    return { slug: 'beta', port: 4000 };
  }});
  assert.deepEqual(await runtime.memory(8192, 1024, 'MemAvailable: 6 kB\n'), measured);
  assert.deepEqual(await runtime.route('BETA.EXAMPLE.TEST:443', routes, routeForHost), { slug: 'beta', port: 4000 });
  assert.deepEqual(operations, ['memory', 'route']);
  assert.equal(runtime.status().engine, 'rust');
});

test('disabled, missing, invalid or incompatible native worker preserves Node metrics and routes', async () => {
  for (const execute of [async () => { throw Error('SECRET must not escape'); },
    async () => ({ ...measured, available: -1 }), async () => ({ engine: 'rust', protocol: 999 })]) {
    const runtime = createNativeRuntime({ mode: 'prefer', execute });
    assert.deepEqual(await runtime.memory(8192, 1024, 'MemAvailable: 6 kB\n'), measured);
    assert.deepEqual(await runtime.route('alpha.example.test', routes, routeForHost), { slug: 'alpha', port: 3000 });
    assert.equal(runtime.status().engine, 'node');
    assert.doesNotMatch(JSON.stringify(runtime.status()), /SECRET/);
  }
  const disabled = createNativeRuntime({ mode: 'off', execute: () => { throw Error('must not spawn'); } });
  assert.deepEqual(await disabled.memory(1000, 200), memorySnapshot(1000, 200));
  assert.equal((await disabled.probe()).configured, false);
});

test('native route cannot cross projects or revive a removed/invalid registered target', async () => {
  let calls = 0;
  const runtime = createNativeRuntime({ mode: 'prefer', execute: async () => {
    calls++; return { slug: 'beta', port: 4000 };
  }});
  assert.deepEqual(await runtime.route('alpha.example.test', routes, routeForHost), { slug: 'alpha', port: 3000 });
  for (const host of ['unknown.example.test', 'alpha.example.test.evil', 'alpha.example.test\nInjected'])
    assert.equal(await runtime.route(host, routes, routeForHost), null);
  assert.equal(await runtime.route('alpha.example.test', [routes[1]], routeForHost), null);
  assert.equal(await runtime.route('alpha.example.test', [{...routes[0],port:22}], routeForHost), null);
  assert.equal(calls, 1);
});

test('route cache changes with the full table and has a bounded lifetime', async () => {
  let time = 0;
  let calls = 0;
  const runtime = createNativeRuntime({ mode: 'prefer', now: () => time, execute: async (_bin, _op, input) => {
    calls++; return { slug: 'alpha', port: input.includes('\t3001') ? 3001 : 3000 };
  }});
  await runtime.route('alpha.example.test', routes, routeForHost);
  await runtime.route('alpha.example.test', routes, routeForHost);
  assert.equal(calls, 1);
  assert.equal((await runtime.route('alpha.example.test', [{...routes[0],port:3001}], routeForHost)).port, 3001);
  assert.equal(calls, 2);
  time = 5001;
  await runtime.route('alpha.example.test', routes, routeForHost);
  assert.equal(calls, 3);
});

test('failure circuit and concurrency cap prevent process storms without blocking the API', async () => {
  let time = 0; let calls = 0;
  const failed = createNativeRuntime({ mode:'prefer', now:()=>time, execute:async()=>{calls++;throw Error('down');} });
  for(let i=0;i<10;i++) await failed.memory(1000,200);
  assert.equal(calls,1);
  time=30001; await failed.memory(1000,200); assert.equal(calls,2);
  const pending=[];
  const limited=createNativeRuntime({mode:'prefer',execute:()=>new Promise(resolve=>pending.push(resolve))});
  const first=limited.memory(8192,1024,'MemAvailable: 6 kB\n');
  const second=limited.memory(8192,1024,'MemAvailable: 6 kB\n');
  assert.deepEqual(await limited.memory(8192,1024,'MemAvailable: 6 kB\n'),measured);
  assert.equal(pending.length,2);
  for(const finish of pending) finish(measured);
  await Promise.all([first,second]);
});

test('oversized inputs and arbitrary operations never launch a native process', async () => {
  await assert.rejects(executeNative('/not-run', 'shell', 'id'), /rejected/);
  await assert.rejects(executeNative('/not-run', 'memory', 'a'.repeat(65537)), /rejected/);
});

test('async routing remains compatible with HTTP requests and a failed native component', async t => {
  const runtime = createNativeRuntime({mode:'prefer',execute:async()=>{throw Error('missing');}});
  const upstream=http.createServer((_req,res)=>res.end('isolated project response'));
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const table=[{...routes[0],port:upstream.address().port}];
  let selected;
  const gateway=createWakeServer({getRoute:host=>runtime.route(host,table,routeForHost),
    wake:async route=>{selected=route;},upstreamHost:()=> '127.0.0.1'});
  await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    gateway.closeAllConnections();upstream.closeAllConnections();
    await Promise.all([new Promise(resolve=>gateway.close(resolve)),new Promise(resolve=>upstream.close(resolve))]);
  });
  const request=host=>new Promise((resolve,reject)=>{
    http.get({hostname:'127.0.0.1',port:gateway.address().port,headers:{host}},response=>{
      let body='';response.on('data',chunk=>{body+=chunk;});
      response.on('end',()=>resolve({status:response.statusCode,body}));
    }).on('error',reject);
  });
  const response=await request('alpha.example.test');
  assert.equal(response.status,200);
  assert.equal(response.body,'isolated project response');
  assert.deepEqual(selected,{slug:'alpha',port:upstream.address().port});
  const unknown=await request('absent.example.test');
  assert.equal(unknown.status,404);
});

// These exercise real child-process termination on Linux CI, not a mocked timer.
test('native transport enforces timeout, output limit and secret-free environment',
  {skip:process.platform==='win32'},async t=>{
    const dir=mkdtempSync(join(tmpdir(),'panel-native-'));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const fixture=join(dir,'worker');
    const install=source=>{writeFileSync(fixture,`#!${process.execPath}\n${source}`);chmodSync(fixture,0o700);};
    install('setInterval(()=>{},1000);');
    await assert.rejects(executeNative(fixture,'memory','',50),/timeout/);
    install('process.stdout.write("x".repeat(9000));');
    await assert.rejects(executeNative(fixture,'memory',''),/output limit/);
    install('process.stdout.write("not json");');
    await assert.rejects(executeNative(fixture,'memory',''),/invalid response/);
    process.env.PANEL_NATIVE_TEST_SECRET='do-not-inherit';
    t.after(()=>delete process.env.PANEL_NATIVE_TEST_SECRET);
    install('console.log(JSON.stringify({leaked:process.env.PANEL_NATIVE_TEST_SECRET||null}));');
    assert.deepEqual(await executeNative(fixture,'memory',''),{leaked:null});
  });

test('real compiled Rust binary agrees with Node across memory and project routing cases',
  {skip:!process.env.PANEL_TEST_NATIVE_BINARY},async()=>{
    const runtime=createNativeRuntime({mode:'prefer',binary:process.env.PANEL_TEST_NATIVE_BINARY});
    assert.equal((await runtime.probe()).engine,'rust');
    for(const meminfo of ['', 'MemAvailable: 6 kB\n','MemAvailable: 0 kB\n',
      'MemAvailable: 999999999999999 kB\n','MemAvailable: 100 MB\n'])
      assert.deepEqual(await runtime.memory(8192,1024,meminfo),memorySnapshot(8192,1024,meminfo));
    for(const route of routes)
      assert.deepEqual(await runtime.route(route.host,routes,routeForHost),routeForHost(route.host,routes));
    assert.equal(runtime.status().fallbacks,0);
  });
