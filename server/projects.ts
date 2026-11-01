import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dockerRequest, inspectOwned, validSlug, AppError, type DockerRequest } from './apps.ts';
import { readRepositories, github, type LinkedRepository } from './github.ts';

export type ProjectBinding = {
  slug: string;
  repository: string;
  connectedAt: string;
  services: string[];
};
type Dependencies = {
  dataDir: string;
  send: (res: ServerResponse, status: number, data: unknown) => void;
  body: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  docker?: DockerRequest;
  repositories?: () => LinkedRepository[];
  githubRequest?: typeof github;
  buildsEnabled?: boolean;
};
const BUILD_WORKFLOW = 'panel-app-build.yml';
const MAX_PROJECTS = 8;
const MAX_SERVICES_PER_PROJECT = 8;

function validServices(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_SERVICES_PER_PROJECT &&
    value.every(validSlug) && new Set(value).size === value.length;
}

function servicesOf(value: Partial<ProjectBinding>): string[] {
  // Existing projects.json entries linked one container named after the project.
  return value.services === undefined ? [value.slug as string] : value.services;
}

function ownsServices(projects: ProjectBinding[], slug: string, services: string[]): boolean {
  return projects.some(project => project.slug !== slug &&
    services.some(service => project.services.includes(service)));
}

class ProjectError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function storeFile(dataDir: string): string {
  return join(dataDir, 'projects.json');
}
export function readProjects(dataDir: string): ProjectBinding[] {
  const file = storeFile(dataDir);
  if (!existsSync(file)) return [];
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed) || parsed.length > MAX_PROJECTS ||
    !parsed.every((value): value is ProjectBinding =>
      typeof value === 'object' && value !== null &&
      validSlug((value as ProjectBinding).slug) &&
      typeof (value as ProjectBinding).repository === 'string' &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test((value as ProjectBinding).repository) &&
      typeof (value as ProjectBinding).connectedAt === 'string' &&
      validServices(servicesOf(value as ProjectBinding)))) {
    throw new ProjectError(500, 'Dados de projetos inválidos.');
  }
  const projects = (parsed as ProjectBinding[]).map(project => ({
    ...project, services: servicesOf(project)
  }));
  if (projects.some(project => ownsServices(projects, project.slug, project.services)))
    throw new ProjectError(500, 'Um serviço pertence a mais de um projeto.');
  return projects;
}
function saveProjects(dataDir: string, items: ProjectBinding[]): void {
  const file = storeFile(dataDir);
  const temp = join(dataDir, 'projects-' + process.pid + '.tmp');
  writeFileSync(temp, JSON.stringify(items, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, file);
}
let mutationQueue: Promise<void> = Promise.resolve();
async function serialize<T>(callback: () => Promise<T>): Promise<T> {
  const old = mutationQueue;
  let release!: () => void;
  mutationQueue = new Promise<void>(resolve => { release = resolve; });
  await old;
  try { return await callback(); } finally { release(); }
}
export async function handleProjectRoute(req: IncomingMessage, res: ServerResponse, deps: Dependencies): Promise<boolean> {
  const path = new URL(req.url || '/', 'http://panel.local').pathname;
  if (path !== '/projects' && !path.startsWith('/projects/')) return false;
  const send = (status: number, data: unknown): void => deps.send(res, status, data);
  const docker = deps.docker || dockerRequest;
  const repositories = deps.repositories || (() => readRepositories(deps.dataDir));
  const githubCall = deps.githubRequest || github;
  const buildsEnabled = deps.buildsEnabled ?? process.env['PANEL_PROJECT_BUILDS_ENABLED'] === '1';
  try {
    if (path === '/projects' && req.method === 'GET') {
      const linked = repositories();
      send(200, {
        projects: readProjects(deps.dataDir).map(project => ({
          ...project,
          branch: linked.find(repo => repo.fullName === project.repository)?.branch ?? null,
          workflow: linked.find(repo => repo.fullName === project.repository)?.workflow ?? null
        })),
        buildsEnabled,
        requiredWorkflow: BUILD_WORKFLOW
      });
      return true;
    }
    if (path === '/projects' && req.method === 'POST') {
      const input = await deps.body(req);
      if (Object.keys(input).some(key => !['slug', 'repository', 'services'].includes(key)) ||
          !validSlug(input['slug']) || typeof input['repository'] !== 'string' ||
          (input['services'] !== undefined && !validServices(input['services']))) {
        throw new ProjectError(400, 'Informe uma aplicação e um repositório válido.');
      }
      const services = input['services'] === undefined ? [input['slug'] as string] : input['services'] as string[];
      for (const service of services) await inspectOwned(docker, service);
      const repo = repositories().find(item => item.fullName === input['repository']);
      if (!repo) throw new ProjectError(404, 'Conecte primeiro o repositório na aba Deploys.');
      const project = await serialize(async () => {
        const current = readProjects(deps.dataDir);
        if (current.some(item => item.slug === input['slug'])) throw new ProjectError(409, 'Aplicação já vinculada.');
        if (ownsServices(current, input['slug'] as string, services))
          throw new ProjectError(409, 'Serviço já vinculado a outro projeto.');
        if (current.length >= MAX_PROJECTS) throw new ProjectError(409, 'Limite de projetos atingido.');
        const newProject: ProjectBinding = {
          slug: input['slug'] as string, repository: repo.fullName,
          connectedAt: new Date().toISOString(), services
        };
        saveProjects(deps.dataDir, [...current, newProject]);
        return newProject;
      });
      console.log('Project linked:', project.slug, project.repository);
      send(201, { project });
      return true;
    }
    const match = /^\/projects\/([a-z0-9-]+)(?:\/(build|runs|services))?$/.exec(path);
    if (!match || !validSlug(match[1])) throw new ProjectError(404, 'Rota não encontrada.');
    const [, slug, action] = match;
    const project = readProjects(deps.dataDir).find(item => item.slug === slug);
    if (!project) throw new ProjectError(404, 'Projeto não encontrado.');
    if (action === 'services' && req.method === 'PUT') {
      const input = await deps.body(req);
      if (Object.keys(input).join(',') !== 'services' || !validServices(input['services']))
        throw new ProjectError(400, 'Informe uma lista válida de serviços.');
      const next = input['services'] as string[];
      // A removed service is detached from the project registry only. It is never
      // inspected, stopped or deleted, so retired images cannot block reconciliation.
      const updated = await serialize(async () => {
        const current = readProjects(deps.dataDir);
        const live = current.find(item => item.slug === slug);
        if (!live) throw new ProjectError(404, 'Projeto não encontrado.');
        if (ownsServices(current, slug, next))
          throw new ProjectError(409, 'Serviço já vinculado a outro projeto.');
        for (const service of next.filter(item => !live.services.includes(item)))
          await inspectOwned(docker, service);
        const entry = { ...live, services: next };
        saveProjects(deps.dataDir, current.map(item => item.slug === slug ? entry : item));
        return entry;
      });
      console.log('Project services updated:', slug, updated.services.join(','));
      send(200, { project: updated, message: 'Serviços vinculados; containers preservados.' });
      return true;
    }
    if (!action && req.method === 'DELETE') {
      await serialize(async () => {
        saveProjects(deps.dataDir, readProjects(deps.dataDir).filter(item => item.slug !== slug));
      });
      console.log('Project disconnected:', slug);
      send(200, { ok: true, message: 'Vínculo removido; o container foi preservado.' });
      return true;
    }
    if (action !== 'runs' && action !== 'build') throw new ProjectError(405, 'Método não permitido.');
    if (project.services.length !== 1 || project.services[0] !== slug)
      throw new ProjectError(409, 'O publicador atual aceita um único serviço principal. Configure um fluxo por projeto antes de publicar vários serviços.');
    const repository = repositories().find(item => item.fullName === project.repository);
    if (!repository) throw new ProjectError(409, 'O repositório não está mais conectado.');
    if (repository.workflow !== BUILD_WORKFLOW) {
      throw new ProjectError(409, 'Para compilar uma aplicação gerenciada, utilize o workflow panel-app-build.yml.');
    }
    if (action === 'runs' && req.method === 'GET') {
      const apiPath = '/repos/' + repository.fullName + '/actions/workflows/' +
        encodeURIComponent(repository.workflow) + '/runs?per_page=8&branch=' + encodeURIComponent(repository.branch);
      const data = await githubCall(apiPath);
      const workflowRuns = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
      send(200, { slug, runs: workflowRuns.map((run: any) => ({
        id: run.id, sha: run.head_sha, status: run.status,
        conclusion: run.conclusion, branch: run.head_branch,
        url: run.html_url, createdAt: run.created_at
      })) });
      return true;
    }
    if (action === 'build' && req.method === 'POST') {
      if (!buildsEnabled) throw new ProjectError(403, 'Builds de aplicações não habilitados na VPS.');
      // Revalidate ownership immediately before starting a build.
      await inspectOwned(docker, slug);
      const apiPath = '/repos/' + repository.fullName + '/actions/workflows/' +
        encodeURIComponent(repository.workflow) + '/dispatches';
      await githubCall(apiPath, 'POST', { ref: repository.branch });
      console.log('Application build requested:', slug, project.repository, repository.branch);
      send(202, {
        accepted: true, slug, repository: repository.fullName,
        message: 'GitHub recebeu o pedido de build. Nenhum container foi substituído.'
      });
      return true;
    }
    throw new ProjectError(405, 'Método não permitido.');
  } catch (error) {
    if (error instanceof ProjectError || error instanceof AppError) send(error.status, { error: error.message });
    else if (error instanceof SyntaxError) send(400, { error: 'JSON inválido.' });
    else {
      console.error('Project bridge failed:', error instanceof Error ? error.message : String(error));
      send(502, { error: 'Não foi possível executar a operação do projeto.' });
    }
    return true;
  }
}
