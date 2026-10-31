/**
 * Frontend HTTP entrypoint on the VPS. No Docker access, no session state,
 * no public port and no Cloudflare credentials. Only /api/* reaches the API.
 * The edge key is read from an existing host secret and never sent to browsers.
 */
import { createServer, request as upstreamRequest } from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
});
const MAX_BODY = 9 * 1024 * 1024;

function json(res, status, error, code = 'PANEL_WEB_ERROR') {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify({ error, code }));
}

function validPath(raw) {
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\\#\u0000-\u001f]/.test(raw) ||
      /%(?:2f|5c|00)/i.test(raw)) return null;
  const pathname = raw.split('?')[0];
  try {
    const decoded = decodeURIComponent(pathname);
    if (decoded.includes('\\') || decoded.split('/').includes('..') ||
        decoded.split('/').includes('.') || decoded.includes('//')) return null;
    return { pathname: decoded, suffix: raw.slice(pathname.length) };
  } catch { return null; }
}

function setResponseHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-frame-options', 'DENY');
}

export function createPanelWebServer({
  edgeKey, staticDir, publicOrigin, apiHost = 'softload-panel-api',
  apiPort = 8080, revision = 'development'
}) {
  if (typeof edgeKey !== 'string' || edgeKey.trim().length < 32)
    throw new Error('Panel edge secret must contain at least 32 characters');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(apiHost) ||
      !Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535)
    throw new Error('Invalid internal API target');
  if (typeof staticDir !== 'string' || !staticDir.startsWith('/'))
    throw new Error('Static directory must be absolute');
  const origin = new URL(publicOrigin);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username ||
      origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('Invalid public origin');

  function forward(req, res, pathname, suffix) {
    if (!['GET', 'POST', 'DELETE'].includes(req.method))
      return json(res, 405, 'Método não permitido', 'METHOD_NOT_ALLOWED');
    if (req.method !== 'GET' && req.headers.origin !== origin.origin)
      return json(res, 403, 'Origem inválida. Abra o endereço oficial do painel.', 'INVALID_ORIGIN');
    const contentLength = Number(req.headers['content-length'] || 0);
    if (!Number.isFinite(contentLength) || contentLength > MAX_BODY)
      return json(res, 413, 'Requisição acima do limite de segurança.', 'PAYLOAD_TOO_LARGE');
    const headers = { 'x-panel-edge-key': edgeKey.trim(), accept: 'application/json' };
    for (const name of ['cookie', 'content-type']) {
      if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
    }
    // Never forward browser-controlled x-panel-edge-key, CF-* or X-Forwarded-*.
    const upstream = upstreamRequest({
      hostname: apiHost, port: apiPort, method: req.method,
      path: pathname.slice('/api'.length) + suffix,
      headers, timeout: req.method === 'GET' ? 50_000 : 115_000
    }, response => {
      const out = {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      };
      if (typeof response.headers['content-type'] === 'string' &&
          /^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(response.headers['content-type']))
        out['content-type'] = response.headers['content-type'];
      const cookies = response.headers['set-cookie'];
      if (Array.isArray(cookies)) {
        const sessionCookies = cookies.filter(value => /^panel_session=/.test(value));
        if (sessionCookies.length) out['set-cookie'] = sessionCookies;
      }
      res.writeHead(response.statusCode || 502, out);
      response.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('API timeout')));
    upstream.on('error', () => {
      if (!res.headersSent && !res.destroyed)
        json(res, 502, 'Não foi possível alcançar a API da VPS.', 'API_UNAVAILABLE');
      else res.destroy();
    });
    req.on('aborted', () => upstream.destroy());
    if (req.method === 'GET') upstream.end();
    else {
      let bytes = 0;
      req.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BODY) {
          if (!res.headersSent) json(res, 413, 'Requisição acima do limite de segurança.', 'PAYLOAD_TOO_LARGE');
          upstream.destroy(new Error('Request body exceeded limit'));
          req.unpipe(upstream);
        }
      });
      req.pipe(upstream);
    }
  }

  return createServer((req, res) => {
    setResponseHeaders(res);
    const raw = req.url || '';
    const parsed = validPath(raw);
    if (!parsed) return json(res, 400, 'Caminho inválido', 'INVALID_PATH');
    const { pathname, suffix } = parsed;
    if (pathname === '/__panel_web_health') {
      if (req.method !== 'GET') return json(res, 405, 'Método não permitido', 'METHOD_NOT_ALLOWED');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, revision }));
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      if (pathname === '/api' || pathname.startsWith('/api//'))
        return json(res, 400, 'Caminho da API inválido', 'INVALID_PATH');
      return forward(req, res, pathname, suffix);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return json(res, 405, 'Método não permitido', 'METHOD_NOT_ALLOWED');
    // Angular coexists under /angular/ while all legacy screens remain intact.
    // Do not provide SPA fallback for arbitrary paths or private files.
    if (pathname === '/angular') {
      res.writeHead(308, { location: '/angular/', 'cache-control': 'no-store' });
      return res.end();
    }
    let filename;
    if (pathname === '/angular/') filename = 'angular/index.html';
    else if (pathname.startsWith('/angular/')) {
      const asset = pathname.slice('/angular/'.length);
      if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(?:js|css)$/.test(asset))
        return json(res, 404, 'Arquivo não encontrado', 'NOT_FOUND');
      filename = 'angular/' + asset;
    } else {
      filename = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (!/^(?:index\.html|[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.(?:js|css))$/.test(filename))
        return json(res, 404, 'Arquivo não encontrado', 'NOT_FOUND');
    }
    let size;
    try {
      const stat = statSync(join(staticDir, filename));
      if (!stat.isFile()) throw new Error('not a file');
      size = stat.size;
    } catch { return json(res, 404, 'Arquivo não encontrado', 'NOT_FOUND'); }
    const ext = filename.slice(filename.lastIndexOf('.'));
    res.writeHead(200, {
      'content-type': MIME[ext],
      'content-length': size,
      'cache-control': 'no-cache, max-age=0, must-revalidate'
    });
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(join(staticDir, filename));
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = readFileSync(process.env.PANEL_EDGE_KEY_FILE || '/run/secrets/panel-edge-key', 'utf8').trim();
  const server = createPanelWebServer({
    edgeKey: secret,
    staticDir: process.env.PANEL_STATIC_DIR || '/app/public',
    publicOrigin: process.env.PANEL_PUBLIC_ORIGIN || 'https://panel.analysepro.com',
    apiHost: 'softload-panel-api',
    apiPort: 8080,
    revision: process.env.PANEL_WEB_REVISION || 'development'
  });
  // Read the root-owned secret once, then discard root privileges permanently.
  if (process.getuid?.() === 0) { process.setgid('node'); process.setuid('node'); }
  server.listen(Number(process.env.PORT || 8081), '0.0.0.0');
}
