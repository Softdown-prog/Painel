interface Repo { fullName: string; branch: string; workflow: string }
interface Run { id: number; sha: string; branch: string; status: string; conclusion: string | null; createdAt: string }
let githubRepos: Repo[] = [];
let githubTokenAvailable = false;
function ge(id: string): HTMLInputElement {
  const result = document.getElementById(id);
  if (!result) throw new Error('Elemento não encontrado: ' + id);
  return result as HTMLInputElement;
}
function gn(message: string): void { ge('githubNotice').textContent = message; }
async function ga(path: string, options: RequestInit = {}): Promise<any> {
  const response = await fetch('/api' + path, { credentials: 'same-origin', cache: 'no-store', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'GitHub HTTP ' + response.status);
  return data;
}
function selected(): Repo | undefined {
  return githubRepos.find(item => item.fullName === ge('githubRepoSelect').value);
}
function controlButtons(): void {
  ge('githubConnectButton').disabled = !githubTokenAvailable;
  ge('githubDeployButton').disabled = !githubTokenAvailable || !selected();
  ge('githubDisconnectButton').disabled = !selected();
}
async function showRuns(): Promise<void> {
  const target = ge('githubRuns');
  target.replaceChildren();
  const repo = selected();
  if (!repo) { target.textContent = 'Nenhum repositório conectado.'; return; }
  target.textContent = 'Consultando execuções...';
  try {
    const response = await ga('/repositories/' + repo.fullName + '/runs');
    const runs = response.runs as Run[];
    target.replaceChildren();
    if (!runs.length) target.textContent = 'Nenhuma execução encontrada para essa branch.';
    for (const run of runs) {
      const row = document.createElement('div');
      row.className = 'github-run';
      const link = document.createElement('a');
      link.href = 'https://github.com/' + repo.fullName + '/actions/runs/' + encodeURIComponent(String(run.id));
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = '#' + run.id + ' · ' + (run.sha?.slice(0, 8) || 'sem SHA');
      const status = document.createElement('small');
      status.textContent = (run.conclusion || run.status) + ' · ' + (run.branch || repo.branch) + ' · ' + new Date(run.createdAt).toLocaleString('pt-BR');
      row.append(link, status);
      target.append(row);
    }
  } catch (error) { target.textContent = error instanceof Error ? error.message : 'Falha ao consultar execuções.'; }
}
async function refreshGitHubRepositories(): Promise<void> {
  try {
    const response = await ga('/repositories');
    githubRepos = response.repositories as Repo[];
    githubTokenAvailable = Boolean(response.tokenConfigured);
    const chooser = ge('githubRepoSelect');
    const previous = chooser.value;
    chooser.replaceChildren();
    for (const repo of githubRepos) {
      const option = document.createElement('option');
      option.value = repo.fullName;
      option.textContent = repo.fullName + ' · ' + repo.branch + ' · ' + repo.workflow;
      chooser.append(option);
    }
    if (githubRepos.some(repo => repo.fullName === previous)) chooser.value = previous;
    controlButtons();
    gn(githubTokenAvailable ? 'GitHub conectado. O deploy é executado pelo workflow do repositório.' : 'Leitura disponível. Para conectar projetos ou publicar, configure a credencial GitHub na VPS.');
    await showRuns();
  } catch (error) { gn(error instanceof Error ? error.message : 'Não foi possível carregar os repositórios.'); }
}
Object.assign(window, { refreshGitHubRepositories });
ge('githubRepoSelect').addEventListener('change', () => { controlButtons(); showRuns(); });
ge('githubReloadButton').addEventListener('click', refreshGitHubRepositories);
ge('githubConnectForm').addEventListener('submit', async event => {
  event.preventDefault();
  ge('githubConnectButton').disabled = true;
  try {
    const fullName = ge('githubRepoInput').value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git\/?$/, '').replace(/\/$/, '');
    const branch = ge('githubBranchInput').value.trim();
    const workflow = ge('githubWorkflowInput').value.trim();
    await ga('/repositories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fullName, branch, workflow }) });
    await refreshGitHubRepositories();
    ge('githubRepoSelect').value = fullName;
    controlButtons();
    await showRuns();
    gn('Conectado: ' + fullName);
  } catch (error) { gn(error instanceof Error ? error.message : 'Erro ao conectar repositório.'); }
  finally { controlButtons(); }
});
ge('githubDeployButton').addEventListener('click', async () => {
  const repo = selected();
  if (!repo || !confirm('Solicitar ' + repo.workflow + ' em ' + repo.fullName + ' (' + repo.branch + ')?')) return;
  ge('githubDeployButton').disabled = true;
  try {
    await ga('/repositories/' + repo.fullName + '/deploy', { method: 'POST' });
    gn('Solicitação aceita pelo GitHub. Atualize o histórico para acompanhar a execução.');
    await showRuns();
  } catch (error) { gn(error instanceof Error ? error.message : 'Erro ao solicitar deploy.'); }
  finally { controlButtons(); }
});
ge('githubDisconnectButton').addEventListener('click', async () => {
  const repo = selected();
  if (!repo || !confirm('Desconectar ' + repo.fullName + ' do painel? Os containers não serão apagados.')) return;
  try {
    await ga('/repositories/' + repo.fullName, { method: 'DELETE' });
    await refreshGitHubRepositories();
    gn('Conexão removida. Nenhum container foi alterado.');
  } catch (error) { gn(error instanceof Error ? error.message : 'Erro ao desconectar repositório.'); }
});
if (location.hash === '#deploys') refreshGitHubRepositories();
