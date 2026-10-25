import http, { type IncomingMessage, type ServerResponse } from 'node:http';
const PREFIX = 'softload-app-';
const OWNER_LABEL = 'com.softload.panel.managed';
const ID_LABEL = 'com.softload.panel.slug';
const MAX_APPS = 8;
const RAM_BYTES = 256 * 1024 * 1024;
const CPU_NANOS = 500_000_000;
export type DockerResponse = { status: number; buffer: Buffer };
export type DockerRequest = (path: string, method?: string, payload?: unknown) => Promise<DockerResponse>;
type Deps = {
  send: (res: ServerResponse, status: number, data: unknown) => void;
  body: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  docker?: DockerRequest;
  enabled?: boolean;
  images?: string[];
};
type DockerContainer = {
  Id: string; Names?: string[]; Image: string; State?: string; Status?: string;
  Labels?: Record<string, string>;
};
type DockerInspect = { Id: string; Name: string; Config?: { Labels?: Record<string, string>; Image?: string }; State?: { Status?: string } };
function allowedImages(): string[] {
  return (process.env.PANEL_APPS_ALLOWED_IMAGES || '').split(',').map(s => s.trim())
    .filter(s => /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,190}$/.test(s));
}
export function managedContainerSpec(slug: string, image: string, labels: Record<string, string> = {}) {
  return {
    Image: image, User: '65534:65534',
    Labels: { [OWNER_LABEL]: 'true', [ID_LABEL]: slug, ...labels },
    HostConfig: {
      NetworkMode: 'bridge', ReadonlyRootfs: true,
      Memory: RAM_BYTES, NanoCpus: CPU_NANOS, PidsLimit: 64,
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
    const req = http.request({ socketPath: '/var/run/docker.sock', path: '/v1.45' + path, method,
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
function item(container: DockerContainer) {
  return { slug: container.Labels?.[ID_LABEL], name: container.Names?.[0]?.replace(/^\//, ''),
    image: container.Image, state: container.State || 'unknown', status: container.Status || '' };
}
async function listManaged(docker: DockerRequest): Promise<DockerContainer[]> {
  const filters = encodeURIComponent(JSON.stringify({ label: [OWNER_LABEL + '=true'] }));
  const all = await json<DockerContainer[]>(docker, '/containers/json?all=1&filters=' + filters);
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
  try {
    if (path === '/apps' && req.method === 'GET') {
      send(200, { enabled, allowedImages: enabled ? images : [], maxApps: MAX_APPS,
        applications: (await listManaged(docker)).map(item) });
      return true;
    }
    if (!enabled && req.method !== 'GET') throw new AppError(403, 'Gerenciamento de aplicações não habilitado na VPS.');
    if (path === '/apps' && req.method === 'POST') {
      const input = await deps.body(req);
      const slug = input.slug;
      const image = input.image;
      if (!validSlug(slug) || !validImage(image, images) || Object.keys(input).some(key => !['slug', 'image'].includes(key)))
        throw new AppError(400, 'Nome ou imagem inválidos. Utilize uma imagem previamente autorizada.');
      await serializedCreate(async () => {
        const present = await listManaged(docker);
        if (present.length >= MAX_APPS) throw new AppError(409, 'Limite de oito aplicações atingido.');
        if (present.some(c => c.Labels?.[ID_LABEL] === slug)) throw new AppError(409, 'Aplicação já existe.');
        const available = await json<Array<{ RepoTags?: string[] }>>(docker, '/images/json');
        if (!available.some(v => v.RepoTags?.includes(image))) throw new AppError(422, 'Imagem não encontrada localmente na VPS.');
        const spec = managedContainerSpec(slug, image);
        const response = await docker('/containers/create?name=' + encodeURIComponent(PREFIX + slug), 'POST', spec);
        if (response.status === 409) throw new AppError(409, 'Já existe um container com esse nome.');
        if (response.status !== 201) throw new AppError(502, 'Docker não conseguiu criar o container (' + response.status + ').');
      });
      console.log('Panel application created: ' + slug);
      send(201, { ok: true, slug, state: 'created' });
      return true;
    }
    const matched = /^\/apps\/([a-z0-9-]+)(?:\/(start|stop|restart|logs))?$/.exec(path);
    if (!matched || !validSlug(matched[1])) throw new AppError(404, 'Rota não encontrada.');
    const [, slug, operation] = matched;
    const details = await inspectOwned(docker, slug);
    if (!operation && req.method === 'GET') {
      send(200, { slug, image: details.Config?.Image, state: details.State?.Status });
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
      console.log('Panel application action: ' + slug + ' ' + operation);
      send(200, { ok: true, slug, action: operation });
      return true;
    }
    if (!operation && req.method === 'DELETE') {
      if (details.State?.Status === 'running') throw new AppError(409, 'Pare a aplicação antes de remover o container.');
      const response = await docker('/containers/' + encodeURIComponent(details.Id) + '?force=0&v=0', 'DELETE');
      if (response.status !== 204) throw new AppError(502, 'Docker não removeu o container (' + response.status + ').');
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
