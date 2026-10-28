import { existsSync, readFileSync, renameSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { totalmem, freemem } from 'node:os';
import { memorySnapshot } from './host-metrics.ts';

export type ResourcePoint = { at: string; memoryPercent: number | null; diskPercent: number | null };
type ResourceStore = { version: 1; samples: ResourcePoint[] };
const INTERVAL_MS = 5 * 60_000;
const WINDOW_MS = 24 * 60 * 60_000;
const MAX_POINTS = 288;
const MAX_BYTES = 100_000;
const file = (dir: string) => join(dir, 'resource-history.json');

function percent(used: number, total: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0 || used < 0 || used > total)
    return null;
  return Math.round(used / total * 10_000) / 100;
}
function valid(point: ResourcePoint): boolean {
  const possible = (value: number | null) => value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100);
  return Boolean(point && typeof point.at === 'string' &&
    Number.isFinite(Date.parse(point.at)) &&
    possible(point.memoryPercent) && possible(point.diskPercent));
}
export function appendResourceSample(previous: ResourcePoint[], next: ResourcePoint, now = new Date()): ResourcePoint[] {
  if (!valid(next) || !Number.isFinite(now.getTime())) return previous;
  const time = now.getTime();
  if (Math.abs(Date.parse(next.at) - time) > 60_000) return previous;
  const recent = previous.filter(point => valid(point) && Date.parse(point.at) >= time - WINDOW_MS &&
    Date.parse(point.at) <= time + 60_000).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (recent.length && time - Date.parse(recent[recent.length - 1].at) < INTERVAL_MS)
    return recent.slice(-MAX_POINTS);
  if (next.memoryPercent === null && next.diskPercent === null)
    return recent.slice(-MAX_POINTS);
  return [...recent, next].slice(-MAX_POINTS);
}
function load(dir: string): ResourceStore {
  if (!existsSync(file(dir))) return { version: 1, samples: [] };
  if (statSync(file(dir)).size > MAX_BYTES) throw new Error('Histórico de recursos acima do limite permitido');
  const state: unknown = JSON.parse(readFileSync(file(dir), 'utf8'));
  if (!state || typeof state !== 'object') throw new Error('Histórico de recursos inválido');
  const raw = state as Partial<ResourceStore>;
  if (raw.version !== 1 || !Array.isArray(raw.samples) || raw.samples.length > MAX_POINTS ||
    !raw.samples.every(valid)) throw new Error('Histórico de recursos inválido');
  return { version: 1, samples: raw.samples };
}
export function readResourceHistory(dir: string, now = new Date()) {
  try {
    const state = load(dir);
    const samples = state.samples.filter(point => Date.parse(point.at) >= now.getTime() - WINDOW_MS &&
      Date.parse(point.at) <= now.getTime() + 60_000);
    return { available: true, cadenceMinutes: 5, samples,
      lastSampleAt: samples.at(-1)?.at || null,
      explanation: 'Coleta da API a cada cinco minutos enquanto o serviço estiver em execução.' };
  } catch {
    return { available: false, cadenceMinutes: 5, samples: [] as ResourcePoint[], lastSampleAt: null,
      explanation: 'Histórico temporariamente indisponível. Nenhum dado antigo foi apagado.' };
  }
}
export function collectResourcePoint(dir: string, now = new Date()): ResourcePoint {
  let memoryPercent: number | null = null;
  try {
    const snapshot = memorySnapshot(totalmem(), freemem(), readFileSync('/proc/meminfo', 'utf8'));
    if (snapshot.source === 'memavailable') memoryPercent = percent(snapshot.used, snapshot.total);
  } catch { /* Não registrar estimativa baseada apenas em memória livre */ }
  let diskPercent: number | null = null;
  try {
    const fs = statfsSync(dir);
    const total = Number(fs.bsize) * Number(fs.blocks);
    const available = Number(fs.bsize) * Number(fs.bavail);
    diskPercent = percent(total - available, total);
  } catch { /* Sem medição válida do sistema de arquivos */ }
  return { at: now.toISOString(), memoryPercent, diskPercent };
}
export function sampleResourceHistory(dir: string, next: ResourcePoint, now = new Date()) {
  const current = load(dir);
  const updated = appendResourceSample(current.samples, next, now);
  if (updated.length === current.samples.length &&
    updated.every((point, index) => point.at === current.samples[index]?.at)) return false;
  const temp = file(dir) + '.' + process.pid + '.tmp';
  writeFileSync(temp, JSON.stringify({ version: 1, samples: updated }) + '\n', { mode: 0o600 });
  renameSync(temp, file(dir));
  return true;
}
export function startResourceHistoryMonitor(dir: string) {
  const sample = () => {
    try { sampleResourceHistory(dir, collectResourcePoint(dir)); }
    catch (error) { console.error('Resource history:', error instanceof Error ? error.message : 'unavailable'); }
  };
  sample();
  const timer = setInterval(sample, INTERVAL_MS);
  timer.unref();
}
