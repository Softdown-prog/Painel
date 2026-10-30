(() => {
  interface ManagedApp {
    slug: string; image: string; name: string; state: string; status: string;
    ramMb: number; cpuCores: number; diskUsedBytes: number | null; idleMinutes: number;
  }
  interface AppCollection {
    enabled: boolean; applications: ManagedApp[]; ramChoices: number[];
    cpuChoices: number[]; idleChoices: number[];
  }
  let selected: ManagedApp | null = null;
  let available: AppCollection | null = null;
  let busy = false;
  const get = (id: string): HTMLElement => document.getElementById(id)!;
  const asSelect = (id: string): HTMLSelectElement => get(id) as HTMLSelectElement;
  const note = (value: string): void => { get('siteNotice').textContent = value; };
  const update = (id: string, value: string): void => { get(id).textContent = value; };
  const slugFromHash = (): string | null => {
    const hash = location.hash.split('?');
    const requested = new URLSearchParams(hash[1] || '').get('slug') ||
      (window as typeof window & { panelSelectedAppSlug?: string }).panelSelectedAppSlug || '';
    return /^(?=.{2,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(requested) ? requested : null;
  };
  async function call(path: string, options: RequestInit = {}): Promise<any> {
    return window.panelApi.request(path, options);
  }
  function choices(id: string, values: number[], selectedValue: number, formatter: (n: number) => string): void {
    const select = asSelect(id);
    select.replaceChildren();
    for (const value of values) {
      const opt = document.createElement('option');
      opt.value = String(value);
      opt.textContent = formatter(value);
      select.append(opt);
    }
    select.value = String(selectedValue);
  }
  function controls(): void {
    const canChange = Boolean(available?.enabled && selected && !busy);
    const running = selected?.state === 'running';
    (get('siteStart') as HTMLButtonElement).disabled = !canChange || running;
    (get('siteRestart') as HTMLButtonElement).disabled = !canChange || !running;
    (get('siteStop') as HTMLButtonElement).disabled = !canChange || !running;
    (get('siteSaveSettings') as HTMLButtonElement).disabled = !canChange;
  }
  async function refreshSiteDetail(): Promise<void> {
    const slug = slugFromHash();
    if (!slug) { note('Abra Sites e apps e selecione uma aplicação para administrar.'); return; }
    note('Consultando a aplicação na VPS...');
    try {
      const [apps, detail] = await Promise.all([
        call('/apps') as Promise<AppCollection>, call('/apps/' + encodeURIComponent(slug))
      ]);
      available = apps;
      selected = apps.applications.find(a => a.slug === slug) || null;
      if (!selected) throw new Error('Esta aplicação não aparece na lista do gerenciador.');
      const app = selected;
      update('siteTitle', 'Aplicação: ' + app.slug);
      update('siteState', app.state === 'running' ? '● Funcionando' : '○ ' + app.state);
      update('siteRam', app.ramMb + ' MB');
      update('siteCpu', app.cpuCores + ' vCPU');
      update('siteDisk', app.diskUsedBytes == null ? 'Indisponível' : (app.diskUsedBytes / 1048576).toFixed(1) + ' MB');
      update('siteImage', 'Imagem do container: ' + (detail.image || app.image));
      update('siteRepo', 'Não conectado ao GitHub');
      update('siteDomain', 'Nenhum endereço cadastrado');
      update('siteRevision', 'Não informado');
      update('siteBackup', 'Nenhum confirmado');
      choices('siteRamChoice', apps.ramChoices, app.ramMb, value => value + ' MB');
      choices('siteCpuChoice', apps.cpuChoices, app.cpuCores, value => value + ' vCPU');
      choices('siteIdleChoice', apps.idleChoices, app.idleMinutes, value =>
        value ? value + ' minutos sem atividade' : 'Desligado');
      Object.assign(window, { panelSelectedAppSlug: slug });
      controls();

      const [projectResponse, domainResponse] = await Promise.allSettled([
        call('/projects'), call('/domains')
      ]);
      const projects: Array<{slug: string; repository: string}> =
        projectResponse.status === 'fulfilled' ? projectResponse.value.projects || [] : [];
      const project = projects.find(p => p.slug === slug);
      if (project) {
        update('siteRepo', project.repository);
        try {
          const release = await call('/projects/' + slug + '/releases');
          update('siteRevision', release.current?.revision?.slice(0, 12) ||
            release.current?.image || 'Versão não identificada');
          update('siteBackup', release.backup ? 'Disponível para voltar à versão anterior' : 'Nenhum');
        } catch { update('siteRevision', 'Consulta de versões indisponível'); }
      }
      if (domainResponse.status === 'fulfilled') {
        const domain = (domainResponse.value.routes || []).find((r: {slug: string}) => r.slug === slug);
        if (domain) update('siteDomain', domain.host + ' (reservado; publicação não confirmada)');
      }
      note('Dados consultados na VPS. Recurso de SSH é separado desta página.');
    } catch (error) {
      selected = null; available = null; controls();
      note(error instanceof Error ? error.message : 'Não foi possível consultar a aplicação.');
    }
  }
  async function operate(action: 'start' | 'stop' | 'restart'): Promise<void> {
    if (!selected || !available?.enabled || busy) return;
    const slug = selected.slug;
    const word = action === 'start' ? 'Iniciar' : action === 'stop' ? 'Parar' : 'Reiniciar';
    if (!confirm(word + ' a aplicação ' + slug + ' na VPS?')) return;
    busy = true; controls();
    try {
      await call('/apps/' + slug + '/' + action, { method: 'POST' });
      note(word + ' solicitado; conferindo novo estado...');
      await refreshSiteDetail();
    } catch (error) { note(error instanceof Error ? error.message : 'Falha ao executar operação.'); }
    finally { busy = false; controls(); }
  }
  get('siteStart').addEventListener('click', () => void operate('start'));
  get('siteRestart').addEventListener('click', () => void operate('restart'));
  get('siteStop').addEventListener('click', () => void operate('stop'));
  get('siteRefresh').addEventListener('click', () => void refreshSiteDetail());
  get('siteReadLogs').addEventListener('click', async () => {
    if (!selected) return;
    update('siteLogs', 'Buscando registros...');
    try {
      const result = await call('/apps/' + encodeURIComponent(selected.slug) + '/logs');
      update('siteLogs', result.lines || 'Nenhuma mensagem recente.');
    } catch (error) { update('siteLogs', error instanceof Error ? error.message : 'Falha na consulta.'); }
  });
  get('siteSettingsForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!selected || !available?.enabled || busy) return;
    const slug = selected.slug;
    const ramMb = Number(asSelect('siteRamChoice').value);
    const cpuCores = Number(asSelect('siteCpuChoice').value);
    const minutes = Number(asSelect('siteIdleChoice').value);
    if (!available.ramChoices.includes(ramMb) || !available.cpuChoices.includes(cpuCores) ||
        !available.idleChoices.includes(minutes)) { note('Valores de configuração inválidos.'); return; }
    if (!confirm('Salvar os novos limites de ' + slug + '?')) return;
    busy = true; controls();
    try {
      if (ramMb !== selected.ramMb || cpuCores !== selected.cpuCores) {
        await call('/apps/' + slug + '/resources', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ramMb, cpuCores })
        });
      }
      if (minutes !== selected.idleMinutes) {
        await call('/apps/' + slug + '/idle', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ minutes })
        });
      }
      await refreshSiteDetail();
      note('Configurações salvas e verificadas na VPS.');
    } catch (error) {
      note('Uma configuração pode ter sido alterada: ' + (error instanceof Error ? error.message : 'falha') + '. Atualize e confira.');
    } finally { busy = false; controls(); }
  });
  Object.assign(window, { refreshSiteDetail });
})();