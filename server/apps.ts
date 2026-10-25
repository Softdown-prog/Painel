import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
const PREFIX = 'softload-app-';
const OWNER_LABEL = 'com.softload.panel.managed';
const ID_LABEL = 'com.softload.panel.slug';
const MAX_APPS = 8;
const RAM_CHOICES = [128, 256, 512, 768, 1024];
const CPU_CHOICES = [0.25, 0.5, 1, 2];
const IDLE_CHOICES = [0, 15, 30, 60, 120, 240];
export type DockerResponse = { status: number; buffer: Buffer };
export type DockerRequest = (path: string, method?: string, payload?: unknown) => Promise<DockerResponse>;
type Deps = {
  send: (res: ServerResponse, status: number, data: unknown) => void;
  body: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  docker?: DockerRequest;
  enabled?: boolean;
  images?: string[];
  dataDir?: string;
};
type DockerContainer = {
  Id: string; Names?: string[]; Image: string; State?: string; Status?: string;
  Labels?: Record<string, string>; SizeRw?: number;
};
type DockerInspect = { Id: string; Name: string; Config?: { Labels?: Record<string, string>; Image?: string }; State?: { Status?: string }; HostConfig?: { Memory?: number; NanoCpus?: number; NetworkMode?: string } };
type Resources = { ramMb: number; cpuCores: number };
export function validResources(value: Record<string, unknown>): value is Record<string, unknown> & Resources {
  return RAM_CHOICES.includes(value.ramMb as number) && CPU_CHOICES.includes(value.cpuCores as number);
}
function limits(resources: Resources) {
  const memory = resources.ramMb * 1024 * 1024;
  return { Memory: memory, MemorySwap: memory * 2, NanoCpus: resources.cpuCores * 1_000_000_000 };
}
function idleFile(dataDir: string) { return join(dataDir, 'app-idle.json'); }
function idlePolicies(dataDir: string): Record<string, number> {
  try {
    const value = JSON.parse(readFileSync(idleFile(dataDir), 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).filter(([slug, minutes]) => validSlug(slug) && IDLE_CHOICES.includes(minutes as number))) as Record<string, number>;
  } catch { return {}; }
}
function saveIdlePolicies(dataDir: string, policies: Record<string, number>) {
  const file = idleFile(dataDir);
  const temporary = file + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(policies), { mode: 0o600 });
  renameSync(temporary, file);
}
type IdleSample = { lastActive: number; network: number; cpu: number; sampledAt: number };
const idleSamples = new Map<string, IdleSample>();
function activityCounters(stats: Record<string, any>) {
  const network = Object.values(stats.networks || {}).reduce((sum: number, value: any) =>
    sum + Number(value.rx_bytes || 0) + Number(value.tx_bytes || 0), 0);
  return { network, cpu: Number(stats.cpu_stats?.cpu_usage?.total_usage || 0) };
}
export async function scanIdleApps(docker: DockerRequest, dataDir: string, now = Date.now(), samples = idleSamples): Promise<string[]> {
  const policies = idlePolicies(dataDir);
  if (!Object.keys(policies).length) return [];
  const stopped: string[] = [];
  for (const container of await listManaged(docker)) {
    const slug = container.Labels?.[ID_LABEL];
    if (!slug || !policies[slug] || container.State !== 'running') {
      if (slug) samples.delete(slug);
      continue;
    }
    const details = await inspectOwned(docker, slug);
    const result = await docker('/containers/' + encodeURIComponent(details.Id) + '/stats?stream=false&one-shot=true');
    if (result.status >= 400) continue;
    const counters = activityCounters(JSON.parse(result.buffer.toString('utf8')));
    const previous = samples.get(slug);
    const elapsed = previous ? Math.max(1, now - previous.sampledAt) : 0;
    const cpuBusy = previous && counters.cpu > previous.cpu &&
      (counters.cpu - previous.cpu) / (elapsed * 1_000_000) >= 0.01;
    const restarted = previous && (counters.network < previous.network || counters.cpu < previous.cpu);
    const lastActive = !previous || restarted || counters.network > previous.network || cpuBusy ? now : previous.lastActive;
    samples.set(slug, { ...counters, lastActive, sampledAt: now });
    if (now - lastActive < policies[slug] * 60_000 || idlePolicies(dataDir)[slug] !== policies[slug]) continue;
    const response = await docker('/containers/' + encodeURIComponent(details.Id) + '/stop?t=10', 'POST');
    if (response.status >= 200 && response.status < 300) {
      samples.delete(slug);
      stopped.push(slug);
      console.log('Panel idle stop: ' + slug);
    }
  }
  return stopped;
}
export function startIdleMonitor(dataDir: string, docker: DockerRequest = dockerRequest) {
  if (process.env.PANEL_APPS_ENABLED !== '1') return;
  let running = false;
  const timer = setInterval(() => {
    if (running || !existsSync(idleFile(dataDir))) return;
    running = true;
    scanIdleApps(docker, dataDir)
      .catch(error => console.error('Panel idle monitor:', error instanceof Error ? error.message : String(error)))
      .finally(() => { running = false; });
  }, 60_000);
  timer.unref();
}
function allowedImages(): string[] {
  return (process.env.PANEL_APPS_ALLOWED_IMAGES || '').split(',').map(s => s.trim())
    .filter(s => /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,190}$/.test(s));
}
export function managedContainerSpec(slug: string, image: string, labels: Record<string, string> = {}, resources: Resources = { ramMb: 256, cpuCores: 0.5 }, networkMode = process.env.PANEL_APPS_NETWORK === 'softload_panel_apps' ? 'softload_panel_apps' : 'bridge') {
  return {
    Image: image, User: '65534:65534',
    Labels: { [OWNER_LABEL]: 'true', [ID_LABEL]: slug, ...labels },
    HostConfig: {
      NetworkMode: networkMode === 'softload_panel_apps' ? networkMode : 'bridge', ReadonlyRootfs: true,
      ...limits(resources), PidsLimit: 64,
      CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
      Init: false, AutoRemove: false, PublishAllPorts: false,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=16m,mode=1777' }
    }
  };
}
export function validSlug(value: unknown): value is string {
  return typeof value === 'string' && /^(?=.{2,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
export function validImage(value: unknown, images: readonly string[]): value is string {
  return typeof value === 'string' && images.includes(value);
}
export async function dockerRequest(path: string, method = 'GET', payload?: unknown): Promise<DockerResponse> {
  const data = payload === undefined ? undefined : JSON.stringify(payload);
  if (data && Buffer.byteLength(data) > 8192) throw new Error('Docker payload too large');
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: process.env.PANEL_DOCKER_SOCKET_PATH || '/run/panel-executor/docker.sock', path: '/v1.45' + path, method,
      timeout: 15000, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, response => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (part: Buffer) => {
        bytes += part.length;
        if (bytes > 1_000_000) req.destroy(new Error('Docker response too large'));
        else chunks.push(part);
      });
      response.on('end', () => resolve({ status: response.statusCode || 502, buffer: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('Docker timeout')));
    req.on('error', reject);
    req.end(data);
  });
}
export class AppError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
async function json<T>(docker: DockerRequest, path: string): Promise<T> {
  const response = await docker(path);
  if (response.status >= 400) throw new AppError(502, 'Falha na consulta ao Docker (' + response.status + ').');
  return JSON.parse(response.buffer.toString('utf8')) as T;
}
function owned(labels: Record<string, string> | undefined, slug: string): boolean {
  return labels?.[OWNER_LABEL] === 'true' && labels?.[ID_LABEL] === slug;
}
function safeContainer(container: DockerContainer): boolean {
  const slug = container.Labels?.[ID_LABEL];
  return validSlug(slug) && owned(container.Labels, slug) &&
    container.Names?.includes('/' + PREFIX + slug) === true;
}
function item(container: DockerContainer, details?: DockerInspect, idleMinutes = 0) {
  return { slug: container.Labels?.[ID_LABEL], name: container.Names?.[0]?.replace(/^\//, ''),
    image: container.Image, state: container.State || 'unknown', status: container.Status || '',
    ramMb: Math.round((details?.HostConfig?.Memory || 0) / 1048576),
    cpuCores: (details?.HostConfig?.NanoCpus || 0) / 1_000_000_000,
    diskUsedBytes: container.SizeRw ?? null, idleMinutes,
    network: details?.HostConfig?.NetworkMode || 'unknown' };
}
async function listManaged(docker: DockerRequest, includeSize = false): Promise<DockerContainer[]> {
  const filters = encodeURIComponent(JSON.stringify({ label: [OWNER_LABEL + '=true'] }));
  const all = await json<DockerContainer[]>(docker, '/containers/json?all=1&filters=' + filters + (includeSize ? '&size=1' : ''));
  return all.filter(safeContainer);
}
export async function inspectOwned(docker: DockerRequest, slug: string): Promise<DockerInspect> {
  const result = await docker('/containers/' + encodeURIComponent(PREFIX + slug) + '/json');
  if (result.status === 404) throw new AppError(404, 'Aplicação não encontrada.');
  if (result.status >= 400) throw new AppError(502, 'Falha ao consultar aplicação no Docker.');
  const details = JSON.parse(result.buffer.toString('utf8')) as DockerInspect;
  if (details.Name !== '/' + PREFIX + slug || !owned(details.Config?.Labels, slug))
    throw new AppError(403, 'Esse container não pertence ao gerenciador.');
  return details;
}
let createQueue: Promise<void> = Promise.resolve();
async function serializedCreate<T>(callback: () => Promise<T>): Promise<T> {
  const previous = createQueue;
  let release!: () => void;
  createQueue = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await callback(); } finally { release(); }
}
export async function handleAppRoute(req: IncomingMessage, res: ServerResponse, deps: Deps): Promise<boolean> {
  const path = new URL(req.url || '/', 'http://panel.local').pathname;
  if (path !== '/apps' && !path.startsWith('/apps/')) return false;
  const send = (status: number, result: unknown) => deps.send(res, status, result);
  const docker = deps.docker || dockerRequest;
  const images = deps.images || allowedImages();
  const enabled = deps.enabled ?? process.env.PANEL_APPS_ENABLED === '1';
  const dataDir = deps.dataDir || process.env.PANEL_DATA_DIR || '/data';
  try {
    if (path === '/apps' && req.method === 'GET') {
      const policies = idlePolicies(dataDir);
      const containers = await listManaged(docker, true);
      const applications = await Promise.all(containers.map(async container => {
        const slug = container.Labels![ID_LABEL];
        const details = await inspectOwned(docker, slug);
        return item(container, details, policies[slug] || 0);
      }));
      send(200, { enabled, allowedImages: enabled ? images : [], maxApps: MAX_APPS,
        ramChoices: RAM_CHOICES, cpuChoices: CPU_CHOICES, idleChoices: IDLE_CHOICES, applications });
      return true;
    }
    if (!enabled && req.method !== 'GET') throw new AppError(403, 'Gerenciamento de aplicações não habilitado na VPS.');
    if (path === '/apps' && req.method === 'POST') {
      const input = await deps.body(req);
      const slug = input.slug;
      const image = input.image;
      const resources = { ramMb: input.ramMb ?? 256, cpuCores: input.cpuCores ?? 0.5 };
      if (!validSlug(slug) || !validImage(image, images) || !validResources(resources) ||
        Object.keys(input).some(key => !['slug', 'image', 'ramMb', 'cpuCores'].includes(key)))
        throw new AppError(400, 'Nome, imagem ou limites inválidos. Utilize valores autorizados.');
      await serializedCreate(async () => {
        const present = await listManaged(docker);
        if (present.length >= MAX_APPS) throw new AppError(409, 'Limite de oito aplicações atingido.');
        if (present.some(c => c.Labels?.[ID_LABEL] === slug)) throw new AppError(409, 'Aplicação já existe.');
        const available = await json<Array<{ RepoTags?: string[] }>>(docker, '/images/json');
        if (!available.some(v => v.RepoTags?.includes(image))) throw new AppError(422, 'Imagem não encontrada localmente na VPS.');
        const spec = managedContainerSpec(slug, image, {}, resources);
        const response = await docker('/containers/create?name=' + encodeURIComponent(PREFIX + slug), 'POST', spec);
        if (response.status === 409) throw new AppError(409, 'Já existe um container com esse nome.');
        if (response.status !== 201) throw new AppError(502, 'Docker não conseguiu criar o container (' + response.status + ').');
      });
      console.log('Panel application created: ' + slug);
      send(201, { ok: true, slug, state: 'created' });
      return true;
    }
    const matched = /^\/apps\/([a-z0-9-]+)(?:\/(start|stop|restart|logs|resources|idle))?$/.exec(path);
    if (!matched || !validSlug(matched[1])) throw new AppError(404, 'Rota não encontrada.');
    const [, slug, operation] = matched;
    const details = await inspectOwned(docker, slug);
    if (!operation && req.method === 'GET') {
      send(200, { slug, image: details.Config?.Image, state: details.State?.Status,
        ramMb: Math.round((details.HostConfig?.Memory || 0) / 1048576),
        cpuCores: (details.HostConfig?.NanoCpus || 0) / 1_000_000_000,
        idleMinutes: idlePolicies(dataDir)[slug] || 0 });
      return true;
    }
    if (operation === 'resources' && req.method === 'POST') {
      const input = await deps.body(req);
      if (Object.keys(input).sort().join(',') !== 'cpuCores,ramMb' || !validResources(input))
        throw new AppError(400, 'Selecione limites de RAM e CPU autorizados.');
      const response = await docker('/containers/' + encodeURIComponent(details.Id) + '/update', 'POST', limits(input));
      if (response.status >= 400) throw new AppError(502, 'Docker não atualizou os limites (' + response.status + ').');
      send(200, { ok: true, slug, ...input });
      return true;
    }
    if (operation === 'idle' && req.method === 'POST') {
      const input = await deps.body(req);
      if (Object.keys(input).join(',') !== 'minutes' || !IDLE_CHOICES.includes(input.minutes as number))
        throw new AppError(400, 'Período de inatividade inválido.');
      const policies = idlePolicies(dataDir);
      if (input.minutes === 0) delete policies[slug];
      else policies[slug] = input.minutes as number;
      saveIdlePolicies(dataDir, policies);
      idleSamples.delete(slug);
      send(200, { ok: true, slug, idleMinutes: input.minutes });
      return true;
    }
    if (operation === 'logs' && req.method === 'GET') {
      const response = await docker('/containers/' + encodeURIComponent(details.Id) + '/logs?stdout=1&stderr=1&tail=100&timestamps=1');
      if (response.status >= 400) throw new AppError(502, 'Não foi possível consultar logs.');
      let offset = 0, log = '';
      while (offset + 8 <= response.buffer.length) {
        const len = response.buffer.readUInt32BE(offset + 4);
        if (len > response.buffer.length - offset - 8) break;
        log += response.buffer.subarray(offset + 8, offset + 8 + len).toString('utf8');
        offset += 8 + len;
      }
      send(200, { slug, lines: (offset ? log : response.buffer.toString('utf8')).slice(-50000) });
      return true;
    }
    if (['start', 'stop', 'restart'].includes(operation || '') && req.method === 'POST') {
      const response = await docker('/containers/' + encodeURIComponent(details.Id) + '/' + operation + '?t=10', 'POST');
      if (response.status === 304) throw new AppError(409, 'Container já está nesse estado.');
      if (response.status >= 400) throw new AppError(502, 'Docker não executou a operação (' + response.status + ').');
      idleSamples.delete(slug);
      console.log('Panel application action: ' + slug + ' ' + operation);
      send(200, { ok: true, slug, action: operation });
      return true;
    }
    if (!operation && req.method === 'DELETE') {
      const domainRegistry = join(dataDir, 'domain-routes.json');
      if (existsSync(domainRegistry)) {
        const routes = JSON.parse(readFileSync(domainRegistry, 'utf8')) as Array<{ slug?: unknown }>;
        if (!Array.isArray(routes) || routes.some(route => route?.slug === slug))
          throw new AppError(409, 'Remova o domínio cadastrado antes de excluir a aplicação.');
      }
      if (details.State?.Status === 'running') throw new AppError(409, 'Pare a aplicação antes de remover o container.');
      const response = await docker('/containers/' + encodeURIComponent(details.Id) + '?force=0&v=0', 'DELETE');
      if (response.status !== 204) throw new AppError(502, 'Docker não removeu o container (' + response.status + ').');
      const policies = idlePolicies(dataDir);
      if (policies[slug]) { delete policies[slug]; saveIdlePolicies(dataDir, policies); }
      console.log('Panel application removed: ' + slug);
      send(200, { ok: true, slug });
      return true;
    }
    throw new AppError(405, 'Método não permitido.');
  } catch (error) {
    if (error instanceof AppError) send(error.status, { error: error.message });
    else if (error instanceof SyntaxError) send(400, { error: 'JSON inválido.' });
    else {
      console.error('Panel application error:', error instanceof Error ? error.message : String(error));
      send(502, { error: 'Falha na API do Docker.' });
    }
    return true;
  }
}
