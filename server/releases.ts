import type { IncomingMessage, ServerResponse } from 'node:http';
import { dockerRequest, inspectOwned, managedContainerSpec, validResources, validSlug, AppError, type DockerRequest, type DockerResponse } from './apps.ts';
import { github, readRepositories, type LinkedRepository } from './github.ts';
import { readProjects } from './projects.ts';
import { readImports } from './image-import.ts';

type ReleaseDependencies = {
  dataDir: string;
  send: (res: ServerResponse, status: number, value: unknown) => void;
  body: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  docker?: DockerRequest;
  githubRequest?: typeof github;
  repositories?: () => LinkedRepository[];
  enabled?: boolean;
};
type Inspect = {
  Id: string; Name: string;
  Config?: { Image?: string; Labels?: Record<string, string> };
  State?: { Status?: string; Health?: { Status?: string } };
  HostConfig?: { Memory?: number; NanoCpus?: number; NetworkMode?: string };
};
type ImageInspect = {
  Id: string; RepoTags?: string[]; RepoDigests?: string[];
  Config?: { Labels?: Record<string, string>; Healthcheck?: { Test?: string[] } };
};
const OWNER = 'com.softload.panel.managed';
const SLUG = 'com.softload.panel.slug';
const REPOSITORY = 'com.softload.panel.repository';
const REVISION = 'com.softload.panel.revision';
const ROLE = 'com.softload.panel.release-role';
const PREFIX = 'softload-app-';
const CANDIDATE = 'softload-candidate-';
const BACKUP = 'softload-backup-';
const WORKFLOW = 'panel-app-build.yml';
export const validSha = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
class ReleaseError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function parse<T>(response: DockerResponse): T {
  return JSON.parse(response.buffer.toString('utf8')) as T;
}
async function optional(docker: DockerRequest, name: string): Promise<Inspect | null> {
  const response = await docker('/containers/' + encodeURIComponent(name) + '/json');
  if (response.status === 404) return null;
  if (response.status >= 400) throw new ReleaseError(502, 'Falha ao inspecionar container.');
  return parse<Inspect>(response);
}
function verifyBackup(inspect: Inspect, slug: string, repo: string): void {
  const labels = inspect.Config?.Labels;
  if (inspect.Name !== '/' + BACKUP + slug || labels?.[OWNER] !== 'true' || labels?.[SLUG] !== slug ||
    (labels[REPOSITORY] && labels[REPOSITORY] !== repo))
    throw new ReleaseError(403, 'Backup não pertence ao projeto gerenciado.');
}
function verifyRelease(inspect: Inspect, name: string, slug: string, repo: string, role: string): void {
  const labels = inspect.Config?.Labels;
  if (inspect.Name !== '/' + name || labels?.[OWNER] !== 'true' ||
    labels?.[SLUG] !== slug || labels?.[REPOSITORY] !== repo ||
    labels?.[ROLE] !== role || !validSha(labels?.[REVISION])) {
    throw new ReleaseError(403, 'Container de release não pertence a este projeto.');
  }
}
async function command(docker: DockerRequest, name: string, operation: 'start' | 'stop' | 'rename', value?: string): Promise<void> {
  const path = '/containers/' + encodeURIComponent(name) + '/' + operation +
    (operation === 'rename' ? '?name=' + encodeURIComponent(value || '') : operation === 'stop' ? '?t=10' : '');
  const response = await docker(path, 'POST');
  if (response.status < 200 || response.status >= 300)
    throw new ReleaseError(502, 'Docker não concluiu ' + operation + ' (' + response.status + ').');
}
let releaseQueue: Promise<void> = Promise.resolve();
async function locked<T>(callback: () => Promise<T>): Promise<T> {
  const prior = releaseQueue;
  let done!: () => void;
  releaseQueue = new Promise(resolve => { done = resolve; });
  await prior;
  try { return await callback(); } finally { done(); }
}
async function authenticatedBuild(call: typeof github, repo: LinkedRepository, runId: number): Promise<string> {
  const run = await call('/repos/' + repo.fullName + '/actions/runs/' + runId);
  const sha: unknown = run.head_sha;
  if (!validSha(sha) || run.status !== 'completed' || run.conclusion !== 'success' ||
    run.head_branch !== repo.branch || run.repository?.full_name !== repo.fullName ||
    run.head_repository?.full_name !== repo.fullName ||
    run.path !== '.github/workflows/' + WORKFLOW ||
    !['push', 'workflow_dispatch'].includes(run.event)) {
    throw new ReleaseError(422, 'Build não corresponde a um workflow aprovado e concluído com sucesso.');
  }
  return sha;
}
async function localVerifiedImage(docker: DockerRequest, repo: string, sha: string, dataDir: string, slug: string): Promise<{ id: string; image: string }> {
  const imported = readImports(dataDir).find(entry =>
    entry.repository === repo && entry.slug === slug && entry.revision === sha);
  if (!imported) throw new ReleaseError(422, 'Importe e valide a imagem GHCR por digest antes de preparar a release.');
  const tag = 'ghcr.io/' + repo.toLowerCase() + '@' + imported.digest;
  const result = await docker('/images/' + encodeURIComponent(tag) + '/json');
  if (result.status === 404) throw new ReleaseError(422, 'Imagem do build ainda não está na VPS. Importe pelo fluxo autorizado antes da preparação.');
  if (result.status >= 400) throw new ReleaseError(502, 'Não foi possível inspecionar a imagem.');
  const image = parse<ImageInspect>(result);
  const labels = image.Config?.Labels;
  if (!/^sha256:[a-f0-9]{64}$/.test(image.Id || '') ||
    image.Id !== imported.imageId || !image.RepoDigests?.includes(tag) ||
    labels?.['org.opencontainers.image.revision'] !== sha ||
    labels?.['org.opencontainers.image.source'] !== 'https://github.com/' + repo ||
    !Array.isArray(image.Config?.Healthcheck?.Test) ||
    image.Config.Healthcheck.Test.length === 0 ||
    image.Config.Healthcheck.Test[0] === 'NONE') {
    throw new ReleaseError(422, 'Imagem não possui identidade de origem, digest ou HEALTHCHECK verificável.');
  }
  return { id: image.Id, image: tag };
}
type RecoveryState = { state: 'ready' | 'recoverable' | 'manual_review'; repair: 'restore_backup' | 'restart_current' | null; detail: string };
function recoveryState(current: Inspect | null, candidate: Inspect | null, backup: Inspect | null): RecoveryState {
  if (!current && backup && backup.State?.Status !== 'running') {
    return { state: 'recoverable', repair: 'restore_backup', detail: 'Container principal ausente; backup anterior disponível para restauração.' };
  }
  if (current && !backup && current.State?.Status !== 'running') {
    return { state: 'recoverable', repair: 'restart_current', detail: 'Container principal parado, sem backup pendente. É possível reiniciá-lo.' };
  }
  if (current && current.State?.Status === 'running' && !(backup && candidate)) {
    return { state: 'ready', repair: null, detail: 'Container principal em execução; nenhuma recuperação automática necessária.' };
  }
  return { state: 'manual_review', repair: null, detail: 'Estado ambíguo. Não execute remoções ou renomeações sem revisar os três slots.' };
}

export async function handleReleaseRoute(req: IncomingMessage, res: ServerResponse, deps: ReleaseDependencies): Promise<boolean> {
  const path = new URL(req.url || '/', 'http://panel.local').pathname;
  const match = /^\/projects\/([a-z0-9-]+)\/releases(?:\/(stage|promote|rollback|finalize|recovery))?$/.exec(path);
  if (!match) return false;
  const send = (status: number, value: unknown) => deps.send(res, status, value);
  const docker = deps.docker || dockerRequest;
  const githubCall = deps.githubRequest || github;
  const enabled = deps.enabled ?? process.env['PANEL_RELEASES_ENABLED'] === '1';
  const slug = match[1], operation = match[2];
  try {
    if (!validSlug(slug)) throw new ReleaseError(404, 'Projeto inválido.');
    const project = readProjects(deps.dataDir).find(value => value.slug === slug);
    if (!project) throw new ReleaseError(404, 'Projeto não vinculado.');
    if (project.services.length !== 1 || project.services[0] !== slug)
      throw new ReleaseError(409, 'O publicador atual aceita somente o serviço principal deste projeto.');
    const repo = (deps.repositories || (() => readRepositories(deps.dataDir)))()
      .find(item => item.fullName === project.repository);
    if (!repo || repo.workflow !== WORKFLOW) throw new ReleaseError(409, 'Workflow GitHub do projeto não autorizado.');
    if (operation === 'recovery' && req.method === 'GET') {
      const current = await optional(docker, PREFIX + slug);
      const candidate = await optional(docker, CANDIDATE + slug);
      const backup = await optional(docker, BACKUP + slug);
      if (current) {
        const labels = current.Config?.Labels;
        if (current.Name !== '/' + PREFIX + slug || labels?.[OWNER] !== 'true' || labels?.[SLUG] !== slug)
          throw new ReleaseError(403, 'Slot principal não pertence ao painel.');
      }
      if (candidate) verifyRelease(candidate, CANDIDATE + slug, slug, project.repository, 'candidate');
      if (backup) verifyBackup(backup, slug, project.repository);
      send(200, { enabled, slug, ...recoveryState(current, candidate, backup),
        slots: { current: current?.State?.Status || null, candidate: candidate?.State?.Status || null,
          backup: backup?.State?.Status || null } });
      return true;
    }
    if (!operation && req.method === 'GET') {
      const current = await inspectOwned(docker, slug);
      const candidate = await optional(docker, CANDIDATE + slug);
      const backup = await optional(docker, BACKUP + slug);
      if (candidate) verifyRelease(candidate, CANDIDATE + slug, slug, project.repository, 'candidate');
      if (backup) verifyBackup(backup, slug, project.repository);
      send(200, { enabled, slug, current: { image: current.Config?.Image, state: current.State?.Status,
        revision: current.Config?.Labels?.[REVISION] || null },
        candidate: candidate ? { revision: candidate.Config?.Labels?.[REVISION], state: candidate.State?.Status,
          health: candidate.State?.Health?.Status || 'none' } : null,
        backup: backup ? { image: backup.Config?.Image, state: backup.State?.Status } : null });
      return true;
    }
    if (!enabled) throw new ReleaseError(403, 'Publicação na VPS desabilitada pelo administrador.');
    if (req.method !== 'POST' || !operation) throw new ReleaseError(405, 'Método não permitido.');
    if (operation === 'recovery') {
      const input = await deps.body(req);
      if (input['confirm'] !== 'RESTORE_SAFE_STATE' || Object.keys(input).length !== 1)
        throw new ReleaseError(400, 'Confirmação RESTORE_SAFE_STATE necessária.');
      const result = await locked(async () => {
        const current = await optional(docker, PREFIX + slug);
        const candidate = await optional(docker, CANDIDATE + slug);
        const backup = await optional(docker, BACKUP + slug);
        if (current) {
          const labels = current.Config?.Labels;
          if (current.Name !== '/' + PREFIX + slug || labels?.[OWNER] !== 'true' || labels?.[SLUG] !== slug)
            throw new ReleaseError(403, 'Slot principal não pertence ao painel.');
        }
        if (candidate) verifyRelease(candidate, CANDIDATE + slug, slug, project.repository, 'candidate');
        if (backup) verifyBackup(backup, slug, project.repository);
        const diagnosis = recoveryState(current, candidate, backup);
        if (diagnosis.repair === 'restore_backup' && backup) {
          if (candidate?.State?.Status === 'running') await command(docker, CANDIDATE + slug, 'stop');
          await command(docker, BACKUP + slug, 'rename', PREFIX + slug);
          await command(docker, PREFIX + slug, 'start');
          return { repaired: true, action: diagnosis.repair,
            message: 'Versão anterior restaurada. A candidata, se existente, ficou parada para inspeção.' };
        }
        if (diagnosis.repair === 'restart_current' && current) {
          await command(docker, PREFIX + slug, 'start');
          return { repaired: true, action: diagnosis.repair,
            message: 'Container principal reiniciado. Nenhuma versão foi substituída.' };
        }
        throw new ReleaseError(409, 'Este estado requer análise manual, não recuperação automática.');
      });
      console.log('Panel release recovery:', slug, result.action);
      send(200, result);
      return true;
    }
    const result = await locked(async () => {
      const current = await inspectOwned(docker, slug);
      const candidate = await optional(docker, CANDIDATE + slug);
      const backup = await optional(docker, BACKUP + slug);
      if (candidate) verifyRelease(candidate, CANDIDATE + slug, slug, project.repository, 'candidate');
      if (backup) verifyBackup(backup, slug, project.repository);
      if (operation === 'stage') {
        const input = await deps.body(req);
        if (Object.keys(input).some(key => key !== 'runId') ||
          !Number.isSafeInteger(input['runId']) || (input['runId'] as number) < 1) {
          throw new ReleaseError(400, 'Informe o ID numérico da execução do build.');
        }
        if (candidate || backup) throw new ReleaseError(409, 'Já existe candidata ou backup. Resolva a publicação anterior.');
        if (current.State?.Status !== 'running') throw new ReleaseError(409, 'A aplicação atual precisa estar em execução.');
        const sha = await authenticatedBuild(githubCall, repo, input['runId'] as number);
        const image = await localVerifiedImage(docker, project.repository, sha, deps.dataDir, slug);
        const labels = { [REPOSITORY]: project.repository, [REVISION]: sha, [ROLE]: 'candidate' };
        const inherited = { ramMb: (current.HostConfig?.Memory || 0) / 1048576,
          cpuCores: (current.HostConfig?.NanoCpus || 0) / 1_000_000_000 };
        const spec = managedContainerSpec(slug, image.id, labels,
          validResources(inherited) ? inherited : { ramMb: 256, cpuCores: 0.5 }, current.HostConfig?.NetworkMode);
        const create = await docker('/containers/create?name=' + encodeURIComponent(CANDIDATE + slug), 'POST', spec);
        if (create.status !== 201) throw new ReleaseError(502, 'Docker não criou candidata (' + create.status + ').');
        await command(docker, CANDIDATE + slug, 'start');
        return { staged: true, revision: sha, message: 'Candidata iniciada. Aguarde HEALTHCHECK saudável antes de promover.' };
      }
      if (operation === 'promote') {
        const input = await deps.body(req);
        if (Object.keys(input).some(key => key !== 'expectedRevision') ||
            (input['expectedRevision'] !== undefined && !validSha(input['expectedRevision'])))
          throw new ReleaseError(400, 'Revisão esperada inválida.');
        if (input['expectedRevision'] && candidate?.Config?.Labels?.[REVISION] !== input['expectedRevision'])
          throw new ReleaseError(409, 'A candidata não corresponde à revisão escolhida para publicação.');
        if (!candidate || backup) throw new ReleaseError(409, 'É necessário ter candidata e nenhum backup pendente.');
        if (current.State?.Status !== 'running') throw new ReleaseError(409, 'Container original precisa estar em execução.');
        if (candidate.State?.Status !== 'running' || candidate.State.Health?.Status !== 'healthy')
          throw new ReleaseError(409, 'Candidata ainda não está saudável (HEALTHCHECK).');
        await command(docker, PREFIX + slug, 'stop');
        try {
          await command(docker, PREFIX + slug, 'rename', BACKUP + slug);
          try {
            await command(docker, CANDIDATE + slug, 'rename', PREFIX + slug);
          } catch (error) {
            await command(docker, BACKUP + slug, 'rename', PREFIX + slug);
            throw error;
          }
        } catch (error) {
          try { await command(docker, PREFIX + slug, 'start'); }
          catch (recoveryError) { console.error('Recovery requires attention:', recoveryError); }
          throw error;
        }
        // The former container remains stopped as the rollback backup.
        return { promoted: true, revision: candidate.Config?.Labels?.[REVISION],
          message: 'Candidata promovida. Backup anterior preservado para rollback.' };
      }
      if (operation === 'rollback') {
        if (!backup || candidate) throw new ReleaseError(409, 'Rollback exige backup e slot de candidata livre.');
        if (current.Config?.Labels?.[ROLE] !== 'candidate' ||
          current.Config.Labels[REPOSITORY] !== project.repository)
          throw new ReleaseError(403, 'Container ativo não pertence a essa release.');
        if (current.State?.Status === 'running') await command(docker, PREFIX + slug, 'stop');
        try {
          await command(docker, PREFIX + slug, 'rename', CANDIDATE + slug);
          try {
            await command(docker, BACKUP + slug, 'rename', PREFIX + slug);
            await command(docker, PREFIX + slug, 'start');
          } catch (error) {
            const movedBack = await optional(docker, BACKUP + slug);
            if (movedBack) {
              try { await command(docker, CANDIDATE + slug, 'rename', PREFIX + slug); await command(docker, PREFIX + slug, 'start'); }
              catch (recoveryError) { console.error('Rollback recovery requires attention:', recoveryError); }
            }
            throw error;
          }
        } catch (error) { throw error; }
        return { rolledBack: true, message: 'Versão anterior restaurada; a candidata permanece parada para diagnóstico.' };
      }
      if (operation === 'finalize') {
        const input = await deps.body(req);
        if (input['confirm'] !== 'DELETE_BACKUP' || Object.keys(input).some(key => key !== 'confirm'))
          throw new ReleaseError(400, 'Confirmação explícita DELETE_BACKUP necessária.');
        if (backup && candidate) throw new ReleaseError(409, 'Rollback pendente. Resolva a candidata antes de finalizar.');
        if (!backup && !candidate) throw new ReleaseError(404, 'Sem backup ou candidata para finalizar.');
        const target = backup || candidate!;
        if (target.State?.Status === 'running')
          throw new ReleaseError(409, 'Não é permitido descartar um container em execução.');
        const response = await docker('/containers/' + encodeURIComponent(target.Id) + '?force=0&v=0', 'DELETE');
        if (response.status !== 204) throw new ReleaseError(502, 'Docker não descartou o container.');
        return { finalized: true, removed: target.Name, message: 'Slot de rollback liberado.' };
      }
      throw new ReleaseError(404, 'Operação inexistente.');
    });
    console.log('Panel release operation:', operation, slug, project.repository);
    send(200, result);
  } catch (error) {
    if (error instanceof ReleaseError || error instanceof AppError) send(error.status, { error: error.message });
    else if (error instanceof SyntaxError) send(400, { error: 'JSON inválido.' });
    else {
      console.error('Panel release error:', error instanceof Error ? error.message : String(error));
      send(502, { error: 'Operação de release falhou. Verifique estado dos containers antes de repetir.' });
    }
  }
  return true;
}
