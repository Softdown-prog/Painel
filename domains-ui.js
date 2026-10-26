(() => {
    const get = (id) => {
        const target = document.getElementById(id);
        if (!target)
            throw new Error('Elemento ausente: ' + id);
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
        if (!response.ok)
            throw new Error(data.error || 'Falha HTTP ' + response.status);
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
            const publications = result.publications || {};
            const appPicker = get('domainApp');
            appPicker.replaceChildren();
            const eligible = containers.applications.filter(app => app.network === result.network && !result.routes.some(route => route.slug === app.slug));
            for (const app of eligible) {
                const option = document.createElement('option');
                option.value = app.slug;
                option.textContent = app.slug + ' (' + app.image + ')';
                appPicker.append(option);
            }
            const selectedFromApps = Reflect.get(window, 'panelSelectedAppSlug');
            if (typeof selectedFromApps === 'string' && eligible.some(app => app.slug === selectedFromApps)) {
                appPicker.value = selectedFromApps;
            }
            canCreate = result.enabled && eligible.length > 0;
            get('domainCreateButton').disabled = !canCreate;
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
            }
            else if (!eligible.length) {
                hint.textContent = containers.applications.length
                    ? 'Nenhuma aplicação disponível: as existentes já têm endereço ou foram criadas antes da ativação da rede de sites.'
                    : 'Para escolher um endereço, você precisa criar a aplicação primeiro.';
                link.href = '#apps';
                link.textContent = 'Ir para Sites e apps';
            }
            else if (!result.publicationEnabled) {
                hint.textContent = 'Você pode reservar o endereço agora. Para publicar com DNS e HTTPS, falta configurar a credencial restrita do DNS nesta VPS.';
            }
            else {
                hint.textContent = 'Depois de reservar, clique em Publicar. O painel vai configurar o DNS, preparar HTTPS e só confirmará quando o endereço responder pela internet.';
            }
            help.append(hint);
            if (link.textContent)
                help.append(link);
            get('domainCaddyPreview').textContent = snippet.content || 'Nenhuma rota.';
            list.replaceChildren();
            if (!result.routes.length)
                list.textContent = 'Nenhuma rota preparada.';
            for (const route of result.routes) {
                const row = document.createElement('div');
                row.className = 'managed-domain-row';
                const detail = document.createElement('div');
                detail.className = 'managed-domain-info';
                const title = document.createElement('strong');
                title.textContent = route.host;
                const secondary = document.createElement('small');
                const publication = publications[route.slug] || { state: 'reserved', updatedAt: '' };
                const labels = {
                    reserved: 'Reservado — ainda não publicado', dns_ready: 'DNS configurado — preparando HTTPS',
                    certificate_pending: 'Certificado em andamento', published: 'Publicado e confirmado por HTTPS', failed: 'Publicação precisa de atenção'
                };
                secondary.textContent = 'Porta ' + route.port + ' · ' + labels[publication.state] + (publication.message ? ' · ' + publication.message : '');
                detail.append(title, secondary);
                const actions = document.createElement('div');
                actions.className = 'managed-domain-actions';
                const publish = document.createElement('button');
                publish.type = 'button';
                publish.textContent = publication.state === 'published' ? 'Verificar publicação' : 'Publicar';
                publish.disabled = !result.publicationEnabled;
                publish.addEventListener('click', async () => {
                    if (!confirm('Publicar ' + route.host + '? O painel criará ou atualizará apenas o DNS desta aplicação e configurará HTTPS.'))
                        return;
                    publish.disabled = true;
                    try {
                        const response = await call('/domains/' + route.slug + '/publish', { method: 'POST' });
                        await refreshManagedDomains();
                        notice(response.live ? 'Site publicado e confirmado por HTTPS.' : 'DNS e HTTPS foram preparados. Atualize em alguns instantes para conferir o certificado.');
                    }
                    catch (error) {
                        notice(error instanceof Error ? error.message : 'Erro ao publicar endereço.');
                    }
                    finally {
                        publish.disabled = !result.publicationEnabled;
                    }
                });
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.textContent = 'Despublicar e remover';
                remove.disabled = !result.enabled;
                remove.addEventListener('click', async () => {
                    if (!confirm('Despublicar e remover ' + route.host + '? O site deixará de responder nesse endereço, mas a aplicação e seus arquivos serão preservados.'))
                        return;
                    remove.disabled = true;
                    try {
                        await call('/domains/' + route.slug, { method: 'DELETE' });
                        await refreshManagedDomains();
                        notice('Endereço removido. A aplicação e seus arquivos foram preservados.');
                    }
                    catch (error) {
                        notice(error instanceof Error ? error.message : 'Erro ao remover domínio.');
                    }
                    finally {
                        remove.disabled = !result.enabled;
                    }
                });
                actions.append(publish, remove);
                row.append(detail, actions);
                list.append(row);
            }
            notice(result.enabled
                ? (result.publicationEnabled ? 'Área de endereços: ' + result.zone + '. O painel pode publicar endereços configurados.' : 'Área de endereços: ' + result.zone + '. Reserve o endereço enquanto a publicação automática não é configurada.')
                : 'Cadastro indisponível nesta VPS. Veja o guia de tarefas do Codex para ativar a publicação.');
        }
        catch (error) {
            list.textContent = 'Domínios indisponíveis.';
            notice(error instanceof Error ? error.message : 'Erro ao carregar domínios.');
        }
    }
    get('domainCreateForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const slug = get('domainApp').value;
        const port = Number(get('domainPort').value);
        if (!slug || !Number.isSafeInteger(port))
            return;
        if (!confirm('Reservar um endereço para ' + slug + '? Você poderá publicar DNS e HTTPS na próxima etapa.'))
            return;
        const button = get('domainCreateButton');
        button.disabled = true;
        try {
            const data = await call('/domains', { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ slug, port }) });
            await refreshManagedDomains();
            notice('Endereço ' + data.route.host + ' reservado. Clique em Publicar para colocar o site no ar.');
        }
        catch (error) {
            notice(error instanceof Error ? error.message : 'Erro ao criar domínio.');
        }
        finally {
            button.disabled = !canCreate;
        }
    });
    get('domainApp').addEventListener('change', updatePreview);
    get('domainsRefreshButton').addEventListener('click', refreshManagedDomains);
    Object.assign(window, { refreshManagedDomains });
})();
