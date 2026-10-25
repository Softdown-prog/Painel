(() => {
  const get = (id) => {
    const target = document.getElementById(id);
    if (!target) throw new Error('Elemento ausente: ' + id);
    return target;
  };
  const notice = (message) => { get('domainsNotice').textContent = message; };
  async function call(path, options = {}) {
    const response = await fetch('/api' + path, { credentials: 'same-origin', cache: 'no-store', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Falha HTTP ' + response.status);
    return data;
  }
  async function refreshManagedDomains() {
    const list = get('managedDomains');
    list.textContent = 'Consultando domínios...';
    try {
      const [result, containers, snippet] = await Promise.all([
        call('/domains'),
        call('/apps'),
        call('/domains/caddy')
      ]);
      const appPicker = get('domainApp');
      appPicker.replaceChildren();
      const eligible = containers.applications.filter(app =>
        app.network === result.network && !result.routes.some(route => route.slug === app.slug));
      for (const app of eligible) {
        const option = document.createElement('option');
        option.value = app.slug;
        option.textContent = app.slug + ' (' + app.image + ')';
        appPicker.append(option);
      }
      (get('domainCreateButton')).disabled = !result.enabled || eligible.length === 0;
      get('domainCaddyPreview').textContent = snippet.content || 'Nenhuma rota.';
      list.replaceChildren();
      if (!result.routes.length) list.textContent = 'Nenhuma rota preparada.';
      for (const route of result.routes) {
        const row = document.createElement('div');
        row.className = 'managed-domain-row';
        const detail = document.createElement('div'); detail.className = 'managed-domain-info';
        const title = document.createElement('strong'); title.textContent = route.host;
        const secondary = document.createElement('small');
        secondary.textContent = route.slug + ' · porta interna ' + route.port + ' · aguardando recarga do gateway';
        detail.append(title, secondary);
        const remove = document.createElement('button'); remove.type = 'button';
        remove.textContent = 'Remover rota'; remove.disabled = !result.enabled;
        remove.addEventListener('click', async () => {
          if (!confirm('Remover a rota de ' + route.host + '? A alteração só será aplicada após recarregar o gateway.')) return;
          remove.disabled = true;
          try {
            await call('/domains/' + route.slug, { method: 'DELETE' });
            await refreshManagedDomains();
            notice('Rota removida da configuração. Recarregue o gateway para aplicar.');
          } catch (error) { notice(error instanceof Error ? error.message : 'Erro ao remover domínio.'); }
          finally { remove.disabled = !result.enabled; }
        });
        row.append(detail, remove);
        list.append(row);
      }
      notice(result.enabled
        ? 'Zona autorizada: ' + result.zone + '. As rotas só ficam acessíveis após DNS, Caddy frontal e recarga do gateway configurados pelo operador.'
        : 'Modo somente leitura. Habilite PANEL_DOMAINS_ENABLED e configure PANEL_APPS_DOMAIN_ZONE na VPS.');
    } catch (error) {
      list.textContent = 'Domínios indisponíveis.';
      notice(error instanceof Error ? error.message : 'Erro ao carregar domínios.');
    }
  }
  get('domainCreateForm').addEventListener('submit', async event => {
    event.preventDefault();
    const slug = (get('domainApp')).value;
    const port = Number((get('domainPort')).value);
    if (!slug || !Number.isSafeInteger(port)) return;
    if (!confirm('Preparar um subdomínio para ' + slug + ':' + port + '? A rota não será publicada automaticamente.')) return;
    const button = get('domainCreateButton');
    button.disabled = true;
    try {
      const data = await call('/domains', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, port }) });
      await refreshManagedDomains();
      notice('Rota ' + data.route.host + ' preparada. Falta validação de DNS e recarga explícita do gateway.');
    } catch (error) { notice(error instanceof Error ? error.message : 'Erro ao criar domínio.'); }
    finally { button.disabled = false; }
  });
  get('domainsRefreshButton').addEventListener('click', refreshManagedDomains);
  Object.assign(window, { refreshManagedDomains });
})();
