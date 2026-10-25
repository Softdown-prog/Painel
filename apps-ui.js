(() => {
  let enabled = false;
  function element(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error('Elemento ausente: ' + id);
    return el;
  }
  function input(id) { return element(id); }
  function info(message) { element('appsNotice').textContent = message; }
  async function request(path, options = {}) {
    const response = await fetch('/api' + path, { credentials: 'same-origin', cache: 'no-store', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Falha HTTP ' + response.status);
    return data;
  }
  async function action(app, operation) {
    if (operation === 'logs') {
      try {
        const result = await request('/apps/' + app.slug + '/logs');
        element('appLogs').textContent = result.lines || 'Nenhum log encontrado.';
      } catch (error) { info(error instanceof Error ? error.message : 'Falha ao consultar logs.'); }
      return;
    }
    if (!confirm(operation === 'remove'
      ? 'Remover o container ' + app.name + '? Essa ação não remove volumes externos e não pode ser desfeita.'
      : 'Deseja ' + operation + ' a aplicação ' + app.name + '?')) return;
    try {
      await request('/apps/' + app.slug + (operation === 'remove' ? '' : '/' + operation), { method: operation === 'remove' ? 'DELETE' : 'POST' });
      info(operation === 'remove' ? 'Container removido: ' + app.slug : 'Ação concluída: ' + operation + ' · ' + app.slug);
      await refreshManagedApplications();
    } catch (error) { info(error instanceof Error ? error.message : 'Falha na operação.'); }
  }
  function addButton(container, app, operation, text) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.disabled = !enabled && operation !== 'logs';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await action(app, operation); } finally { button.disabled = !enabled && operation !== 'logs'; }
    });
    container.append(button);
  }
  async function refreshManagedApplications() {
    const list = element('managedApplications');
    list.textContent = 'Carregando aplicações...';
    try {
      const data = await request('/apps');
      enabled = data.enabled;
      const image = element('appImage');
      const current = image.value;
      image.replaceChildren();
      for (const name of data.allowedImages) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        image.append(option);
      }
      if (data.allowedImages.includes(current)) image.value = current;
      input('appCreateButton').disabled = !enabled || !data.allowedImages.length;
      list.replaceChildren();
      if (!data.applications.length) list.textContent = 'Nenhuma aplicação criada pelo painel.';
      for (const app of data.applications) {
        const row = document.createElement('div');
        row.className = 'managed-app-row';
        const detail = document.createElement('div');
        detail.className = 'managed-app-detail';
        const title = document.createElement('strong'); title.textContent = app.slug;
        const subtitle = document.createElement('small');
        subtitle.textContent = app.state + ' · ' + app.image + ' · ' + app.status;
        detail.append(title, subtitle);
        const actions = document.createElement('div'); actions.className = 'managed-app-actions';
        if (app.state === 'running') {
          addButton(actions, app, 'restart', 'Reiniciar');
          addButton(actions, app, 'stop', 'Parar');
        } else addButton(actions, app, 'start', 'Iniciar');
        addButton(actions, app, 'logs', 'Logs');
        if (app.state !== 'running') addButton(actions, app, 'remove', 'Remover');
        row.append(detail, actions);
        list.append(row);
      }
      info(enabled
        ? 'Gerenciamento ativado · ' + data.applications.length + '/' + data.maxApps + ' aplicações. Sem portas públicas ou volumes do host.'
        : 'Somente leitura. O operador precisa habilitar a criação de aplicações na VPS.');
    } catch (error) {
      list.textContent = 'Aplicações indisponíveis.';
      info(error instanceof Error ? error.message : 'Erro ao carregar aplicações.');
    }
  }
  element('appCreateForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!enabled || !confirm('Criar container isolado? Ele não terá domínio nem porta pública; você poderá iniciá-lo depois.')) return;
    const button = input('appCreateButton');
    button.disabled = true;
    try {
      const slug = input('appSlug').value.trim();
      const image = input('appImage').value;
      await request('/apps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug, image }) });
      input('appSlug').value = '';
      await refreshManagedApplications();
      info('Container criado: ' + slug + '. Clique em Iniciar para executá-lo.');
    } catch (error) { info(error instanceof Error ? error.message : 'Não foi possível criar o container.'); }
    finally { button.disabled = !enabled; }
  });
  element('appsRefreshButton').addEventListener('click', refreshManagedApplications);
  Object.assign(window, { refreshManagedApplications });
  if (location.hash === '#apps') refreshManagedApplications();
})();
