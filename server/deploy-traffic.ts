import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Counters = { rx: number; tx: number };
type Snapshot = Counters & { at: string };
type Run = { id: number; sha?: string; status?: string; conclusion?: string | null; createdAt?: string };
type Entry = { id: number; sha: string | null; createdAt: string | null; observedAt: string; status: string; conclusion: string | null; start?: Snapshot; end?: Snapshot; unavailable?: string };
type Store = { version: 1; entries: Entry[] };
const FILE = 'deploy-traffic.json';
const RETENTION = 100;

const filename = (dataDir: string) => join(dataDir, FILE);
const validCounters = (value: unknown): value is Counters => Boolean(value && Number.isSafeInteger((value as Counters).rx) && Number.isSafeInteger((value as Counters).tx) && (value as Counters).rx >= 0 && (value as Counters).tx >= 0);
const active = (run: Run) => ['queued', 'pending', 'waiting', 'in_progress'].includes(run.status || '');
const completed = (run: Run) => run.status === 'completed';
function load(dataDir: string): Store {
  if (!existsSync(filename(dataDir))) return { version: 1, entries: [] };
  const value = JSON.parse(readFileSync(filename(dataDir), 'utf8')) as Store;
  if (value?.version !== 1 || !Array.isArray(value.entries)) throw new Error('Histórico de tráfego por deploy inválido.');
  return value;
}
function save(dataDir: string, value: Store) {
  const temporary = filename(dataDir) + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 }); renameSync(temporary, filename(dataDir));
}
function snap(counters: Counters, now: Date): Snapshot { return { ...counters, at: now.toISOString() }; }
export function estimate(entry?: Entry | null) {
  if (!entry?.start || !entry.end) return { available: false, reason: entry?.unavailable || 'Aguardando o início e o fim observados pelo coletor.' };
  // A reset/restart of the host interface makes the interval unknowable; never invent a value.
  if (entry.end.rx < entry.start.rx || entry.end.tx < entry.start.tx) return { available: false, reason: 'Contador de rede reiniciado durante o deploy.' };
  return { available: true, rx: entry.end.rx - entry.start.rx, tx: entry.end.tx - entry.start.tx, total: entry.end.rx - entry.start.rx + entry.end.tx - entry.start.tx, startedAt: entry.start.at, finishedAt: entry.end.at };
}
export function observeDeployRuns(dataDir: string, runs: Run[], counters: Counters | null, now = new Date()) {
  const state = load(dataDir); const changed = new Map<number, Entry>();
  for (const run of runs) {
    if (!Number.isSafeInteger(run.id) || run.id < 1) continue;
    let entry = state.entries.find(item => item.id === run.id);
    if (!entry) {
      entry = { id: run.id, sha: typeof run.sha === 'string' ? run.sha : null, createdAt: typeof run.createdAt === 'string' ? run.createdAt : null, observedAt: now.toISOString(), status: run.status || 'unknown', conclusion: run.conclusion || null };
      state.entries.push(entry);
    }
    entry.status = run.status || entry.status; entry.conclusion = run.conclusion ?? entry.conclusion;
    if (active(run) && !entry.start && validCounters(counters)) entry.start = snap(counters, now);
    if (completed(run) && !entry.end) {
      if (entry.start && validCounters(counters)) entry.end = snap(counters, now);
      else if (!entry.start) entry.unavailable = 'O deploy terminou antes de ser observado pelo coletor.';
    }
    changed.set(run.id, entry);
  }
  state.entries = state.entries.sort((a, b) => b.id - a.id).slice(0, RETENTION);
  save(dataDir, state);
  return new Map(runs.map(run => [run.id, estimate(changed.get(run.id) || state.entries.find(item => item.id === run.id))]));
}
export function deploymentTraffic(dataDir: string, runs: Run[]) {
  const state = load(dataDir);
  return new Map(runs.map(run => [run.id, estimate(state.entries.find(item => item.id === run.id))]));
}
export function startDeployTrafficMonitor(dataDir: string, readCounters: () => Counters, fetchRuns: () => Promise<Run[]>) {
  const collect = async () => {
    try { observeDeployRuns(dataDir, await fetchRuns(), readCounters()); }
    catch (error) { console.error('Deploy traffic monitor:', error instanceof Error ? error.message : 'unavailable'); }
  };
  void collect(); const timer = setInterval(() => void collect(), 5 * 60_000); timer.unref();
}
