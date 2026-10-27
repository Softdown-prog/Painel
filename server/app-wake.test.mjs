import test from 'node:test';
import assert from 'node:assert/strict';
import { routeForHost, ensureStarted, wakeOnce } from './app-wake.mjs';

const route = { slug: 'shop', port: 3000 };
const inspect = (running, exitCode = 0, health = 'healthy') => ({
  Id: 'a'.repeat(64), Name: '/softload-app-shop',
  Config: { Labels: { 'com.softload.panel.managed': 'true', 'com.softload.panel.slug': 'shop' } },
  State: { Running: running, ExitCode: exitCode, Health: { Status: health } }
});

test('gateway routes only an exact registered host and bounded target', () => {
  const routes = [{ slug: 'shop', host: 'shop.apps.analysepro.com', port: 3000 }];
  assert.deepEqual(routeForHost('shop.apps.analysepro.com', routes), route);
  assert.equal(routeForHost('other.apps.analysepro.com', routes), null);
  assert.equal(routeForHost('shop.apps.analysepro.com.evil.test', routes), null);
  assert.equal(routeForHost('shop.apps.analysepro.com', [{ ...routes[0], port: 22 }]), null);
  assert.equal(routeForHost('shop.apps.analysepro.com', [{ ...routes[0], slug: '../bad' }]), null);
});

test('first request wakes an intentionally stopped owned app and waits for health', async () => {
  let running = false; const calls = [];
  const request = async (path, method = 'GET') => {
    calls.push([path, method]);
    if (method === 'POST') { running = true; return { status: 204, body: '' }; }
    return { status: 200, body: JSON.stringify(inspect(running)) };
  };
  await ensureStarted(route, request, 1000);
  assert.equal(calls.filter(([, method]) => method === 'POST').length, 1);
  assert.deepEqual(calls[1], ['/containers/' + 'a'.repeat(64) + '/start', 'POST']);
});

test('failed or foreign containers cannot be woken and no deploy is triggered', async () => {
  const calls = [];
  const failed = async (path, method = 'GET') => {
    calls.push([path, method]); return { status: 200, body: JSON.stringify(inspect(false, 1)) };
  };
  await assert.rejects(ensureStarted(route, failed), /failed before wake/);
  assert.equal(calls.length, 1);
  const foreign = async () => ({ status: 200, body: JSON.stringify({
    ...inspect(false), Config: { Labels: { 'com.softload.panel.slug': 'other' } }
  }) });
  await assert.rejects(ensureStarted(route, foreign), /identity mismatch/);
});

test('concurrent requests for one project perform a single start', async () => {
  let running = false; let starts = 0;
  const request = async (_path, method = 'GET') => {
    if (method === 'POST') { starts++; running = true; return { status: 204, body: '' }; }
    return { status: 200, body: JSON.stringify(inspect(running)) };
  };
  await Promise.all([wakeOnce(route, request), wakeOnce(route, request)]);
  assert.equal(starts, 1);
});
