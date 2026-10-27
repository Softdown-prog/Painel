import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';

const ROUTES = process.env.PANEL_ROUTES_FILE || '/config/panel/domain-routes.json';
const SOCKET = process.env.PANEL_EXECUTOR_SOCKET || '/run/panel-executor/docker.sock';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map();

export function routeForHost(hostHeader, routes) {
  const host = typeof hostHeader === 'string' ? hostHeader.toLowerCase().replace(/:\d+$/, '') : '';
  if (!/^[a-z0-9.-]{4,253}$/.test(host) || !Array.isArray(routes)) return null;
  const route = routes.find(item => item?.host === host);
  if (!route || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(route.slug) || route.slug.length > 40 ||
      !Number.isSafeInteger(route.port) || route.port < 1024 || route.port > 65535) return null;
  return { slug: route.slug, port: route.port };
}

export function executorRequest(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: SOCKET, path: '/v1.45' + path,
      method, timeout: 15000 }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) request.destroy(new Error('Executor response too large'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('Executor timeout')));
    request.end();
  });
}

async function inspect(route, request) {
  const name = 'softload-app-' + route.slug;
  const response = await request('/containers/' + name + '/json');
  if (response.status !== 200) throw new Error('Application container unavailable');
  const container = JSON.parse(response.body);
  const labels = container.Config?.Labels;
  if (container.Name !== '/' + name || labels?.['com.softload.panel.managed'] !== 'true' ||
      labels['com.softload.panel.slug'] !== route.slug || !/^[a-f0-9]{64}$/.test(container.Id || ''))
    throw new Error('Application identity mismatch');
  return container;
}

export async function ensureStarted(route, request = executorRequest, maxMs = 90000) {
  const initial = await inspect(route, request);
  if (!initial.State?.Running) {
    // A container that crashed requires operator attention. Only intentional
    // stops (exit code 0) may be woken by public traffic.
    if (initial.State?.ExitCode && initial.State.ExitCode !== 0)
      throw new Error('Application failed before wake');
    const started = await request('/containers/' + initial.Id + '/start', 'POST');
    if (![204, 304].includes(started.status)) throw new Error('Application start rejected');
  }
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const container = await inspect(route, request);
    if (container.State?.Running &&
        (!container.State.Health || container.State.Health.Status === 'healthy')) return container;
    if (container.State?.Health?.Status === 'unhealthy' || container.State?.Dead)
      throw new Error('Application health check failed');
    await sleep(1000);
  }
  throw new Error('Application startup timed out');
}

export function wakeOnce(route, request = executorRequest) {
  const previous = pending.get(route.slug);
  if (previous) return previous;
  const task = ensureStarted(route, request).finally(() => {
    if (pending.get(route.slug) === task) pending.delete(route.slug);
  });
  pending.set(route.slug, task);
  return task;
}

function readRoute(host) {
  const routes = JSON.parse(readFileSync(ROUTES, 'utf8'));
  return routeForHost(host, routes);
}

export function createWakeServer({ getRoute = readRoute, wake = wakeOnce,
  upstreamHost = slug => 'softload-app-' + slug } = {}) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/__wake_health') {
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return;
    }
    let route;
    try { route = getRoute(req.headers.host); }
    catch { res.writeHead(503); res.end('Routes unavailable'); return; }
    if (!route) { res.writeHead(404); res.end('Application not found'); return; }
    try {
      await wake(route);
      const upstream = http.request({ host: upstreamHost(route.slug), port: route.port,
        path: req.url, method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on('error', error => {
        console.error('Upstream:', error.message);
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    } catch (error) {
      console.error('Wake:', error.message);
      if (!res.headersSent) res.writeHead(503, { 'retry-after': '10' });
      res.end('Application unavailable');
    }
  });
  server.on('upgrade', async (req, socket, head) => {
    let route;
    try { route = getRoute(req.headers.host); }
    catch { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    if (!route) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    try {
      await wake(route);
      const upstream = net.connect(route.port, upstreamHost(route.slug));
      upstream.on('connect', () => {
        upstream.write(req.method + ' ' + req.url + ' HTTP/1.1\r\n' +
          req.rawHeaders.reduce((lines, value, index) => lines +
            (index % 2 ? value + '\r\n' : value + ': '), '') + '\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    } catch {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    }
  });
  return server;
}

if (process.argv[1]?.endsWith('/app-wake.mjs')) {
  createWakeServer().listen(Number(process.env.PORT || 8082), '0.0.0.0', () =>
    console.log('Panel application wake gateway listening'));
}
