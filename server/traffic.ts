import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

type Counters = { rx: number; tx: number };
type Daily = { date: string; rx: number; tx: number };
type Store = { version: 1; interface: string; last?: Counters & { at: string }; days: Daily[]; settings: { allowanceBytes: number; resetDay: number } };
type Deps = { dataDir: string; send: (res: ServerResponse, status: number, value: unknown) => void; body: (req: IncomingMessage) => Promise<Record<string, unknown>>; source?: () => Counters };
const TB = 1024 ** 4;
const maxDays = 370;
const dateKey = (time: Date) => time.toISOString().slice(0, 10);
const file = (dataDir: string) => join(dataDir, 'network-traffic.json');
export function parseProcNetDev(text: string, device: string): Counters | null {
  const line = text.split('\n').find(value => value.trimStart().startsWith(device + ':'));
  if (!line) return null;
  const values = line.slice(line.indexOf(':') + 1).trim().split(/\s+/).map(Number);
  const rx = values[0], tx = values[8];
  return typeof rx === 'number' && typeof tx === 'number' && Number.isSafeInteger(rx) && Number.isSafeInteger(tx) && rx >= 0 && tx >= 0 ? { rx, tx } : null;
}
function defaults(): Store { return { version: 1, interface: process.env.PANEL_TRAFFIC_INTERFACE || 'eth0', days: [], settings: { allowanceBytes: TB, resetDay: 1 } }; }
function read(dataDir: string): Store {
  if (!existsSync(file(dataDir))) return defaults();
  const value = JSON.parse(readFileSync(file(dataDir), 'utf8')) as Store;
  if (value?.version !== 1 || !/^[a-zA-Z0-9._-]{1,32}$/.test(value.interface) || !Array.isArray(value.days) || !Number.isSafeInteger(value.settings?.allowanceBytes) || value.settings.allowanceBytes < 1 || !Number.isInteger(value.settings?.resetDay) || value.settings.resetDay < 1 || value.settings.resetDay > 28) throw new Error('Histórico de tráfego inválido.');
  return value;
}
function save(dataDir: string, value: Store) { const temp = file(dataDir) + '.' + process.pid + '.tmp'; writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600 }); renameSync(temp, file(dataDir)); }
function periodStart(now: Date, resetDay: number): string { return dateKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (now.getUTCDate() < resetDay ? 1 : 0), resetDay))); }
export function addCounters(store: Store, next: Counters, now = new Date()): Store {
  if (!Number.isSafeInteger(next.rx) || !Number.isSafeInteger(next.tx) || next.rx < 0 || next.tx < 0) return store;
  const key = dateKey(now); const previous = store.last;
  if (previous) {
    const rx = next.rx >= previous.rx ? next.rx - previous.rx : 0;
    const tx = next.tx >= previous.tx ? next.tx - previous.tx : 0;
    const daily = store.days.find(item => item.date === key);
    if (daily) { daily.rx += rx; daily.tx += tx; } else store.days.push({ date: key, rx, tx });
  }
  store.last = { ...next, at: now.toISOString() };
  store.days = store.days.filter(item => /^\d{4}-\d\d-\d\d$/.test(item.date)).slice(-maxDays);
  return store;
}
function sample(dataDir: string, source: () => Counters) { const state = addCounters(read(dataDir), source()); save(dataDir, state); return state; }
export function summarizeTraffic(state: Store, now = new Date()) {
  const start = periodStart(now, state.settings.resetDay);
  const month = state.days.filter(item => item.date >= start).reduce((total, item) => ({ rx: total.rx + item.rx, tx: total.tx + item.tx }), { rx: 0, tx: 0 });
  const total = month.rx + month.tx; const percentage = Math.min(100, total / state.settings.allowanceBytes * 100);
  const alert = percentage >= 95 ? 'critical' : percentage >= 85 ? 'high' : percentage >= 70 ? 'warning' : 'ok';
  return { ...month, total, periodStart: start, percentage, alert };
}
function response(dataDir: string, source?: () => Counters) {
  let state: Store;
  try { state = source ? sample(dataDir, source) : read(dataDir); } catch { return { available: false, message: 'Dados indisponíveis. A coleta da interface externa não está acessível.' }; }
  const month = summarizeTraffic(state);
  return { available: Boolean(state.last), interface: state.interface, source: 'Contadores do Linux em /proc/net/dev', billingNote: 'Referência técnica RX + TX; a medição faturada da LocaCloud pode usar critério diferente.', historyStartsAt: state.days[0]?.date || null, lastSampleAt: state.last?.at || null, settings: state.settings, month, daily: state.days.slice(-31) };
}
export function startTrafficMonitor(dataDir: string) {
  const source = () => externalCounters(dataDir);
  const collect = () => { try { sample(dataDir, source); } catch (error) { console.error('Traffic monitor:', error instanceof Error ? error.message : 'unavailable'); } };
  collect(); const timer = setInterval(collect, 5 * 60_000); timer.unref();
}
export function externalCounters(dataDir: string): Counters {
  const state = read(dataDir); const counters = parseProcNetDev(readFileSync(process.env.PANEL_TRAFFIC_PROC_FILE || '/host/proc/net/dev', 'utf8'), state.interface); if (!counters) throw new Error('Interface externa indisponível'); return counters;
}
export async function handleTrafficRoute(req: IncomingMessage, res: ServerResponse, deps: Deps): Promise<boolean> {
  if (new URL(req.url || '/', 'http://panel.local').pathname !== '/traffic') return false;
  try {
    if (req.method === 'GET') { deps.send(res, 200, response(deps.dataDir, deps.source)); return true; }
    if (req.method === 'POST') {
      const input = await deps.body(req); const allowanceTb = input.allowanceTb; const resetDay = input.resetDay;
      if (Object.keys(input).sort().join(',') !== 'allowanceTb,resetDay' || typeof allowanceTb !== 'number' || !Number.isFinite(allowanceTb) || allowanceTb < 0.01 || allowanceTb > 1000 || typeof resetDay !== 'number' || !Number.isInteger(resetDay) || resetDay < 1 || resetDay > 28) { deps.send(res, 400, { error: 'Informe franquia entre 0,01 e 1000 TB e dia de renovação de 1 a 28.' }); return true; }
      const state = read(deps.dataDir); state.settings = { allowanceBytes: Math.round((allowanceTb as number) * TB), resetDay: resetDay as number }; save(deps.dataDir, state);
      deps.send(res, 200, response(deps.dataDir, deps.source)); return true;
    }
    deps.send(res, 405, { error: 'Método não permitido.' }); return true;
  } catch { deps.send(res, 503, { available: false, error: 'Dados de tráfego indisponíveis.' }); return true; }
}
