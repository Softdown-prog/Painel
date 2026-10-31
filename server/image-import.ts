import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readProjects } from './projects.ts';
import { readRepositories, github, type LinkedRepository } from './github.ts';
import { dockerRequest, type DockerRequest, type DockerResponse } from './apps.ts';
const validSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

const WORKFLOW = 'panel-app-build.yml';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json'
].join(', ');
type ImportRecord = { slug: string; repository: string; revision: string; digest: string; imageId: string; runId: number; importedAt: string };
type ImportJob = { status: 'running' | 'success' | 'error'; slug: string; revision: string; startedAt: string; digest?: string; message?: string };
type Deps = {
  dataDir: string;
  send: (res: ServerResponse, status: number, data: unknown) => void;
  body: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  githubRequest?: typeof github;
  repositories?: () => LinkedRepository[];
  resolveDigest?: (repository: string, revision: string) => Promise<string>;
  pull?: (ref: string) => Promise<void>;
  docker?: DockerRequest;
  enabled?: boolean;
};
const jobs = new Map<string, ImportJob>();
let active: string | null = null;
class ImportError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function readImports(dataDir: string): ImportRecord[] {
  const path = join(dataDir, 'image-imports.json');
  if (!existsSync(path)) return [];
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(data) || !data.every((value: unknown) => {
    if (!value || typeof value !== 'object') return false;
    const v = value as ImportRecord;
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.slug) &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v.repository) &&
      validSha(v.revision) && DIGEST_RE.test(v.digest) &&
      /^sha256:[a-f0-9]{64}$/.test(v.imageId) && Number.isSafeInteger(v.runId);
  })) throw new ImportError(500, 'Registros de importação inválidos.');
  return data as ImportRecord[];
}
function saveImport(dataDir: string, item: ImportRecord): void {
  const existing = readImports(dataDir).filter(v => v.slug !== item.slug || v.revision !== item.revision);
  const dest = join(dataDir, 'image-imports.json');
  const temp = dest + '.' + process.pid + '.tmp';
  writeFileSync(temp, JSON.stringify([...existing, item], null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, dest);
}
function registryCredentials(): { username: string; password: string } | null {
  const path = process.env['PANEL_GHCR_TOKEN_FILE'];
  const username = process.env['PANEL_GHCR_USERNAME'];
  if (!path || !username) return null;
  const password = readFileSync(path, 'utf8').trim();
  return password ? { username, password } : null;
}
export async function resolveGhcrDigest(repository: string, revision: string): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !validSha(revision))
    throw new ImportError(400, 'Repositório ou revisão inválidos.');
  const name = repository.toLowerCase();
  const credentials = registryCredentials();
  const tokenUrl = new URL('https://ghcr.io/token');
  tokenUrl.searchParams.set('service', 'ghcr.io');
  tokenUrl.searchParams.set('scope', 'repository:' + name + ':pull');
  const basic = credentials ? 'Basic ' + Buffer.from(credentials.username + ':' + credentials.password).toString('base64') : undefined;
  const tokenResponse = await fetch(tokenUrl, { headers: basic ? { authorization: basic } : {}, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!tokenResponse.ok) throw new ImportError(502, 'GHCR recusou a autenticação de leitura.');
  const tokenData: unknown = await tokenResponse.json();
  const token = typeof tokenData === 'object' && tokenData !== null ?
    ((tokenData as { token?: unknown; access_token?: unknown }).token ?? (tokenData as { access_token?: unknown }).access_token) : undefined;
  if (typeof token !== 'string' || !token.length) throw new ImportError(502, 'Token de leitura do GHCR inválido.');
  const manifest = await fetch('https://ghcr.io/v2/' + name + '/manifests/sha-' + revision, {
    method: 'HEAD', headers: { authorization: 'Bearer ' + token, accept: MANIFEST_ACCEPT },
    signal: AbortSignal.timeout(15000), redirect: 'error'
  });
  if (manifest.status === 404) throw new ImportError(404, 'Imagem do commit ainda não está publicada no GHCR.');
  if (!manifest.ok) throw new ImportError(502, 'GHCR não confirmou a imagem (' + manifest.status + ').');
  const digest = manifest.headers.get('docker-content-digest');
  if (!digest || !DIGEST_RE.test(digest)) throw new ImportError(502, 'GHCR não retornou digest SHA-256 válido.');
  return digest;
}
export async function dockerPullByDigest(reference: string): Promise<void> {
  if (!/^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+@sha256:[a-f0-9]{64}$/.test(reference))
    throw new ImportError(400, 'Somente referências GHCR com digest SHA-256 são permitidas.');
  const credentials = registryCredentials();
  const auth = Buffer.from(JSON.stringify(credentials ?
    { serveraddress: 'ghcr.io', username: credentials.username, password: credentials.password } :
    { serveraddress: 'ghcr.io' })).toString('base64');
  return new Promise<void>((resolve, reject) => {
    const req = http.request({
      socketPath: process.env['PANEL_DOCKER_SOCKET_PATH'] || '/run/panel-executor/docker.sock', method: 'POST',
      path: '/v1.45/images/create?fromImage=' + encodeURIComponent(reference),
      headers: { 'x-registry-auth': auth }, signal: AbortSignal.timeout(600000)
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new ImportError(502, 'Docker não iniciou a importação (' + response.statusCode + ').'));
        return;
      }
      let pending = '', settled = false;
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        if (settled) return;
        pending += chunk;
        if (pending.length > 131072) { settled = true; req.destroy(new Error('Resposta de progresso excessiva.')); return; }
        let newline: number;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            const value = JSON.parse(line) as { error?: string; errorDetail?: { message?: string } };
            if (value.error || value.errorDetail?.message) {
              settled = true;
              req.destroy(new ImportError(502, 'Docker recusou a importação da imagem.'));
              return;
            }
          } catch (error) {
            if (error instanceof ImportError) { settled = true; req.destroy(error); return; }
            settled = true; req.destroy(new ImportError(502, 'Progresso do Docker inválido.')); return;
          }
        }
      });
      response.on('end', () => {
        if (settled) return;
        if (pending.trim()) {
          try { const value = JSON.parse(pending) as { error?: string };
            if (value.error) { reject(new ImportError(502, 'Docker não conseguiu importar a imagem.')); return; }
          } catch { reject(new ImportError(502, 'Resposta incompleta do Docker.')); return; }
        }
        resolve();
      });
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}
async function approvedRun(call: typeof github, repo: LinkedRepository, runId: number): Promise<string> {
  const run = await call('/repos/' + repo.fullName + '/actions/runs/' + runId);
  if (!validSha(run.head_sha) || run.status !== 'completed' || run.conclusion !== 'success' ||
    run.head_branch !== repo.branch || run.path !== '.github/workflows/' + WORKFLOW ||
    run.repository?.full_name !== repo.fullName || run.head_repository?.full_name !== repo.fullName ||
    !['push', 'workflow_dispatch'].includes(run.event)) {
    throw new ImportError(422, 'Run GitHub não corresponde a um build aprovado para este projeto.');
  }
  return run.head_sha;
}
async function verifiedLocal(docker: DockerRequest, repo: string, revision: string, digest: string): Promise<string> {
  const ref = 'ghcr.io/' + repo.toLowerCase() + '@' + digest;
  const response: DockerResponse = await docker('/images/' + encodeURIComponent(ref) + '/json');
  if (response.status !== 200) throw new ImportError(502, 'Docker não confirmou a imagem baixada.');
  const image = JSON.parse(response.buffer.toString('utf8')) as {
    Id?: string; RepoDigests?: string[];
    Config?: { Labels?: Record<string, string>; Healthcheck?: { Test?: string[] } };
  };
  if (!image.Id || !DIGEST_RE.test(image.Id) || !image.RepoDigests?.includes(ref) ||
    image.Config?.Labels?.['org.opencontainers.image.source'] !== 'https://github.com/' + repo ||
    image.Config?.Labels?.['org.opencontainers.image.revision'] !== revision ||
    !Array.isArray(image.Config?.Healthcheck?.Test) ||
    image.Config.Healthcheck.Test.length < 1 || image.Config.Healthcheck.Test[0] === 'NONE') {
    throw new ImportError(422, 'Imagem baixada falhou na verificação de digest, origem, revisão ou HEALTHCHECK.');
  }
  return image.Id;
}
export async function handleImageImportRoute(req: IncomingMessage, res: ServerResponse, deps: Deps): Promise<boolean> {
  const path = new URL(req.url || '/', 'http://localhost').pathname;
  const match = /^\/projects\/([a-z0-9-]+)\/images\/import$/.exec(path);
  if (!match) return false;
  const slug = match[1];
  if (!slug) return false;
  const send = (status: number, data: unknown) => deps.send(res, status, data);
  const enabled = deps.enabled ?? process.env['PANEL_GHCR_PULL_ENABLED'] === '1';
  try {
    const project = readProjects(deps.dataDir).find(v => v.slug === slug);
    if (!project) throw new ImportError(404, 'Projeto não encontrado.');
    if (project.services.length !== 1 || project.services[0] !== slug)
      throw new ImportError(409, 'A importação atual aceita somente o serviço principal deste projeto.');
    const repository = (deps.repositories || (() => readRepositories(deps.dataDir)))()
      .find(v => v.fullName === project.repository && v.workflow === WORKFLOW);
    if (!repository) throw new ImportError(409, 'Repositório/workflow não autorizado.');
    if (req.method === 'GET') {
      const record = readImports(deps.dataDir).filter(v => v.slug === slug).at(-1) || null;
      send(200, { enabled, job: jobs.get(slug) || null, imported: record ? {
        revision: record.revision, digest: record.digest, importedAt: record.importedAt } : null });
      return true;
    }
    if (req.method !== 'POST') throw new ImportError(405, 'Método não permitido.');
    if (!enabled) throw new ImportError(403, 'Importação GHCR desativada.');
    const input = await deps.body(req);
    if (Object.keys(input).length !== 1 || !Number.isSafeInteger(input['runId']) || (input['runId'] as number) < 1)
      throw new ImportError(400, 'Informe apenas o ID inteiro do workflow.');
    if (active) throw new ImportError(409, 'Já existe uma importação em andamento.');
    const revision = await approvedRun(deps.githubRequest || github, repository, input['runId'] as number);
    const digest = await (deps.resolveDigest || resolveGhcrDigest)(repository.fullName, revision);
    if (!DIGEST_RE.test(digest)) throw new ImportError(502, 'Digest inválido retornado pelo GHCR.');
    if (active) throw new ImportError(409, 'Já existe uma importação em andamento.');
    const ref = 'ghcr.io/' + repository.fullName.toLowerCase() + '@' + digest;
    active = slug;
    const job: ImportJob = { slug, revision, digest, startedAt: new Date().toISOString(), status: 'running' };
    jobs.set(slug, job);
    const docker = deps.docker || dockerRequest;
    void (async () => {
      try {
        await (deps.pull || dockerPullByDigest)(ref);
        const id = await verifiedLocal(docker, repository.fullName, revision, digest);
        saveImport(deps.dataDir, { slug, repository: repository.fullName, revision, digest, imageId: id,
          runId: input['runId'] as number, importedAt: new Date().toISOString() });
        job.status = 'success'; job.message = 'Imagem importada por digest. Nenhum container foi alterado.';
      } catch (error) {
        console.error('GHCR import failed:', error instanceof Error ? error.message : String(error));
        job.status = 'error'; job.message = 'Falha na importação. Consulte os logs da API e tente novamente.';
      } finally { active = null; }
    })();
    send(202, { accepted: true, revision, digest, message: 'Importação iniciada; acompanhe pelo endpoint GET.' });
    return true;
  } catch (error) {
    if (error instanceof ImportError) send(error.status, { error: error.message });
    else if (error instanceof SyntaxError) send(400, { error: 'JSON inválido.' });
    else {
      console.error('GHCR import request failed:', error instanceof Error ? error.message : String(error));
      send(502, { error: 'Falha ao preparar importação do GHCR.' });
    }
    return true;
  }
}
