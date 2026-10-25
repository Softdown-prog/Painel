(() => {
  const get = (id) => {
    const target = document.getElementById(id);
    if (!target) throw new Error('Elemento ausente: ' + id);
    return target;
  };
  let domainZone = null;
  let canCreate = false;
  function updatePreview() {
    const picker = document.getElementById('domainApp');
    const slug = picker instanceof HTMLSelectElement ? picker.value : '';
    get('domainAddressPreview').textContent = domainZone && slug
      ? 'Endereço proposto: ' + slug + '.' + domainZone + ' (ainda não publicado)'
      : 'O endereço será mostrado aqui assim que a configuração estiver disponível.';
  }
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
      domainZone = result.zone;
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
      canCreate = result.enabled && eligible.length > 0;
      (get('domainCreateButton')).disabled = !canCreate;
      updatePreview();
      const help = get('domainsHelp');
      help.replaceChildren();
      const hint = document.createElement('p');
      const link = document.createElement('a');
      if (!result.enabled) {
        hint.textContent = 'O cadastro de endereços ainda não está ativado nesta VPS. A equipe técnica precisa configurar uma área própria para os sites antes de publicar.';
        link.href = 'https://github.com/Softdown-prog/Painel/blob/main/docs/TAREFAS-CODEX.md';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Ver o que falta configurar (tarefas do Codex)';
      } else if (!eligible.length) {
        hint.textContent = containers.applications.length
          ? 'Nenhuma aplicação disponível: as existentes já têm endereço ou foram criadas antes da ativação da rede de sites.'
          : 'Para escolher um endereço, você precisa criar a aplicação primeiro.';
        link.href = '#apps';
        link.textContent = 'Ir para Sites e apps';
      } else {
        hint.textContent = 'Esta etapa só reserva o endereço no painel. A publicação na internet será feita depois da configuração segura do servidor.';
      }
      help.append(hint);
      if (link.textContent) help.append(link);
      get('domainCaddyPreview').textContent = snippet.content || 'Nenhuma rota.';
      list.replaceChildren();
      if (!result.routes.length) list.textContent = 'Nenhuma rota preparada.';
      for (const route of result.routes) {
        const row = document.createElement('div');
        row.className = 'managed-domain-row';
        const detail = document.createElement('div'); detail.className = 'managed-domain-info';
        const title = document.createElement('strong'); title.textContent = route.host;
        const secondary = document.createElement('small');
        secondary.textContent = 'Porta ' + route.port + ' · Reservado no painel; publicação na internet ainda não confirmada';
        detail.append(title, secondary);
        const remove = document.createElement('button'); remove.type = 'button';
        remove.textContent = 'Remover endereço'; remove.disabled = !result.enabled;
        remove.addEventListener('click', async () => {
          if (!confirm('Remover o endereço ' + route.host + ' da lista? O administrador ainda precisa atualizar a configuração do servidor.')) return;
          remove.disabled = true;
          try {
            await call('/domains/' + route.slug, { method: 'DELETE' });
            await refreshManagedDomains();
            notice('Endereço removido do cadastro. A configuração do servidor ainda precisa ser atualizada.');
          } catch (error) { notice(error instanceof Error ? error.message : 'Erro ao remover domínio.'); }
          finally { remove.disabled = !result.enabled; }
        });
        row.append(detail, remove);
        list.append(row);
      }
      notice(result.enabled
        ? 'Área de endereços: ' + result.zone + '. Reservar não publica o site automaticamente.'
        : 'Cadastro indisponível nesta VPS. Veja o guia de tarefas do Codex para ativar a publicação.');
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
    if (!confirm('Reservar um endereço para ' + slug + '? O endereço não ficará público até a configuração do servidor.')) return;
    const button = get('domainCreateButton');
    button.disabled = true;
    try {
      const data = await call('/domains', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, port }) });
      await refreshManagedDomains();
      notice('Endereço ' + data.route.host + ' reservado. Ele ainda não está publicado na internet.');
    } catch (error) { notice(error instanceof Error ? error.message : 'Erro ao criar domínio.'); }
    finally { button.disabled = !canCreate; }
  });
  get('domainApp').addEventListener('change', updatePreview);
  get('domainsRefreshButton').addEventListener('click', refreshManagedDomains);
  Object.assign(window, { refreshManagedDomains });
})();
