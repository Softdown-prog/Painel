const demoServices = [
  { id: 'app', name: 'Backend principal', detail: 'API e aplicação web', icon: 'S' },
  { id: 'agent', name: 'Agent Worker', detail: 'Processamento de tarefas', icon: '◇' },
  { id: 'sandbox', name: 'Sandbox', detail: 'Execução isolada', icon: '▣' },
  { id: 'embeddings', name: 'Embeddings', detail: 'Busca semântica', icon: '⌁' },
  { id: 'caddy', name: 'Caddy', detail: 'Proxy reverso', icon: '◈' },
  { id: 'portainer', name: 'Portainer', detail: 'Painel legado', icon: '◫' }
];
const labels = Object.fromEntries(demoServices.map(service => [service.id, service]));
let authenticated = false;
let setupMode = false;
let toastTimer;

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', cache: 'no-store', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== '/login') showAuth(false);
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4500);
}
function setBanner(message, live = false) {
  const banner = document.getElementById('demoBanner');
  banner.classList.toggle('live', live);
  document.getElementById('bannerText').textContent = message;
}
function showAuth(setup) {
  authenticated = false;
  setupMode = setup;
  document.getElementById('authOverlay').hidden = false;
  document.getElementById('logoutButton').hidden = true;
  document.getElementById('setupLabel').hidden = !setup;
  document.getElementById('usernameLabel').hidden = setup;
  document.getElementById('username').required = !setup;
  document.getElementById('setupToken').required = setup;
  document.getElementById('password').autocomplete = setup ? 'new-password' : 'current-password';
  document.getElementById('authHeading').textContent = setup ? 'Criar acesso administrativo' : 'Entrar no painel';
  document.getElementById('authDescription').textContent = setup ? 'Digite o código inicial guardado na VPS e crie sua senha. Esse código só funciona uma vez.' : 'Use sua conta administrativa para acessar os dados reais da VPS.';
  document.getElementById('authSubmit').textContent = setup ? 'Criar senha' : 'Entrar';
  document.getElementById('authError').textContent = '';
  document.getElementById(setup ? 'setupToken' : 'username').focus();
}
function serviceRow(service, allowActions = false) {
  const row = document.createElement('div');
  row.className = 'service-row';
  const icon = document.createElement('span');
  icon.className = 'service-symbol';
  icon.textContent = labels[service.id]?.icon || '◫';
  const main = document.createElement('span');
  main.className = 'service-main';
  const name = document.createElement('strong');
  name.textContent = labels[service.id]?.name || service.name;
  const detail = document.createElement('small');
  detail.textContent = authenticated ? `${service.status} · ${service.image || 'sem imagem'}` : service.detail;
  main.append(name, detail);
  const state = document.createElement('span');
  state.className = 'service-state';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = service.state === 'running' ? '#65d6a4' : '#e4b077';
  state.append(dot, authenticated ? (service.state === 'running' ? 'Ativo' : service.state) : 'Exemplo');
  row.append(icon, main, state);
  if (allowActions && authenticated && service.controllable) {
    const actions = document.createElement('span');
    actions.className = 'service-actions';
    const options = service.state === 'running' ? [['restart', 'Reiniciar'], ['stop', 'Parar']] : [['start', 'Iniciar']];
    for (const [action, title] of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = title;
      button.addEventListener('click', async () => {
        if (!confirm(`${title} ${name.textContent}? Essa ação afeta o serviço na VPS.`)) return;
        button.disabled = true;
        try {
          await api(`/services/${service.id}/${action}`, { method: 'POST' });
          toast(`${name.textContent}: ${title.toLowerCase()} solicitado.`);
          setTimeout(loadOverview, 1500);
        } catch (error) { toast(error.message); }
        finally { button.disabled = false; }
      });
      actions.append(button);
    }
    row.append(actions);
  }
  return row;
}
function fillServices(services) {
  const overview = document.getElementById('overviewServices');
  const all = document.getElementById('allServices');
  overview.replaceChildren(...services.slice(0, 4).map(service => serviceRow(service)));
  all.replaceChildren(...services.map(service => serviceRow(service, true)));
}
function gb(value) { return (value / 1073741824).toFixed(1); }
async function loadOverview() {
  if (!authenticated) return;
  try {
    const data = await api('/overview');
    const services = data.services || [];
    fillServices(services);
    const running = services.filter(service => service.state === 'running').length;
    document.getElementById('serviceCount').innerHTML = `${running} <span>/ ${services.length}</span>`;
    document.getElementById('serviceFoot').textContent = `Atualizado ${new Date(data.updatedAt).toLocaleTimeString('pt-BR')}`;
    document.getElementById('memoryValue').innerHTML = `${gb(data.memory.used)} <span>GB / ${gb(data.memory.total)} GB</span>`;
    document.getElementById('memoryBar').style.width = `${Math.min(100, Math.round(data.memory.used / data.memory.total * 100))}%`;
    const loadPercent = Math.round(data.cpu.load1 / data.cpu.cores * 100);
    document.getElementById('cpuValue').innerHTML = `${loadPercent}<span>%</span>`;
    if (data.disk?.total > 0) {
      document.getElementById('diskValue').innerHTML = `${gb(data.disk.used)} <span>GB / ${gb(data.disk.total)} GB</span>`;
      document.getElementById('diskBar').style.width = `${Math.min(100, Math.round(data.disk.used / data.disk.total * 100))}%`;
      document.getElementById('diskDetail').textContent = `${gb(data.disk.available)} GB livres · imagens Docker: ${gb(data.imagesBytes)} GB`;
    } else {
      document.getElementById('diskValue').textContent = 'Indisponível';
      document.getElementById('diskBar').style.width = '0%';
      document.getElementById('diskDetail').textContent = 'O servidor não informou a capacidade do disco';
    }
    document.querySelectorAll('.live-label').forEach(el => el.textContent = 'AO VIVO');
    document.getElementById('topStatus').lastChild.textContent = ' VPS conectada';
    document.getElementById('apiStatus').textContent = '● API conectada';
    document.getElementById('authStatus').textContent = '● Sessão ativa';
    document.getElementById('servicesTag').textContent = 'AO VIVO';
    document.querySelector('.connection-card strong').textContent = 'VPS conectada';
    document.querySelector('.connection-card small').textContent = 'API administrativa ativa';
    setBanner(`VPS conectada · Revisão configurada ${data.currentSha?.slice(0, 8) || 'não disponível'} · Confira a imagem em Publicações.`, true);
  } catch (error) { toast(`Não foi possível atualizar a VPS: ${error.message}`); }
}
const deployStatusLabels = Object.freeze({
  active: 'IMAGEM ATIVA · HTTPS NÃO CONFERIDO',
  published: 'DOCKER + /HEALTH CONFERIDOS',
  'public-mismatch': 'IMAGEM ATIVA · SITE DIVERGENTE',
  superseded: 'CONCLUÍDO · OUTRA VERSÃO ATIVA',
  unconfirmed: 'CONCLUÍDO · ATIVAÇÃO NÃO CONFIRMADA',
  queued: 'NA FILA',
  building: 'EM EXECUÇÃO NO GITHUB',
  cancelled: 'CANCELADO',
  failed: 'FALHOU',
  unknown: 'ESTADO DESCONHECIDO'
});
function deployState(run, runtime, publicHealth = null) {
  // Older backends never prove a deployment from the .env SHA alone.
  if (run.status === 'queued' || run.status === 'pending' || run.status === 'waiting') return 'queued';
  if (run.status === 'in_progress') return 'building';
  if (run.conclusion === 'cancelled') return 'cancelled';
  if (run.conclusion === 'failure') return 'failed';
  if (run.conclusion !== 'success' || run.status !== 'completed') return 'unknown';
  if (runtime?.app?.status !== 'verified') return 'unconfirmed';
  if (run.sha !== runtime.app.revision) return 'superseded';
  if (publicHealth?.status === 'matched') return 'published';
  if (publicHealth?.status === 'different') return 'public-mismatch';
  return 'active';
}
function deployLabel(run, runtime, publicHealth = null) {
  return deployStatusLabels[deployState(run, runtime, publicHealth)];
}
function renderDeployRuntime(runtime, configuredSha, publicHealth = null) {
  const host = document.getElementById('deployRuntimeDetails');
  host.replaceChildren();
  const heading = document.createElement('strong');
  if (!runtime || runtime.app?.status !== 'verified') {
    heading.textContent = 'Revisão da aplicação ainda não confirmada pelo Docker';
    host.append(heading);
    const reason = document.createElement('p');
    reason.textContent = 'A versão configurada no arquivo da VPS não comprova que o container esteja executando essa imagem. ' +
      'Confira a API/executor ou aguarde o deploy antes de concluir.';
    host.append(reason);
  } else {
    heading.textContent = 'Aplicação em execução · ' + runtime.app.revision.slice(0,12);
    host.append(heading);
    const message = document.createElement('p');
    message.textContent = runtime.configuredMatchesRunning === false ?
      'A revisão registrada no arquivo de ambiente é diferente da imagem em execução. O Docker é a referência para esta tela.' :
      'A revisão foi confirmada pela imagem do container da aplicação na VPS.';
    host.append(message);
  }
  const configured = document.createElement('small');
  configured.textContent = 'Referência em /host/softload.env: ' +
    (runtime?.configuredSha || configuredSha || 'não disponível') +
    ' · Validação do site público: não incluída nesta verificação';
  host.append(configured);
  const publicLine = document.createElement('p');
  publicLine.className = 'deploy-public-health';
  if (publicHealth?.status === 'matched') {
    publicLine.textContent = 'HTTPS público conferido: /health confirma a revisão em execução no Docker (' +
      publicHealth.revision.slice(0, 12) + ').';
  } else if (publicHealth?.status === 'different') {
    publicLine.textContent = 'ATENÇÃO: o site público informa a revisão ' + publicHealth.revision.slice(0,12) +
      ', mas o Docker está executando ' + (runtime?.app?.revision?.slice(0,12) || 'não confirmada') +
      '. Verifique o roteamento e o deploy antes de declarar sucesso.';
  } else if (publicHealth?.status === 'observed') {
    publicLine.textContent = 'O site público informa a revisão ' + publicHealth.revision.slice(0,12) +
      ', porém a revisão Docker ainda não foi confirmada.';
  } else {
    publicLine.textContent = 'Verificação pública HTTPS indisponível ou não instalada na API. ' +
      'Isso não significa que o site esteja fora do ar.';
  }
  host.append(publicLine);
  const publicScope = document.createElement('small');
  publicScope.textContent = 'Verificação pública limitada ao /health. Arquivos JavaScript e outras rotas não foram testados nesta consulta.';
  host.append(publicScope);
  if (!runtime?.services) return;
  const list = document.createElement('div');
  list.className = 'deploy-runtime-services';
  const titles = { app: 'Aplicação', agent: 'Agente', sandbox: 'Sandbox', embeddings: 'Embeddings' };
  for (const id of ['app','agent','sandbox','embeddings']) {
    const item = runtime.services[id];
    if (!item) continue;
    const line = document.createElement('div');
    const label = document.createElement('strong');
    label.textContent = titles[id];
    const detail = document.createElement('span');
    detail.textContent = item.status === 'verified'
      ? 'Em execução · ' + item.revision.slice(0,12)
      : item.status === 'stopped' ? 'Parado'
      : item.status === 'missing' ? 'Container não encontrado'
      : 'Revisão não verificável';
    line.append(label,detail);
    list.append(line);
  }
  host.append(list);
}
function deployRow(run, runtime, publicHealth = null) {
  const row = document.createElement('div');
  row.className = 'deploy-row';
  const revision = document.createElement('span');
  const link = document.createElement('a');
  link.href = run.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  const title = document.createElement('strong');
  title.textContent = run.sha?.slice(0, 8) || 'Revisão';
  link.append(title);
  const sub = document.createElement('small');
  sub.textContent = `Run #${run.id}`;
  revision.append(link, sub);
  const origin = document.createElement('span');
  origin.textContent = `${run.branch || 'main'} · GitHub Actions`;
  const status = document.createElement('span');
  const badge = document.createElement('i');
  badge.className = 'status-badge';
  badge.textContent = deployLabel(run, runtime, publicHealth);
  if (deployState(run, runtime, publicHealth) === 'published') badge.classList.add('success-badge');
  status.append(badge);
  const time = document.createElement('span');
  time.textContent = new Date(run.createdAt).toLocaleString('pt-BR');
  row.append(revision, origin, status, time);
  return row;
}
async function loadDeploys() {
  if (!authenticated) return;
  try {
    const [data, overview] = await Promise.all([api('/deploys'), api('/overview')]);
    const runningServices = (overview.services || []).filter(service => ['app', 'agent', 'sandbox', 'embeddings'].includes(service.id) && service.state === 'running').length;
    const activeRun = (data.runs || []).find(run => ['queued', 'pending', 'waiting', 'in_progress'].includes(run.status));
    const vpsState = runningServices === 0 ? 'Em repouso' : runningServices === 4 ? 'Ativa' : 'Inicializando ou parcialmente ativa';
    const runtime = data.runtime || null;
    const appSha = runtime?.app?.status === 'verified' ? runtime.app.revision : null;
    const githubState = activeRun ? (activeRun.status === 'in_progress' ? `GitHub executando ${activeRun.sha?.slice(0, 8)}` : `GitHub com ${activeRun.sha?.slice(0, 8)} na fila`) :
      !appSha ? 'Imagem da aplicação ainda não verificada' :
      data.runs?.[0]?.sha === appSha ? 'Último workflow corresponde ao Docker' :
      'Uma revisão diferente está em execução na VPS';
    document.getElementById('deployedRevision').textContent = `VPS ${vpsState} · Imagem da aplicação: ${appSha?.slice(0, 12) || 'não confirmada'} · ${githubState}`;
    const publicHealth = data.publicHealth || null;
    renderDeployRuntime(runtime, data.currentSha, publicHealth);
    document.getElementById('deployTag').textContent = activeRun ? 'DEPLOY EM CURSO' :
      publicHealth?.status === 'different' ? 'SITE DIVERGENTE' :
      publicHealth?.status === 'matched' ? '/HEALTH PÚBLICO CONFERIDO' :
      appSha ? 'IMAGEM VERIFICADA' : 'REVISÃO NÃO CONFIRMADA';
    document.getElementById('activityTag').textContent = 'GITHUB';
    const table = document.getElementById('deployTable');
    table.replaceChildren(table.firstElementChild, ...(data.runs || []).map(run => deployRow(run, runtime, publicHealth)));
    const activity = document.getElementById('activityList');
    activity.replaceChildren();
    for (const run of (data.runs || []).slice(0, 3)) {
      const item = document.createElement('div');
      item.className = 'timeline-item';
      const symbol = document.createElement('span');
      symbol.className = 'timeline-symbol ' + (deployState(run, runtime, publicHealth) === 'published' ? 'success' : 'neutral');
      symbol.textContent = deployState(run, runtime, publicHealth) === 'published' ? '✓' : '↗';
      const content = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = deployLabel(run, runtime, publicHealth);
      const summary = document.createElement('p');
      summary.textContent = `${run.branch || 'main'} · ${run.sha?.slice(0, 8)}`;
      const time = document.createElement('small');
      time.textContent = new Date(run.createdAt).toLocaleString('pt-BR');
      content.append(title, summary, time);
      item.append(symbol, content);
      activity.append(item);
    }
    if (!data.runs?.length) activity.textContent = 'Histórico indisponível no momento.';
    document.querySelector('.activity-footer').lastChild.textContent = ` VPS ${vpsState.toLowerCase()} · ${githubState}`;
    window.refreshGitHubRepositories?.();
  } catch (error) { toast(`Deploys: ${error.message}`); }
}
async function loadLogs() {
  if (!authenticated) return;
  const area = document.getElementById('logConsole');
  area.textContent = 'Carregando logs...';
  try {
    const data = await api(`/services/${document.getElementById('logFilter').value}/logs?tail=150`);
    area.textContent = data.lines || 'Nenhuma linha disponível.';
  } catch (error) { area.textContent = error.message; }
}

const menu = document.getElementById('sidebar');
const menuButton = document.getElementById('menuButton');
function showView(name) {
  const viewName = name.split('?')[0];
  const view = document.getElementById(viewName) || document.getElementById('overview');
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el === view));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view.id));
  document.getElementById('currentCrumb').textContent = view.dataset.title;
  menu.classList.remove('open');
  menuButton.setAttribute('aria-expanded', 'false');
  document.title = `${view.dataset.title} — Softload Console`;
  if (view.id === 'logs') loadLogs();
  if (view.id === 'deploys') loadDeploys();
  if (view.id === 'apps' && authenticated) window.refreshManagedApplications?.();
  if (view.id === 'site' && authenticated) window.refreshSiteDetail?.();
  if (view.id === 'projects' && authenticated) window.refreshManagedProjects?.();
  if (view.id === 'domains' && authenticated) window.refreshManagedDomains?.();
  if (view.id === 'terminal') window.refreshTerminalConnection?.();
  if (view.id === 'revisions' && authenticated) window.refreshManagedRevisions?.();
  if (view.id === 'secrets' && authenticated) window.refreshPanelSecrets?.();
  if (view.id === 'traffic' && authenticated) window.refreshTraffic?.();
}
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
showView(location.hash.slice(1));
menuButton.addEventListener('click', () => {
  const open = menu.classList.toggle('open');
  menuButton.setAttribute('aria-expanded', String(open));
});

document.getElementById('authForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.getElementById('authSubmit');
  const errorBox = document.getElementById('authError');
  button.disabled = true;
  errorBox.textContent = '';
  try {
    const password = document.getElementById('password').value;
    if (setupMode) {
      await api('/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: document.getElementById('setupToken').value.trim(), password }) });
      document.getElementById('authForm').reset();
      showAuth(false);
      toast('Senha criada. Entre como admin.');
    } else {
      await api('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: document.getElementById('username').value.trim(), password }) });
      authenticated = true;
      document.getElementById('authOverlay').hidden = true;
      document.getElementById('logoutButton').hidden = false;
      document.getElementById('password').value = '';
      await Promise.all([loadOverview(), loadDeploys()]);
      if (location.hash === '#logs') loadLogs();
      if (location.hash === '#apps') window.refreshManagedApplications?.();
      if (location.hash.startsWith('#site?')) window.refreshSiteDetail?.();
      if (location.hash === '#projects') window.refreshManagedProjects?.();
      if (location.hash === '#domains') window.refreshManagedDomains?.();
      if (location.hash === '#terminal') window.refreshTerminalConnection?.();
    if (location.hash === '#secrets') window.refreshPanelSecrets?.();
      if (location.hash === '#traffic') window.refreshTraffic?.();
      if (location.hash === '#revisions') window.refreshManagedRevisions?.();
    }
  } catch (error) { errorBox.textContent = error.message; }
  finally { button.disabled = false; }
});
document.getElementById('logoutButton').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST' }); } catch { /* local sign-out still proceeds */ }
  showAuth(false);
  setBanner('Sessão encerrada. Faça login para visualizar dados da VPS.');
});
document.querySelectorAll('.demo-action').forEach(button => button.addEventListener('click', () => {
  if (button.dataset.action === 'Atualizar serviços') loadOverview();
  else if (button.dataset.action === 'Novo deploy') location.hash = 'deploys';
  else if (button.dataset.action === 'Abrir aplicações') location.hash = 'apps';
  else location.hash = 'settings';
}));
document.getElementById('infoButton').addEventListener('click', () => toast('O painel mostra dados da VPS somente após autenticação. Caddy e Portainer são apenas leitura.'));
document.getElementById('bannerClose').addEventListener('click', () => document.getElementById('demoBanner').remove());
document.getElementById('logFilter').addEventListener('change', loadLogs);
document.getElementById('refreshLogs').addEventListener('click', loadLogs);
document.getElementById('passwordForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await api('/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: document.getElementById('currentPassword').value, newPassword: document.getElementById('newPassword').value }) });
    form.reset();
    showAuth(false);
    toast('Senha alterada. Entre novamente com a nova senha.');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
fillServices(demoServices);
api('/session').then(data => {
  document.getElementById('apiStatus').textContent = '● API conectada';
  if (data.authenticated) {
    authenticated = true;
    document.getElementById('logoutButton').hidden = false;
    Promise.all([loadOverview(), loadDeploys()]);
    if (location.hash === '#apps') window.refreshManagedApplications?.();
    if (location.hash.startsWith('#site?')) window.refreshSiteDetail?.();
    if (location.hash === '#projects') window.refreshManagedProjects?.();
    if (location.hash === '#domains') window.refreshManagedDomains?.();
    if (location.hash === '#terminal') window.refreshTerminalConnection?.();
    if (location.hash === '#secrets') window.refreshPanelSecrets?.();
    if (location.hash === '#traffic') window.refreshTraffic?.();
  } else showAuth(data.setupRequired);
}).catch(() => {
  setBanner('API indisponível. Os valores exibidos são apenas exemplos; nenhuma ação alcança a VPS.');
  document.getElementById('apiStatus').textContent = '○ API indisponível';
  document.querySelector('.connection-card strong').textContent = 'Modo de demonstração';
  document.querySelector('.connection-card small').textContent = 'API indisponível';
});
