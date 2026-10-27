import http from 'node:http';
import { handleGitHubRoute } from './github.ts';
import { handleAppRoute, startIdleMonitor } from './apps.ts';
import { handleProjectRoute } from './projects.ts';
import { handleReleaseRoute } from './releases.ts';
import { handleImageImportRoute } from './image-import.ts';
import { handleDomainRoute } from './domains.ts';
import { executeSshCommand, handleSshTerminalRoute } from './terminal-ssh.ts';
import { handleRevisionRoute, startRevisionMonitor } from './revision-maintenance.ts';
import { handlePublicationRoute, startPublicationWorker } from './publications.ts';
import { handleSecretsRoute } from './secrets.ts';
import { externalCounters, handleTrafficRoute, startTrafficMonitor } from './traffic.ts';
import { observeDeployRuns, startDeployTrafficMonitor } from './deploy-traffic.ts';
import { inspectDeployedServices, runDeploymentStatus } from './deploy-verification.mjs';
import { legacySoftloadEntries } from './legacy-softload-profile.ts';
import { cachedPublicHealth } from './deploy-public-health.mjs';
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync, statfsSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { totalmem, freemem, loadavg, cpus } from 'node:os';
import { join } from 'node:path';

const port = Number(process.env.PORT || 8080);
const dataDir = process.env.PANEL_DATA_DIR || '/data';
const edgeKey = readFileSync(process.env.PANEL_EDGE_KEY_FILE || '/run/secrets/panel-edge-key', 'utf8').trim();
if (edgeKey.length < 32) throw new Error('Edge key must have at least 32 characters');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const adminFile = join(dataDir, 'admin.json');
const setupFile = join(dataDir, 'setup-token');
if (!existsSync(adminFile) && !existsSync(setupFile)) writeFileSync(setupFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });

const sessions = new Map();
const failures = new Map();
const legacyEntries = legacySoftloadEntries();
const managed = Object.freeze(Object.fromEntries(legacyEntries.map(([id, service]) => [id, service.container])));
const controllable = new Set(legacyEntries.filter(([, service]) => service.controllable).map(([id]) => id));

function equal(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
function send(res, status, data, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(JSON.stringify(data));
}
async function body(req) {
  let raw = '';
  for await (const part of req) {
    raw += part;
    if (raw.length > 65536) throw new Error('Request too large');
  }
  return JSON.parse(raw || '{}');
}
function hashPassword(password, salt = randomBytes(24).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}
function session(req) {
  const cookie = req.headers.cookie || '';
  const token = /(?:^|;\s*)panel_session=([a-f0-9]{64})(?:;|$)/.exec(cookie)?.[1];
  const expires = token && sessions.get(token);
  if (!expires || expires < Date.now()) {
    if (token) sessions.delete(token);
    return false;
  }
  return true;
}
function cookie(value, age) { return `panel_session=${value}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`; }
function clientIp(req) { return String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown').slice(0, 128); }
function blocked(ip) { const item = failures.get(ip); return Boolean(item && item.until > Date.now()); }
function failed(ip) {
  const item = failures.get(ip) || { count: 0, until: 0 };
  item.count += 1;
  if (item.count >= 5) item.until = Date.now() + 15 * 60_000;
  failures.set(ip, item);
}
function docker(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: process.env.PANEL_DOCKER_SOCKET_PATH || '/run/panel-executor/docker.sock', path: `/v1.45${path}`, method, timeout: 15000 }, res => {
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes <= 4_000_000) chunks.push(chunk); else req.destroy(new Error('Docker response too large')); });
      res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('Docker timeout')));
    req.on('error', reject);
    req.end();
  });
}
async function dockerJson(path, method) {
  const r = await docker(path, method);
  if (r.status >= 400) throw new Error(`Docker API HTTP ${r.status}`);
  return r.buffer.length ? JSON.parse(r.buffer.toString('utf8')) : null;
}
async function containers() {
  const list = await dockerJson('/containers/json?all=1');
  return Object.entries(managed).map(([id, name]) => {
    const c = list.find(item => item.Names?.includes(`/${name}`));
    return { id, name, state: c?.State || 'missing', status: c?.Status || 'Não encontrado', image: c?.Image || null, controllable: Boolean(c) && controllable.has(id) };
  });
}
function decodeDockerLogs(buffer) {
  let offset = 0;
  let result = '';
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset + 4);
    if (length > buffer.length - offset - 8) break;
    result += buffer.subarray(offset + 8, offset + 8 + length).toString('utf8');
    offset += 8 + length;
  }
  return offset ? result : buffer.toString('utf8');
}
function currentSha() {
  try { return /^SOFTLOAD_IMAGE_TAG=([0-9a-f]{40})$/m.exec(readFileSync(process.env.SOFTLOAD_ENV_FILE || '/host/softload.env', 'utf8'))?.[1] || null; }
  catch { return null; }
}
async function githubDeployRuns() {
  try {
    const response = await fetch('https://api.github.com/repos/Softdown-prog/Softloadv4/actions/workflows/deploy.yml/runs?per_page=20', {
      headers: { 'user-agent': 'softload-panel-api', accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return [];
    return (await response.json()).workflow_runs?.map(run => ({ id: run.id, sha: run.head_sha, branch: run.head_branch, status: run.status, conclusion: run.conclusion, createdAt: run.created_at, url: run.html_url })) || [];
  } catch { return []; }
}
async function handler(req, res) {
  if (!equal(req.headers['x-panel-edge-key'], edgeKey)) return send(res, 404, { error: 'Not found' });
  const url = new URL(req.url, 'http://panel-api.local');
  const path = url.pathname;
  const ip = clientIp(req);
  if (path === '/session' && req.method === 'GET') return send(res, 200, { authenticated: session(req), setupRequired: !existsSync(adminFile) });
  if (path === '/setup' && req.method === 'POST') {
    if (existsSync(adminFile)) return send(res, 409, { error: 'Já configurado' });
    if (blocked(ip)) return send(res, 429, { error: 'Tente mais tarde' });
    const input = await body(req);
    const token = readFileSync(setupFile, 'utf8').trim();
    if (!equal(input.setupToken, token)) { failed(ip); return send(res, 403, { error: 'Código inválido' }); }
    if (typeof input.password !== 'string' || input.password.length < 14 || input.password.length > 256) return send(res, 400, { error: 'Use uma senha de 14 a 256 caracteres' });
    const record = { username: 'admin', ...hashPassword(input.password), createdAt: new Date().toISOString() };
    try { writeFileSync(adminFile, JSON.stringify(record), { mode: 0o600, flag: 'wx' }); }
    catch (error) {
      if (error.code === 'EEXIST') return send(res, 409, { error: 'Já configurado' });
      throw error;
    }
    unlinkSync(setupFile);
    failures.delete(ip);
    console.log(`Administrator initialized from ${ip}`);
    return send(res, 201, { ok: true });
  }
  if (path === '/login' && req.method === 'POST') {
    if (!existsSync(adminFile)) return send(res, 409, { error: 'Configuração inicial necessária' });
    if (blocked(ip)) return send(res, 429, { error: 'Tente novamente em 15 minutos' });
    const input = await body(req);
    const admin = JSON.parse(readFileSync(adminFile, 'utf8'));
    const candidate = typeof input.password === 'string' && input.password.length <= 256 ? hashPassword(input.password, admin.salt).hash : '';
    if (input.username !== admin.username || !equal(candidate, admin.hash)) { failed(ip); return send(res, 401, { error: 'Usuário ou senha inválidos' }); }
    failures.delete(ip);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + 12 * 60 * 60_000);
    return send(res, 200, { ok: true }, { 'set-cookie': cookie(token, 43200) });
  }
  if (path === '/logout' && req.method === 'POST') {
    const token = /(?:^|;\s*)panel_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    if (token) sessions.delete(token);
    return send(res, 200, { ok: true }, { 'set-cookie': cookie('', 0) });
  }
  if (!session(req)) return send(res, 401, { error: 'Sessão necessária' });
  if (await handleSshTerminalRoute(req, res, {
    send, body,
    sessionId: /(?:^|;\s*)panel_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1] || '',
    verifyPassword: (password) => {
      if (blocked(ip) || !existsSync(adminFile)) return false;
      const admin = JSON.parse(readFileSync(adminFile, 'utf8'));
      const candidate = password.length <= 256 ? hashPassword(password, admin.salt).hash : '';
      const valid = equal(candidate, admin.hash);
      if (!valid) failed(ip); else failures.delete(ip);
      return valid;
    }
  })) return;
  if (await handleSecretsRoute(req, res, {
    send, body,
    verifyPassword: password => {
      if (blocked(ip) || !existsSync(adminFile)) return false;
      const admin = JSON.parse(readFileSync(adminFile, 'utf8'));
      const candidate = password.length <= 256 ? hashPassword(password, admin.salt).hash : '';
      const valid = equal(candidate, admin.hash);
      if (!valid) failed(ip); else failures.delete(ip);
      return valid;
    }
  })) return;
  if (await handleRevisionRoute(req, res, { send, body, dataDir })) return;
  if (await handleTrafficRoute(req, res, { send, body, dataDir })) return;
  if (await handleGitHubRoute(req, res, { send, body, dataDir })) return;
  if (await handleDomainRoute(req, res, { send, body, dataDir,
    execute: executeSshCommand,
    publishingEnabled: process.env.PANEL_DOMAIN_PUBLISH_ENABLED === '1'
  })) return;
  if (await handleAppRoute(req, res, { send, body, dataDir })) return;
  if (await handleImageImportRoute(req, res, { send, body, dataDir })) return;
  if (await handlePublicationRoute(req, res, { send, body, dataDir })) return;
  if (await handleReleaseRoute(req, res, { send, body, dataDir })) return;
  if (await handleProjectRoute(req, res, { send, body, dataDir })) return;
  if (path === '/password' && req.method === 'POST') {
    const input = await body(req);
    const admin = JSON.parse(readFileSync(adminFile, 'utf8'));
    const oldHash = typeof input.currentPassword === 'string' && input.currentPassword.length <= 256 ? hashPassword(input.currentPassword, admin.salt).hash : '';
    if (!equal(oldHash, admin.hash)) return send(res, 403, { error: 'Senha atual incorreta' });
    if (typeof input.newPassword !== 'string' || input.newPassword.length < 14 || input.newPassword.length > 256) return send(res, 400, { error: 'Use uma senha de 14 a 256 caracteres' });
    const updated = { ...admin, ...hashPassword(input.newPassword), changedAt: new Date().toISOString() };
    const tmp = `${adminFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(updated), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, adminFile);
    sessions.clear();
    console.log(`Administrator password changed from ${ip}`);
    return send(res, 200, { ok: true }, { 'set-cookie': cookie('', 0) });
  }
  if (path === '/overview' && req.method === 'GET') {
    const list = await containers();
    const total = totalmem();
    let disk = null;
    try {
      const fs = statfsSync(dataDir);
      const size = Number(fs.bsize) * Number(fs.blocks);
      const available = Number(fs.bsize) * Number(fs.bavail);
      if (Number.isFinite(size) && Number.isFinite(available) && size > 0)
        disk = { total: size, used: size - available, available };
    } catch { /* Filesystem capacity is optional when the volume cannot be inspected */ }
    let diskBytes = 0;
    try {
      const dockerDisk = await dockerJson('/system/df?type=images');
      diskBytes = dockerDisk?.Images?.reduce((sum, image) => sum + (image.Size || 0), 0) || 0;
    } catch { /* Docker disk accounting is optional */ }
    return send(res, 200, { services: list, memory: { total, used: total - freemem() }, cpu: { load1: loadavg()[0], cores: cpus().length }, disk, imagesBytes: diskBytes, currentSha: currentSha(), updatedAt: new Date().toISOString() });
  }
  if (path === '/services' && req.method === 'GET') return send(res, 200, { services: await containers() });
  const logs = /^\/services\/(app|agent|caddy)\/logs$/.exec(path);
  if (logs && req.method === 'GET') {
    if (!managed[logs[1]]) return send(res, 404, { error: 'Serviço não cadastrado neste host.' });
    const tail = Math.min(300, Math.max(1, Number(url.searchParams.get('tail') || 100) || 100));
    const r = await docker(`/containers/${encodeURIComponent(managed[logs[1]])}/logs?stdout=1&stderr=1&tail=${tail}&timestamps=1`);
    if (r.status >= 400) return send(res, 502, { error: `Não foi possível ler os logs (${r.status})` });
    return send(res, 200, { service: logs[1], lines: decodeDockerLogs(r.buffer).slice(-100_000) });
  }
  const operation = /^\/services\/(app|agent)\/(start|stop|restart)$/.exec(path);
  if (operation && req.method === 'POST') {
    const [, id, action] = operation;
    if (!controllable.has(id)) return send(res, 404, { error: 'Serviço não cadastrado neste host.' });
    const r = await docker(`/containers/${encodeURIComponent(managed[id])}/${action}?t=15`, 'POST');
    if (r.status >= 400) return send(res, 502, { error: `Docker não executou a ação (${r.status})` });
    console.log(`Container action ${action} on ${managed[id]} from ${ip}`);
    return send(res, 200, { ok: true, service: id, action });
  }
  if (path === '/deploys' && req.method === 'GET') {
    // GitHub and Docker are independent sources; start them together so
    // a slow GitHub request never adds to the Docker/public-health duration.
    const runsPromise = githubDeployRuns();
    const runtime = await inspectDeployedServices(docker, currentSha());
    const [runs, publicHealth] = await Promise.all([
      runsPromise,
      cachedPublicHealth(runtime.app?.revision)
    ]);
    const traffic = observeDeployRuns(dataDir, runs, (() => { try { return externalCounters(dataDir); } catch { return null; } })());
    return send(res, 200, {
      currentSha: runtime.configuredSha,
      runtime,
      publicHealth,
      runs: runs.map(run => ({ ...run, deploymentStatus: runDeploymentStatus(run, runtime, publicHealth), traffic: traffic.get(run.id) }))
    });
  }
  return send(res, 404, { error: 'Rota não encontrada' });
}

http.createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch(error => {
    console.error('Request failed:', error.message);
    if (!res.headersSent) send(res, 500, { error: 'Erro interno' });
    else res.end();
  });
}).listen(port, '0.0.0.0', () => console.log(`Panel API listening on ${port}`));
startIdleMonitor(dataDir);
startRevisionMonitor(dataDir);
startPublicationWorker(dataDir);
startTrafficMonitor(dataDir);
startDeployTrafficMonitor(dataDir, () => externalCounters(dataDir), githubDeployRuns);
