/* Acompanhamento somente leitura: CI aprovado não comprova deploy na VPS. */
(() => {
  const panel = document.getElementById('revisionActivity')!;
  const summary = document.getElementById('revisionActivitySummary')!;
  if (!panel || !summary) return;
  const phases = new Map([
    ['queued', 'Na fila da publicação'], ['importing', 'Importando imagem'],
    ['staging', 'Preparando candidata'], ['health', 'Testando container'],
    ['promoting', 'Ativando revisão']
  ]);
  let busy = false;
  let timer = 0;
  function visible() {
    return !document.hidden && location.hash.split('?')[0] === '#revisions';
  }
  function element(tag: string, className: string, message: string) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = message;
    return node;
  }
  function status(stage: any) {
    const item = element('span', 'revision-ci-stage revision-ci-' + stage.kind, '');
    const symbol = element('span', 'revision-ci-dot', stage.kind === 'success' ? '✓' :
      stage.kind === 'failed' ? '×' : stage.kind === 'warning' ? '!' : '');
    symbol.setAttribute('aria-hidden', 'true');
    item.append(symbol, element('span', '', stage.label));
    return item;
  }
  function ciState(run: any) {
    if (run.status === 'queued' || run.status === 'pending' || run.status === 'waiting' || run.status === 'requested')
      return { kind: 'running', label: 'CI/CD na fila' };
    if (run.status === 'in_progress')
      return { kind: 'running', label: 'CI/CD executando' };
    if (run.status === 'completed' && run.conclusion === 'success')
      return { kind: 'success', label: 'CI/CD aprovado' };
    if (run.status === 'completed' && ['failure', 'timed_out', 'startup_failure'].includes(run.conclusion))
      return { kind: 'failed', label: 'CI/CD falhou' };
    if (run.status === 'completed' && run.conclusion === 'cancelled')
      return { kind: 'warning', label: 'CI/CD cancelado' };
    return { kind: 'neutral', label: 'CI/CD não confirmado' };
  }
  function vpsState(run: any, repo: any, project: any, release: any, history: any[]) {
    // Só o Docker da VPS, consultado pelo backend, pode confirmar a revisão ativa.
    if (release?.current?.state === 'running' && release.current.revision === run.sha)
      return { kind: 'success', label: 'Ativa na VPS' };
    const publication = history.find(item => item.repository === repo.fullName &&
      item.runId === run.id && (!project || project.slug === item.slug));
    if (publication?.phase === 'failed' || publication?.phase === 'attention')
      return { kind: 'failed', label: 'Publicação requer atenção' };
    if (publication && phases.has(publication.phase))
      return { kind: 'running', label: phases.get(publication.phase) };
    if (!project)
      return { kind: 'neutral', label: 'VPS sem vínculo verificável' };
    if (!release)
      return { kind: 'neutral', label: 'VPS não verificada' };
    if (release.current?.state === 'running' && release.current?.revision && release.current.revision !== run.sha)
      return { kind: 'warning', label: 'Outra revisão ativa' };
    if (publication?.phase === 'completed')
      return { kind: 'warning', label: 'Publicação concluída; conferir VPS' };
    return { kind: 'neutral', label: 'Ainda não confirmada na VPS' };
  }
  function renderRun(repo: any, run: any, project: any, release: any, history: any[]) {
    const ci = ciState(run);
    const vps = vpsState(run, repo, project, release, history);
    const card = element('article', 'revision-ci-card', '');
    const header = element('div', 'revision-ci-card-head', '');
    const title = element('div', 'revision-ci-card-title', '');
    title.append(element('strong', '', repo.fullName),
      element('small', '', repo.workflow + ' · ' + (run.branch || repo.branch || 'branch não informada')));
    const link = document.createElement('a');
    link.className = 'revision-ci-link';
    link.href = 'https://github.com/' + repo.fullName + '/actions/runs/' + run.id;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '#' + run.id + ' · ' + (typeof run.sha === 'string' ? run.sha.slice(0, 8) : 'sem SHA');
    header.append(title, link);
    const steps = element('div', 'revision-ci-stages', '');
    steps.append(status(ci), element('span', 'revision-ci-arrow', '›'),
      status(vps), element('span', 'revision-ci-arrow', '›'),
      status({ kind: 'neutral', label: 'Site público não verificado' }));
    const foot = element('small', 'revision-ci-date', '');
    const instant = Date.parse(run.createdAt || '');
    foot.textContent = Number.isFinite(instant) ?
      'Execução iniciada em ' + new Date(instant).toLocaleString('pt-BR') :
      'Data do workflow não disponível';
    card.append(header, steps, foot);
    return { card, ongoing: ci.kind === 'running' || vps.kind === 'running',
      active: vps.kind === 'success' };
  }
  async function request(path: string) {
    return window.panelApi.request<any>(path);
  }
  function schedule(ongoing: boolean) {
    window.clearTimeout(timer);
    if (visible()) timer = window.setTimeout(() => { void refreshRevisionActivity(); }, ongoing ? 20000 : 90000);
  }
  async function refreshRevisionActivity() {
    if (busy || !visible()) return;
    busy = true;
    window.clearTimeout(timer);
    summary.textContent = 'Consultando GitHub e estado das publicações na VPS…';
    try {
      const response = await request('/repositories');
      const repos = Array.isArray(response.repositories) ? response.repositories.filter(
        (repo: any) => typeof repo.fullName === 'string' &&
          /^Softdown-prog\/[A-Za-z0-9_.-]+$/.test(repo.fullName) &&
          typeof repo.workflow === 'string') : [];
      if (!repos.length) {
        panel.replaceChildren(element('p', 'revision-ci-empty',
          'Nenhum repositório com workflow conectado. Abra Publicações para conectar um.'));
        summary.textContent = 'Nenhuma execução vinculada para acompanhar.';
        schedule(false);
        return;
      }
      const [projectsData, publicationsData] = await Promise.all([
        request('/projects').catch(() => null),
        request('/publications').catch(() => null)
      ]);
      const projects = Array.isArray(projectsData?.projects) ? projectsData.projects : [];
      const history = Array.isArray(publicationsData?.history) ? publicationsData.history : [];
      const groups = await Promise.all(repos.map(async (repo: any) => {
        const project = projects.find((item: any) => item.repository === repo.fullName);
        const [runsResult, releaseResult] = await Promise.allSettled([
          request('/repositories/' + repo.fullName + '/runs'),
          project && typeof project.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.slug)
            ? request('/projects/' + project.slug + '/releases') : Promise.resolve(null)
        ]);
        return { repo, project, runs: runsResult.status === 'fulfilled' &&
          Array.isArray(runsResult.value?.runs) ? runsResult.value.runs.slice(0, 3) : null,
          release: releaseResult.status === 'fulfilled' ? releaseResult.value : null };
      }));
      const cards = [];
      let active = 0, ongoing = false, failures = 0;
      for (const group of groups) {
        if (!group.runs) {
          failures++;
          cards.push(element('p', 'revision-ci-empty',
            group.repo.fullName + ': não foi possível consultar o GitHub. Confira a conexão em Publicações.'));
          continue;
        }
        if (!group.runs.length) {
          cards.push(element('p', 'revision-ci-empty',
            group.repo.fullName + ': nenhuma execução de workflow encontrada.'));
        }
        for (const run of group.runs) {
          if (!Number.isSafeInteger(run.id) || run.id < 1 || typeof run.status !== 'string') continue;
          const result = renderRun(group.repo, run, group.project, group.release, history);
          cards.push(result.card);
          if (result.active) active++;
          if (result.ongoing) ongoing = true;
        }
      }
      panel.replaceChildren(...cards);
      summary.textContent = 'Atualizado às ' + new Date().toLocaleTimeString('pt-BR') +
        ' · ' + active + ' revisão(ões) confirmada(s) em execução na VPS' +
        (failures ? ' · ' + failures + ' consulta(s) sem resposta' : '') +
        '. CI aprovado não comprova publicação nem acesso público.';
      schedule(ongoing);
    } catch (error) {
      panel.replaceChildren(element('p', 'revision-ci-empty',
        'Não foi possível consultar o acompanhamento: ' +
        (error instanceof Error ? error.message : 'falha inesperada')));
      summary.textContent = 'Estado não disponível. Nenhuma publicação foi confirmada nesta consulta.';
      schedule(false);
    } finally { busy = false; }
  }
  document.getElementById('revisionActivityRefresh')?.addEventListener('click',
    () => { void refreshRevisionActivity(); });
  document.addEventListener('visibilitychange', () => {
    if (visible()) void refreshRevisionActivity();
    else window.clearTimeout(timer);
  });
  Object.assign(window, { refreshRevisionActivity });
})();
