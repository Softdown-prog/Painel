const demoServices = [
  { id: 'app', name: 'Backend principal', detail: 'API e aplicação web', icon: 'S' },
  { id: 'agent', name: 'Agent Worker', detail: 'Processamento de tarefas', icon: '◇' },
  { id: 'caddy', name: 'Caddy', detail: 'Proxy reverso', icon: '◈' }
];
const labels = Object.fromEntries(demoServices.map(service => [service.id, service]));
let authenticated = false;
let setupMode = false;
let toastTimer;

async function api(path, options = {}) {
  try { return await window.panelApi.request(path, options); }
  catch (error) {
    if (error.status === 401 && path !== '/login') showAuth(false);
    throw error;
  }
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
  if (!banner) return;
  banner.classList.toggle('live', live);
  document.getElementById('bannerText').textContent = message;
}
function showAuth(setup) {
  authenticated = false;
  setupMode = setup;
  markOverviewUnavailable('Entre novamente para consultar indicadores reais da VPS.');
  clearHostContainers('Faça login para consultar os containers da VPS.');
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
  const symbol = document.createElement('span');
  symbol.className = 'service-symbol';
  symbol.textContent = labels[service.id]?.icon || '◫';
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
  const label = service.state === 'running' ? 'Ativo'
    : service.state === 'missing' ? 'Ausente'
    : service.state === 'exited' ? 'Parado'
    : service.state || 'Não encontrado';
  state.append(dot, authenticated ? label : 'Exemplo');
  row.append(symbol, main, state);
  if (allowActions && authenticated) {
    const manage = document.createElement('button');
    manage.type = 'button';
    manage.textContent = 'Gerenciar';
    manage.addEventListener('click', () => { void openService(service); });
    row.append(manage);
  }
  return row;
}
let selectedService = null;

async function openService(service) {
  if (!service?.id) {
    toast('Serviço não encontrado. Atualize a lista.');
    location.hash = 'services';
    return;
  }
  selectedService = service;
  location.hash = 'service-detail';
  document.getElementById('serviceDetailName').textContent = labels[service.id]?.name || service.name;
  document.getElementById('serviceDetailSummary').textContent =
    `${service.status} · ${service.image || 'sem imagem'}`;
  const actions = document.getElementById('serviceDetailActions');
  const logs = document.getElementById('serviceDetailLogs');
  actions.replaceChildren();

  const refreshLogs = async () => {
    logs.textContent = 'Carregando registros...';
    try {
      const data = await api(`/services/${service.id}/logs?tail=200`);
      // Não exibir logs de um container anterior depois de trocar de aba.
      if (selectedService?.id === service.id) logs.textContent = data.lines || 'Sem registros.';
    } catch (error) {
      if (selectedService?.id === service.id) logs.textContent = error.message;
    }
  };
  const refreshButton = document.createElement('button');
  refreshButton.type = 'button';
  refreshButton.className = 'secondary-button';
  refreshButton.textContent = '↻ Atualizar registros';
  refreshButton.addEventListener('click', async () => {
    refreshButton.disabled = true;
    try { await refreshLogs(); }
    finally { refreshButton.disabled = false; }
  });
  actions.append(refreshButton);

  const options = service.controllable
    ? service.state === 'running' ? [['restart', 'Reiniciar'], ['stop', 'Parar']]
      : ['exited', 'created'].includes(service.state) ? [['start', 'Iniciar']] : []
    : [];
  for (const [action, label] of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary-button';
    button.textContent = label;
    button.addEventListener('click', async () => {
      if (!confirm(`${label} ${labels[service.id]?.name || service.name}? Isso afeta a VPS.`)) return;
      const buttons = actions.querySelectorAll('button');
      buttons.forEach(control => { control.disabled = true; });
      try {
        await api(`/services/${service.id}/${action}`, { method: 'POST' });
        toast(`${label} solicitado. Conferindo estado...`);
        await loadOverview();
        const current = (await api('/services')).services?.find(item => item.id === service.id);
        if (selectedService?.id === service.id) await openService(current);
      } catch (error) {
        toast(error.message);
        buttons.forEach(control => { control.disabled = false; });
      }
    });
    actions.append(button);
  }
  if (!service.controllable) {
    const explanation = document.createElement('small');
    explanation.textContent = service.state === 'missing'
      ? 'Container não encontrado. Não é possível iniciá-lo por aqui.'
      : 'Consulta de estado e registros disponível. Ações de alteração não permitidas.';
    actions.append(explanation);
  }
  await refreshLogs();
}
function fillServices(services) {
  const overview = document.getElementById('overviewServices');
  const all = document.getElementById('allServices');
  const empty = () => {
    const element = document.createElement('p');
    element.className = 'service-empty';
    element.textContent = authenticated ? 'Nenhum serviço foi informado pela VPS.' : 'Faça login para consultar os serviços da VPS.';
    return element;
  };
  overview.replaceChildren(...(services.length ? services.slice(0, 4).map(service => serviceRow(service)) : [empty()]));
  all.replaceChildren(...(services.length ? services.map(service => serviceRow(service, true)) : [empty()]));
}
function gb(value) { return (value / 1073741824).toFixed(1).replace('.', ','); }
// Um inventário do host é apenas consulta: estes itens NÃO herdam controles do Painel.
let hostContainersLoading = false;
function hostContainerRow(container) {
  const row = document.createElement('div');
  row.className = 'service-row';
  const symbol = document.createElement('span');
  symbol.className = 'service-symbol';
  symbol.textContent = container.ownership === 'softload' ? 'S' :
    container.ownership === 'managed' ? '⬡' : '▣';
  const main = document.createElement('span');
  main.className = 'service-main';
  const name = document.createElement('strong');
  name.textContent = container.name || 'Container sem nome';
  const detail = document.createElement('small');
  const origin = container.project ? 'Projeto: ' + container.project + ' · ' : '';
  detail.textContent = origin + (container.image || 'Imagem desconhecida') +
    ' · ' + (container.ownership === 'external' ? 'Somente consulta' :
      container.ownership === 'managed' ? 'Aplicação do Painel' : 'Softload V4');
  main.append(name, detail);
  const state = document.createElement('span');
  state.className = 'service-state';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = container.state === 'running' ? '#65d6a4' : '#e4b077';
  state.append(dot, (container.state === 'running' ? 'Ativo' :
    container.state === 'exited' ? 'Parado' : container.state || 'Desconhecido') +
    ' · ' + (container.status || 'Estado não informado'));
  row.append(symbol, main, state);
  return row;
}
function clearHostContainers(message) {
  document.getElementById('overviewHostCount').textContent = message;
  document.getElementById('overviewHostContainers').replaceChildren();
  document.getElementById('allHostContainers').replaceChildren();
  document.getElementById('hostContainersTag').textContent = 'SEM DADOS';
  document.getElementById('hostContainersNotice').textContent = message;
}
async function loadHostContainers() {
  if (!authenticated || hostContainersLoading) return;
  hostContainersLoading = true;
  const refresh = document.getElementById('hostContainersRefresh');
  refresh.disabled = true;
  try {
    const data = await api('/containers');
    if (!authenticated) return;
    if (!Array.isArray(data.containers) || data.readOnly !== true)
      throw new Error('Resposta inválida do inventário.');
    const items = data.containers;
    const running = items.filter(item => item.state === 'running').length;
    const message = running + ' em execução de ' + items.length + ' containers encontrados' +
      (data.truncated ? ' · lista limitada a 500 itens' : '');
    document.getElementById('overviewHostCount').textContent = message;
    document.getElementById('hostContainersTag').textContent = running + ' / ' + items.length + ' ATIVOS';
    document.getElementById('hostContainersNotice').textContent = message +
      ' · Atualizado às ' + new Date(data.updatedAt).toLocaleTimeString('pt-BR') +
      ' · Inventário somente leitura.';
    const empty = () => {
      const p = document.createElement('p');
      p.className = 'service-empty';
      p.textContent = 'O Docker não informou containers nesta VPS.';
      return p;
    };
    document.getElementById('overviewHostContainers').replaceChildren(
      ...(items.length ? items.slice(0, 5).map(hostContainerRow) : [empty()])
    );
    document.getElementById('allHostContainers').replaceChildren(
      ...(items.length ? items.map(hostContainerRow) : [empty()])
    );
  } catch (error) {
    if (authenticated) clearHostContainers('Não foi possível consultar os containers: ' +
      (error.message || 'API indisponível') + '. Confira se a API e o executor do Painel estão atualizados.');
  } finally {
    hostContainersLoading = false;
    refresh.disabled = false;
  }
}
document.getElementById('hostContainersRefresh').addEventListener('click', () => void loadHostContainers());
let lastOverviewTime = null;
let overviewLoading = false;
function writeMetric(id, value, extra = '') {
  const element = document.getElementById(id);
  element.textContent = value;
  if (extra) {
    const units = document.createElement('span');
    units.textContent = extra;
    element.append(units);
  }
}
function ratio(used, total) {
  return Number.isFinite(used) && Number.isFinite(total) && total > 0
    ? Math.max(0, Math.min(100, Math.round(used / total * 100))) : null;
}
function setOverviewHealth(kind, title, message, issues = []) {
  document.getElementById('overviewHealth').dataset.state = kind;
  document.getElementById('overviewHealthIcon').textContent = kind === 'ok' ? '✓' : kind === 'attention' ? '!' : '?';
  document.getElementById('overviewHealthTitle').textContent = title;
  document.getElementById('overviewHealthSummary').textContent = message;
  const list = document.getElementById('overviewAlerts');
  list.replaceChildren();
  for (const issue of issues) {
    const item = document.createElement('div');
    item.className = 'overview-alert' + (issue.critical ? ' critical' : '');
    const copy = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = issue.title;
    const help = document.createElement('p');
    help.textContent = issue.detail;
    copy.append(name, help);
    const link = document.createElement('a');
    link.href = issue.href;
    link.textContent = 'Ver detalhes';
    item.append(copy, link);
    list.append(item);
  }
  list.hidden = issues.length === 0;
}
function markOverviewUnavailable(message) {
  window.renderResourceHistory?.(null);
  document.getElementById('overviewCheckedAt').textContent = lastOverviewTime
    ? 'Dados anteriores · ' + lastOverviewTime.toLocaleString('pt-BR') : 'Nenhuma leitura confirmada';
  document.querySelectorAll('.live-label').forEach(el => {
    el.textContent = lastOverviewTime ? 'ANTERIOR' : 'SEM DADOS';
  });
  document.getElementById('servicesTag').textContent = lastOverviewTime ? 'ANTERIOR' : 'SEM DADOS';
  document.getElementById('topStatus').lastChild.textContent = ' Sem atualização';
  document.querySelector('.connection-card strong').textContent = 'Não foi possível conferir a VPS';
  document.querySelector('.connection-card small').textContent = 'Confira o acesso e atualize';
  setOverviewHealth('unknown', 'Estado da VPS não confirmado', message);
  setBanner('Sem confirmação recente da VPS. Os números, se visíveis, são da última leitura.', false);
}
async function loadOverview() {
  if (!authenticated || overviewLoading) return;
  overviewLoading = true;
  const refreshButton = document.getElementById('overviewRefresh');
  refreshButton.disabled = true;
  refreshButton.textContent = 'Consultando...';
  try {
    const data = await api('/overview');
    window.renderResourceHistory?.(data.resourceHistory);
    const services = Array.isArray(data.services) ? data.services : [];
    fillServices(services);
    const running = services.filter(service => service.state === 'running').length;
    writeMetric('serviceCount', String(running), ' / ' + services.length);
    const readAt = new Date(data.updatedAt);
    const timestamp = readAt.getTime();
    const fresh = Number.isFinite(timestamp) && timestamp <= Date.now() + 30000 && Date.now() - timestamp <= 120000;
    if (Number.isFinite(timestamp)) lastOverviewTime = readAt;
    document.getElementById('serviceFoot').textContent = Number.isFinite(timestamp)
      ? 'Coletado às ' + readAt.toLocaleTimeString('pt-BR') : 'Horário da leitura não informado';
    document.getElementById('overviewCheckedAt').textContent = Number.isFinite(timestamp)
      ? 'Última leitura: ' + readAt.toLocaleString('pt-BR') + ' · dados da API da VPS'
      : 'Horário da leitura não confirmado';

    const memory = data.memory || {};
    const memoryPercent = ratio(memory.used, memory.total);
    if (memoryPercent === null) {
      writeMetric('memoryValue', 'Indisponível');
      document.getElementById('memoryBar').style.width = '0%';
    } else {
      writeMetric('memoryValue', gb(memory.used), ' GB / ' + gb(memory.total) + ' GB');
      document.getElementById('memoryBar').style.width = memoryPercent + '%';
    }
    document.getElementById('memoryDetail').textContent = memory.source === 'memavailable'
      ? (memoryPercent ?? '—') + '% ocupados · cache recuperável descontado'
      : 'Estimativa da API antiga: pode incluir cache do Linux; não usar como alerta de RAM.';

    const cpuLoad = Number(data.cpu?.load1);
    const cores = Number(data.cpu?.cores);
    const normalizedLoad = Number.isFinite(cpuLoad) && Number.isFinite(cores) && cores > 0 && cpuLoad >= 0
      ? cpuLoad / cores : null;
    if (normalizedLoad === null) {
      writeMetric('cpuValue', 'Indisponível');
    } else {
      writeMetric('cpuValue', cpuLoad.toLocaleString('pt-BR', { maximumFractionDigits: 2 }), ' / ' + cores + ' núcleos');
    }
    const diskPercent = ratio(data.disk?.used, data.disk?.total);
    if (diskPercent !== null) {
      writeMetric('diskValue', gb(data.disk.used), ' GB / ' + gb(data.disk.total) + ' GB');
      document.getElementById('diskBar').style.width = diskPercent + '%';
      const images = Number.isFinite(data.imagesBytes) ? ' · imagens Docker (estimativa): ' + gb(data.imagesBytes) + ' GB' : '';
      document.getElementById('diskDetail').textContent =
        diskPercent + '% ocupados · ' + gb(data.disk.available) + ' GB livres' + images;
    } else {
      writeMetric('diskValue', 'Indisponível');
      document.getElementById('diskBar').style.width = '0%';
      document.getElementById('diskDetail').textContent = 'O sistema de arquivos não informou sua capacidade.';
    }
    const issues = [];
    if (services.length && running < services.length) {
      issues.push({ title: services.length - running + ' serviço(s) fora de execução',
        detail: 'Confira se a parada foi planejada. Consulte o estado de cada serviço antes de agir.', href: '#services' });
    }
    if (memory.source === 'memavailable' && memoryPercent !== null && memoryPercent >= 85) {
      issues.push({ title: 'Memória com ' + memoryPercent + '% de ocupação',
        detail: 'A RAM disponível está baixa; confira os serviços antes de aumentar limites.',
        href: '#services', critical: memoryPercent >= 95 });
    }
    if (diskPercent !== null && diskPercent >= 85) {
      issues.push({ title: 'Armazenamento com ' + diskPercent + '% de ocupação',
        detail: 'Confira revisões e espaço. Nunca apague imagens de recuperação sem verificar o rollback.',
        href: '#revisions', critical: diskPercent >= 95 });
    }
    if (normalizedLoad !== null && normalizedLoad >= 1) {
      issues.push({ title: 'Carga elevada na média de 1 minuto',
        detail: 'A demanda alcançou a quantidade de núcleos disponíveis. Isso não significa 100% de uso instantâneo.',
        href: '#terminal' });
    }
    const label = fresh ? 'ATUAL' : 'ANTERIOR';
    document.querySelectorAll('.live-label').forEach(el => { el.textContent = label; });
    document.getElementById('servicesTag').textContent = label;
    if (!fresh) {
      markOverviewUnavailable('A API respondeu, mas o horário da coleta está ausente ou antigo. Atualize para confirmar.');
    } else {
      const noServices = services.length === 0;
      setOverviewHealth(issues.length ? 'attention' : noServices ? 'unknown' : 'ok',
        issues.length ? issues.length + ' ponto(s) merecem atenção'
          : noServices ? 'Sem serviços cadastrados no inventário' : 'Sem alertas nos indicadores disponíveis',
        issues.length ? 'Veja os sinais abaixo e confira os detalhes antes de tomar alguma ação.'
          : noServices ? 'A API não informou serviços. Confirme se esta VPS possui serviços configurados.'
          : 'Serviços, memória e armazenamento foram consultados. Isso não substitui testes de acesso aos sites.',
        issues);
      document.getElementById('topStatus').lastChild.textContent = ' VPS conectada';
      document.getElementById('apiStatus').textContent = '● API conectada';
      document.getElementById('authStatus').textContent = '● Sessão ativa';
      document.querySelector('.connection-card strong').textContent = 'VPS conectada';
      document.querySelector('.connection-card small').textContent = 'Leitura confirmada agora';
      setBanner('Dados da VPS atualizados. Revisão configurada ' +
        (data.currentSha?.slice(0, 8) || 'não disponível') + '. Confira a ativação em Publicações.', true);
    }
    void window.refreshHostedProjects?.();
    void loadHostContainers();
  } catch (error) {
    markOverviewUnavailable('Falha ao consultar a VPS: ' + (error.message || 'sem resposta') +
      '. Verifique sua conexão ou tente atualizar.');
  } finally {
    overviewLoading = false;
    refreshButton.disabled = false;
    refreshButton.textContent = '↻ Atualizar agora';
  }
}
document.getElementById('overviewRefresh').addEventListener('click', () => void loadOverview());
setInterval(() => {
  if (authenticated && !document.hidden && (!location.hash || location.hash === '#overview')) void loadOverview();
}, 90000);
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
function deployTrafficLabel(traffic) {
  if (!traffic?.available) return traffic?.reason || 'Aguardando amostra de rede.';
  const bytes = value => value >= 1024 ** 3 ? (value / 1024 ** 3).toFixed(2) + ' GB' :
    value >= 1024 ** 2 ? (value / 1024 ** 2).toFixed(1) + ' MB' :
    value >= 1024 ? (value / 1024).toFixed(1) + ' KB' : value + ' B';
  return `Estimativa no intervalo: RX ${bytes(traffic.rx)} · TX ${bytes(traffic.tx)}`;
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
  const titles = { app: 'Aplicação', agent: 'Agente' };
  for (const id of ['app', 'agent']) {
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
  const traffic = document.createElement('small');
  traffic.className = 'deploy-traffic';
  traffic.textContent = deployTrafficLabel(run.traffic);
  status.append(badge, traffic);
  const time = document.createElement('span');
  time.textContent = new Date(run.createdAt).toLocaleString('pt-BR');
  row.append(revision, origin, status, time);
  return row;
}
async function loadDeploys() {
  if (!authenticated) return;
  try {
    const [data, overview] = await Promise.all([api('/deploys'), api('/overview')]);
    const runningServices = (overview.services || []).filter(service => ['app', 'agent'].includes(service.id) && service.state === 'running').length;
    const activeRun = (data.runs || []).find(run => ['queued', 'pending', 'waiting', 'in_progress'].includes(run.status));
    const vpsState = runningServices === 0 ? 'Em repouso' : runningServices === 2 ? 'Ativa' : 'Inicializando ou parcialmente ativa';
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
  if (view.id === 'overview' && authenticated) void loadOverview();
  if (view.id === 'containers' && authenticated) void loadHostContainers();
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
      if (location.hash === '#containers') void loadHostContainers();
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
document.getElementById('infoButton').addEventListener('click', () => toast('O painel mostra dados da VPS somente após autenticação. Caddy é somente leitura.'));
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
fillServices([]);
clearHostContainers('Faça login para consultar os containers da VPS.');
let connectionCheck = null;
function checkPanelConnection() {
  if (connectionCheck) return connectionCheck;
  const buttons = ['apiRetryButton', 'authRetryConnection'].map(id => document.getElementById(id)).filter(Boolean);
  buttons.forEach(button => { button.disabled = true; });
  document.getElementById('apiStatus').textContent = '○ Verificando conexão';
  document.getElementById('apiConnectionMessage').textContent = 'Consultando a API da VPS...';
  connectionCheck = (async () => {
    try {
      const data = await api('/session');
      if (typeof data.authenticated !== 'boolean' || typeof data.setupRequired !== 'boolean')
        throw new Error('A resposta recebida não confirmou a API do painel. Confira o encaminhamento para a VPS.');
      document.getElementById('apiStatus').textContent = '● API conectada';
      document.getElementById('apiConnectionMessage').textContent = 'Conexão confirmada com a API. Isso não confirma a saúde dos sites hospedados.';
      document.querySelector('.connection-card strong').textContent = 'API acessível';
      document.querySelector('.connection-card small').textContent = 'Conexão confirmada';
      if (data.authenticated) {
        authenticated = true;
        document.getElementById('authOverlay').hidden = true;
        document.getElementById('logoutButton').hidden = false;
        await Promise.all([loadOverview(), loadDeploys()]);
        if (location.hash === '#apps') window.refreshManagedApplications?.();
        if (location.hash === '#containers') void loadHostContainers();
        if (location.hash.startsWith('#site?')) window.refreshSiteDetail?.();
        if (location.hash === '#projects') window.refreshManagedProjects?.();
        if (location.hash === '#domains') window.refreshManagedDomains?.();
        if (location.hash === '#terminal') window.refreshTerminalConnection?.();
        if (location.hash === '#secrets') window.refreshPanelSecrets?.();
        if (location.hash === '#traffic') window.refreshTraffic?.();
        if (location.hash === '#revisions') window.refreshManagedRevisions?.();
      } else showAuth(data.setupRequired);
    } catch (error) {
      markOverviewUnavailable('A API do painel não respondeu. Tente novamente após confirmar a conexão.');
      document.getElementById('apiStatus').textContent = '○ API indisponível';
      document.getElementById('apiConnectionMessage').textContent = error.message;
      document.getElementById('authError').textContent = error.message;
      document.querySelector('.connection-card strong').textContent = 'Sem conexão';
      document.querySelector('.connection-card small').textContent = 'API indisponível';
      setBanner(error.message);
    } finally { buttons.forEach(button => { button.disabled = false; }); }
  })().finally(() => { connectionCheck = null; });
  return connectionCheck;
}
for (const id of ['apiRetryButton', 'authRetryConnection'])
  document.getElementById(id).addEventListener('click', () => void checkPanelConnection());
void checkPanelConnection();
