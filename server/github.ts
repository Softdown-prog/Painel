import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type LinkedRepository = {
  fullName: string;
  branch: string;
  workflow: string;
};
type ApiResponse = { status: number; data: unknown };
type Dependencies = {
  dataDir: string;
  send: (res: ServerResponse, status: number, data: unknown) => void;
  body: (req: IncomingMessage) => Promise<Record<string, unknown>>;
};
const initial: LinkedRepository = { fullName: 'Softdown-prog/Softloadv4', branch: 'main', workflow: 'deploy.yml' };
const allowedOwner = process.env.PANEL_GITHUB_ALLOWED_OWNER || 'Softdown-prog';

function token(): string | null {
  try {
    const secret = readFileSync(process.env.PANEL_GITHUB_TOKEN_FILE || '/run/secrets/github-token', 'utf8').trim();
    return secret || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export function validRepository(fullName: unknown): fullName is string {
  if (typeof fullName !== 'string') return false;
  const pieces = fullName.split('/');
  return pieces.length === 2 && pieces[0] === allowedOwner &&
    /^[A-Za-z0-9_.-]{1,100}$/.test(pieces[1]) && pieces[1] !== '.' && pieces[1] !== '..';
}
export function validRef(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 &&
    /^(?!\/|.*\.\.)(?!.*\/\/)[A-Za-z0-9_./-]+$/.test(value) && !value.endsWith('/');
}
export function validWorkflow(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}\.ya?ml$/.test(value);
}
function repositoryFile(dataDir: string): string { return join(dataDir, 'github-repositories.json'); }
function readRepositories(dataDir: string): LinkedRepository[] {
  const path = repositoryFile(dataDir);
  if (!existsSync(path)) return [initial];
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed) || !parsed.every((r: unknown) => typeof r === 'object' && r !== null &&
    validRepository((r as LinkedRepository).fullName) && validRef((r as LinkedRepository).branch) &&
    validWorkflow((r as LinkedRepository).workflow))) throw new Error('Configuração de repositórios inválida');
  return parsed as LinkedRepository[];
}
function saveRepositories(dataDir: string, repositories: LinkedRepository[]): void {
  const target = repositoryFile(dataDir);
  const temp = join(dataDir, 'github-repositories.' + process.pid + '.tmp');
  writeFileSync(temp, JSON.stringify(repositories, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, target);
}
class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
async function github(path: string, method = 'GET', payload?: object): Promise<any> {
  const secret = token();
  if (method !== 'GET' && !secret) throw new GitHubError(503, 'Configure o token do GitHub na VPS para habilitar alterações.');
  const response = await fetch('https://api.github.com' + path, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'softload-console',
      'x-github-api-version': '2022-11-28',
      ...(secret ? { authorization: 'Bearer ' + secret } : {}),
      ...(payload ? { 'content-type': 'application/json' } : {})
    },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    if (response.status === 401) throw new GitHubError(503, 'Credencial GitHub inválida ou expirada.');
    if (response.status === 403) throw new GitHubError(403, 'A credencial não tem acesso ou permissão suficiente no GitHub.');
    if (response.status === 404) throw new GitHubError(404, 'Repositório, branch ou workflow não encontrado ou sem acesso.');
    if (response.status === 422) throw new GitHubError(422, 'O workflow precisa aceitar workflow_dispatch e existir na branch padrão.');
    throw new GitHubError(502, 'GitHub indisponível (HTTP ' + response.status + ').');
  }
  return response.status === 204 ? null : response.json();
}
export async function handleGitHubRoute(req: IncomingMessage, res: ServerResponse, deps: Dependencies): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;
  if (!path.startsWith('/repositories')) return false;
  const send = (status: number, data: unknown): void => deps.send(res, status, data);
  try {
    if (path === '/repositories' && req.method === 'GET') {
      send(200, { repositories: readRepositories(deps.dataDir), tokenConfigured: Boolean(token()), allowedOwner });
      return true;
    }
    if (path === '/repositories' && req.method === 'POST') {
      if (!token()) throw new GitHubError(503, 'Configure primeiro o token do GitHub na VPS.');
      const input = await deps.body(req);
      const { fullName, branch = 'main', workflow = 'deploy.yml' } = input;
      if (!validRepository(fullName) || !validRef(branch) || !validWorkflow(workflow))
        throw new GitHubError(400, 'Informe repositório, branch e workflow válidos do proprietário autorizado.');
      const repoPath = '/repos/' + fullName;
      await github(repoPath);
      await github(repoPath + '/branches/' + encodeURIComponent(branch));
      const details = await github(repoPath + '/actions/workflows/' + encodeURIComponent(workflow));
      if (details.state !== 'active') throw new GitHubError(409, 'Workflow não está ativo.');
      const existing = readRepositories(deps.dataDir);
      if (existing.some(item => item.fullName.toLowerCase() === fullName.toLowerCase()))
        throw new GitHubError(409, 'Repositório já conectado.');
      const item = { fullName, branch, workflow };
      saveRepositories(deps.dataDir, [...existing, item]);
      console.log('GitHub repository linked: ' + fullName);
      send(201, { repository: item });
      return true;
    }
    const match = /^\/repositories\/([^/]+)\/([^/]+)(?:\/(deploy|runs))?$/.exec(path);
    if (!match) { send(404, { error: 'Rota não encontrada' }); return true; }
    const fullName = match[1] + '/' + match[2];
    if (!validRepository(fullName)) throw new GitHubError(400, 'Repositório inválido.');
    const linked = readRepositories(deps.dataDir);
    const repo = linked.find(item => item.fullName.toLowerCase() === fullName.toLowerCase());
    if (!repo) throw new GitHubError(404, 'Conecte este repositório antes de operá-lo.');
    if (!match[3] && req.method === 'DELETE') {
      saveRepositories(deps.dataDir, linked.filter(item => item !== repo));
      console.log('GitHub repository disconnected: ' + fullName);
      send(200, { ok: true });
      return true;
    }
    const root = '/repos/' + repo.fullName + '/actions/workflows/' + encodeURIComponent(repo.workflow);
    if (match[3] === 'runs' && req.method === 'GET') {
      const data = await github(root + '/runs?per_page=10&branch=' + encodeURIComponent(repo.branch));
      send(200, { runs: (data.workflow_runs || []).map((run: any) => ({
        id: run.id, sha: run.head_sha, branch: run.head_branch, status: run.status,
        conclusion: run.conclusion, createdAt: run.created_at, url: run.html_url
      })) });
      return true;
    }
    if (match[3] === 'deploy' && req.method === 'POST') {
      await github(root + '/dispatches', 'POST', { ref: repo.branch });
      console.log('GitHub workflow dispatched: ' + fullName + ' ' + repo.workflow + ' ' + repo.branch);
      send(202, { accepted: true, message: 'GitHub aceitou o pedido; acompanhe a execução no histórico.' });
      return true;
    }
    send(405, { error: 'Método não permitido' });
    return true;
  } catch (error) {
    if (error instanceof GitHubError) send(error.status, { error: error.message });
    else if (error instanceof SyntaxError) send(400, { error: 'JSON inválido' });
    else {
      console.error('GitHub integration error:', error instanceof Error ? error.message : String(error));
      send(502, { error: 'Não foi possível consultar o GitHub.' });
    }
    return true;
  }
}
