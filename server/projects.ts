import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dockerRequest, inspectOwned, validSlug, type DockerRequest } from './apps.ts';
import { readRepositories, github, type LinkedRepository } from './github.ts';

export type ProjectBinding = {
  slug: string;
  repository: string;
  connectedAt: string;
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
      typeof (value as ProjectBinding).connectedAt === 'string')) {
    throw new ProjectError(500, 'Dados de projetos inválidos.');
  }
  return parsed;
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
  const buildsEnabled = deps.buildsEnabled ?? process.env.PANEL_PROJECT_BUILDS_ENABLED === '1';
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
      if (Object.keys(input).some(key => key !== 'slug' && key !== 'repository') ||
          !validSlug(input.slug) || typeof input.repository !== 'string') {
        throw new ProjectError(400, 'Informe uma aplicação e um repositório válido.');
      }
      await inspectOwned(docker, input.slug);
      const repo = repositories().find(item => item.fullName === input.repository);
      if (!repo) throw new ProjectError(404, 'Conecte primeiro o repositório na aba Deploys.');
      const project = await serialize(async () => {
        const current = readProjects(deps.dataDir);
        if (current.some(item => item.slug === input.slug)) throw new ProjectError(409, 'Aplicação já vinculada.');
        if (current.length >= MAX_PROJECTS) throw new ProjectError(409, 'Limite de projetos atingido.');
        const newProject: ProjectBinding = {
          slug: input.slug as string, repository: repo.fullName, connectedAt: new Date().toISOString()
        };
        saveProjects(deps.dataDir, [...current, newProject]);
        return newProject;
      });
      console.log('Project linked:', project.slug, project.repository);
      send(201, { project });
      return true;
    }
    const match = /^\/projects\/([a-z0-9-]+)(?:\/(build|runs))?$/.exec(path);
    if (!match || !validSlug(match[1])) throw new ProjectError(404, 'Rota não encontrada.');
    const [, slug, action] = match;
    const project = readProjects(deps.dataDir).find(item => item.slug === slug);
    if (!project) throw new ProjectError(404, 'Projeto não encontrado.');
    if (!action && req.method === 'DELETE') {
      await serialize(async () => {
        saveProjects(deps.dataDir, readProjects(deps.dataDir).filter(item => item.slug !== slug));
      });
      console.log('Project disconnected:', slug);
      send(200, { ok: true, message: 'Vínculo removido; o container foi preservado.' });
      return true;
    }
    if (action !== 'runs' && action !== 'build') throw new ProjectError(405, 'Método não permitido.');
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
    if (error instanceof ProjectError) send(error.status, { error: error.message });
    else if (error instanceof SyntaxError) send(400, { error: 'JSON inválido.' });
    else {
      console.error('Project bridge failed:', error instanceof Error ? error.message : String(error));
      send(502, { error: 'Não foi possível executar a operação do projeto.' });
    }
    return true;
  }
}
