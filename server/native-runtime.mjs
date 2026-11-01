import { spawn } from 'node:child_process';
import { memorySnapshot } from './host-metrics.ts';

const MAX_INPUT = 65536;
const MAX_OUTPUT = 8192;
const BINARY = '/usr/local/bin/panel-runtime';

/** Fixed binary/operations only. No shell, inherited secrets, paths or commands from HTTP input. */
export function executeNative(binary, operation, input, timeoutMs = 2000) {
  if (!['version', 'memory', 'route'].includes(operation) || Buffer.byteLength(input) > MAX_INPUT)
    return Promise.reject(new Error('Native request rejected'));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [operation], { shell: false, env: {},
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { child.kill('SIGKILL'); reject(error); }
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Native timeout')), timeoutMs);
    child.on('error', () => finish(new Error('Native unavailable')));
    child.stdin.on('error', () => { /* exit/error/timeout handles early pipe closure */ });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) finish(new Error('Native output limit'));
      else chunks.push(chunk);
    });
    // Discard stderr contents; count it too so a failing executable cannot flood memory/logs.
    child.stderr.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) finish(new Error('Native output limit'));
    });
    child.on('close', code => {
      if (code !== 0) { finish(new Error('Native execution failed')); return; }
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(new Error('Native invalid response')); }
    });
    child.stdin.end(input);
  });
}

export function createNativeRuntime({ mode = process.env.PANEL_NATIVE_RUNTIME || 'off',
  binary = BINARY, execute = executeNative, now = Date.now, timeoutMs = 2000 } = {}) {
  let active = 0;
  let retryAt = 0;
  let lastEngine = 'node';
  let fallbackReason = mode === 'prefer' ? 'not-tested' : 'disabled';
  let successes = 0;
  let fallbacks = 0;
  const cache = new Map();
  const status = () => ({ configured: mode === 'prefer', engine: lastEngine,
    protocol: 1, successes, fallbacks, fallbackReason });
  async function call(operation, input, validate) {
    if (mode !== 'prefer') return { ok: false };
    if (now() < retryAt || active >= 2 || Buffer.byteLength(input) > MAX_INPUT) {
      fallbacks++; return { ok: false };
    }
    active++;
    try {
      const value = await execute(binary, operation, input, timeoutMs);
      if (!validate(value)) throw new Error('Native contract mismatch');
      lastEngine = 'rust'; fallbackReason = null; successes++;
      return { ok: true, value };
    } catch {
      // Short circuit repeated launch failures; Node preserves the previous behavior.
      retryAt = now() + 30000; lastEngine = 'node'; fallbackReason = 'native-unavailable'; fallbacks++;
      return { ok: false };
    } finally { active--; }
  }
  return {
    status,
    async probe() {
      await call('version', '', value => value?.protocol === 1 && value?.engine === 'rust' &&
        value?.version === '0.1.0');
      return status();
    },
    async memory(total, free, meminfo = '') {
      const expected = memorySnapshot(total, free, meminfo);
      const normalizedFree = Number.isFinite(free) ? Math.max(0, Math.min(expected.total, free)) : 0;
      if (![expected.total, normalizedFree].every(Number.isSafeInteger)) return expected;
      const native = await call('memory', `${expected.total}\n${normalizedFree}\n${meminfo}`, value =>
        value && Object.keys(value).length === 4 &&
        ['total', 'used', 'available', 'source'].every(key => value[key] === expected[key]));
      return native.ok ? native.value : expected;
    },
    async route(hostHeader, routes, fallback) {
      const expected = fallback(hostHeader, routes);
      if (!expected || !Array.isArray(routes) || routes.length > 256) return expected;
      const host = hostHeader.toLowerCase().replace(/:\d+$/, '');
      const rows = [];
      for (const entry of routes) {
        if (typeof entry?.host !== 'string' || !/^[a-z0-9.-]{4,253}$/.test(entry.host)) continue;
        if (typeof entry.slug !== 'string' || /[\t\r\n]/.test(entry.slug) ||
          !Number.isSafeInteger(entry.port)) return expected;
        rows.push(`${entry.host}\t${entry.slug}\t${entry.port}`);
      }
      const input = host + '\n' + rows.join('\n');
      const existing = cache.get(input);
      if (existing && existing.until > now()) return { ...existing.route };
      const native = await call('route', input, value => value && Object.keys(value).length === 2 &&
        value.slug === expected.slug && value.port === expected.port);
      if (!native.ok) return expected;
      if (cache.size >= 256) cache.delete(cache.keys().next().value);
      cache.set(input, { route: native.value, until: now() + 5000 });
      return { ...native.value };
    }
  };
}

export const nativeRuntime = createNativeRuntime();
