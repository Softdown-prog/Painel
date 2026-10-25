(() => {
  interface ProjectLink { slug: string; repository: string; branch: string | null; workflow: string | null }
  interface RepoLink { fullName: string; branch: string; workflow: string }
  interface AppLink { slug: string; image: string; state: string }
  interface RunItem { id: number; sha: string; status: string; conclusion: string | null; url: string; createdAt: string }
  interface ProjectsResponse { projects: ProjectLink[]; buildsEnabled: boolean; requiredWorkflow: string }
  let projects: ProjectLink[] = [];
  let buildsEnabled = false;
  const releaseReady = new Set<string>();
  const get = (id: string): HTMLElement => {
    const el = document.getElementById(id);
    if (!el) throw new Error('Elemento ausente: ' + id);
    return el;
  };
  const field = (id: string): HTMLInputElement => get(id) as HTMLInputElement;
  const notice = (message: string): void => { get('projectsNotice').textContent = message; };
  async function call(path: string, options: RequestInit = {}): Promise<any> {
    const response = await fetch('/api' + path, { credentials: 'same-origin', cache: 'no-store', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status);
    return data;
  }
  function button(label: string, callback: () => Promise<void>, disabled = false): HTMLButtonElement {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = label;
    item.disabled = disabled;
    item.addEventListener('click', async () => {
      item.disabled = true;
      try { await callback(); } finally { item.disabled = disabled; }
    });
    return item;
  }
  async function loadRuns(slug: string, parent: HTMLElement, releaseHost: HTMLElement): Promise<void> {
    parent.textContent = 'Carregando execuções...';
    try {
      const data = await call('/projects/' + encodeURIComponent(slug) + '/runs');
      parent.replaceChildren();
      const runs = data.runs as RunItem[];
      if (!runs.length) { parent.textContent = 'Sem builds recentes.'; return; }
      for (const run of runs) {
        const line = document.createElement('p');
        const link = document.createElement('a');
        link.href = 'https://github.com/' + projects.find(p => p.slug === slug)!.repository +
          '/actions/runs/' + encodeURIComponent(String(run.id));
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = (run.sha || '').slice(0, 8) + ' · #' + run.id;
        const status = document.createElement('span');
        status.textContent = ' · ' + (run.conclusion || run.status) + ' · ' + new Date(run.createdAt).toLocaleString('pt-BR');
        line.append(link, status);
        if (run.conclusion === 'success' && releaseReady.has(slug)) {
          line.append(button('Preparar na VPS', async () => {
            if (!confirm('Preparar a imagem desta revisão na VPS? A imagem deve ter sido importada previamente. O container atual permanecerá ativo.')) return;
            try {
              await call('/projects/' + slug + '/releases/stage', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ runId: run.id })
              });
              notice('Candidata iniciada. Aguarde o HEALTHCHECK e atualize o estado da publicação.');
              const project = projects.find(p => p.slug === slug);
              if (project) await showReleaseStatus(project, releaseHost);
            } catch (error) { notice(error instanceof Error ? error.message : 'Falha ao preparar a imagem.'); }
          }));
        }
        parent.append(line);
      }
    } catch (error) { parent.textContent = error instanceof Error ? error.message : 'Não foi possível consultar execuções.'; }
  }

  async function showReleaseStatus(project: ProjectLink, host: HTMLElement): Promise<void> {
    host.textContent = 'Verificando publicação na VPS...';
    try {
      const status = await call('/projects/' + project.slug + '/releases');
      if (status.enabled) releaseReady.add(project.slug);
      else releaseReady.delete(project.slug);
      host.replaceChildren();
      const info = document.createElement('small');
      info.textContent = 'Publicação ' + (status.enabled ? 'habilitada' : 'desabilitada') +
        ' · Ativa: ' + (status.current.revision?.slice(0, 8) || status.current.image || 'não informado') +
        (status.candidate ? ' · Candidata ' + String(status.candidate.revision || '').slice(0, 8) +
          ' (' + status.candidate.health + ')' : '') +
        (status.backup ? ' · Backup disponível' : '');
      host.append(info);
      if (status.enabled && status.candidate?.health === 'healthy' && !status.backup) {
        host.append(button('Publicar candidata', async () => {
          if (!confirm('Substituir ' + project.slug + ' pela candidata saudável? A aplicação poderá ficar indisponível brevemente.')) return;
          await releaseOperation(project, 'promote', host);
        }));
      }
      if (status.enabled && status.backup && !status.candidate) {
        host.append(button('Restaurar anterior', async () => {
          if (!confirm('Restaurar a versão anterior de ' + project.slug + '?')) return;
          await releaseOperation(project, 'rollback', host);
        }));
      }
      if (status.enabled && (status.backup || status.candidate)) {
        host.append(button('Descartar reserva', async () => {
          if (!confirm('Remover definitivamente o container reserva de ' + project.slug + '? Isso pode eliminar a opção de rollback.')) return;
          try {
            await call('/projects/' + project.slug + '/releases/finalize', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ confirm: 'DELETE_BACKUP' })
            });
            await showReleaseStatus(project, host);
          } catch (error) { notice(error instanceof Error ? error.message : 'Falha ao limpar reserva.'); }
        }));
      }
    } catch (error) {
      host.textContent = error instanceof Error ? error.message : 'Publicação indisponível.';
    }
  }
  async function releaseOperation(project: ProjectLink, action: 'promote' | 'rollback', host: HTMLElement): Promise<void> {
    try {
      await call('/projects/' + project.slug + '/releases/' + action, { method: 'POST' });
      notice(action === 'promote' ? 'Versão publicada. Backup mantido para rollback.' : 'Rollback solicitado e versão anterior restaurada.');
      await showReleaseStatus(project, host);
    } catch (error) {
      notice(error instanceof Error ? error.message : 'Falha na operação de release.');
      await showReleaseStatus(project, host);
    }
  }
  async function refreshManagedProjects(): Promise<void> {
    const list = get('managedProjects');
    list.textContent = 'Carregando projetos...';
    try {
      const [linked, services, repos] = await Promise.all([
        call('/projects') as Promise<ProjectsResponse>,
        call('/apps') as Promise<{ applications: AppLink[] }>,
        call('/repositories') as Promise<{ repositories: RepoLink[] }>
      ]);
      projects = linked.projects;
      buildsEnabled = linked.buildsEnabled;
      const selectApp = get('projectApp') as HTMLSelectElement;
      const selectRepo = get('projectRepo') as HTMLSelectElement;
      const previousApp = selectApp.value;
      const previousRepo = selectRepo.value;
      selectApp.replaceChildren();
      selectRepo.replaceChildren();
      for (const app of services.applications) {
        if (projects.some(project => project.slug === app.slug)) continue;
        const option = document.createElement('option'); option.value = app.slug;
        option.textContent = app.slug + ' · ' + app.image;
        selectApp.append(option);
      }
      for (const repo of repos.repositories) {
        const option = document.createElement('option'); option.value = repo.fullName;
        option.textContent = repo.fullName + ' · ' + repo.workflow;
        selectRepo.append(option);
      }
      if (Array.from(selectApp.options).some(x => x.value === previousApp)) selectApp.value = previousApp;
      if (Array.from(selectRepo.options).some(x => x.value === previousRepo)) selectRepo.value = previousRepo;
      field('projectLinkButton').disabled = !selectApp.value || !selectRepo.value;
      list.replaceChildren();
      if (!projects.length) list.textContent = 'Nenhuma aplicação vinculada a um repositório.';
      for (const project of projects) {
        const row = document.createElement('article'); row.className = 'managed-project-row';
        const info = document.createElement('div'); info.className = 'managed-project-info';
        const label = document.createElement('strong'); label.textContent = project.slug;
        const detail = document.createElement('small'); detail.textContent = project.repository +
          ' · ' + (project.branch || 'repositório desconectado') + ' · ' + (project.workflow || 'sem workflow');
        info.append(label, detail);
        const actions = document.createElement('div'); actions.className = 'managed-project-actions';
        const runs = document.createElement('div'); runs.className = 'managed-project-runs';
        const releasePanel = document.createElement('div'); releasePanel.className = 'managed-project-releases';
        const supported = project.workflow === linked.requiredWorkflow;
        actions.append(button('Consultar builds', () => loadRuns(project.slug, runs, releasePanel), !supported));
        actions.append(button('Executar build', async () => {
          if (!confirm('Executar build de ' + project.repository + '? Isso publica uma imagem no GHCR, sem alterar o container da VPS.')) return;
          try {
            await call('/projects/' + project.slug + '/build', { method: 'POST' });
            notice('Build solicitado. Consulte as execuções do GitHub para acompanhar; a VPS não foi alterada.');
            await loadRuns(project.slug, runs, releasePanel);
          } catch (error) { notice(error instanceof Error ? error.message : 'Não foi possível executar o build.'); }
        }, !buildsEnabled || !supported));
        actions.append(button('Desvincular', async () => {
          if (!confirm('Desvincular ' + project.slug + '? O container será preservado.')) return;
          try {
            await call('/projects/' + project.slug, { method: 'DELETE' });
            await refreshManagedProjects();
            notice('Vínculo removido; container preservado.');
          } catch (error) { notice(error instanceof Error ? error.message : 'Não foi possível desvincular.'); }
        }));
        row.append(info, actions, releasePanel, runs);
        list.append(row);
        void showReleaseStatus(project, releasePanel);
      }
      notice(buildsEnabled
        ? 'Build habilitado. Somente o workflow panel-app-build.yml é aceito; nenhum container é substituído.'
        : 'Vínculos disponíveis. O administrador precisa habilitar builds na VPS para permitir execuções.');
    } catch (error) {
      list.textContent = 'Projetos indisponíveis.';
      notice(error instanceof Error ? error.message : 'Não foi possível carregar projetos.');
    }
  }
  get('projectLinkForm').addEventListener('submit', async event => {
    event.preventDefault();
    field('projectLinkButton').disabled = true;
    try {
      await call('/projects', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: field('projectApp').value, repository: field('projectRepo').value }) });
      await refreshManagedProjects();
      notice('Aplicação e repositório vinculados.');
    } catch (error) { notice(error instanceof Error ? error.message : 'Erro ao vincular projeto.'); }
    finally { field('projectLinkButton').disabled = !field('projectApp').value || !field('projectRepo').value; }
  });
  get('projectsRefreshButton').addEventListener('click', refreshManagedProjects);
  Object.assign(window, { refreshManagedProjects });
})();
