(() => {
    let enabled = false;
    function element(id) {
        const el = document.getElementById(id);
        if (!el)
            throw new Error('Elemento ausente: ' + id);
        return el;
    }
    function input(id) { return element(id); }
    function info(message) { element('appsNotice').textContent = message; }
    async function request(path, options = {}) {
        const response = await fetch('/api' + path, { credentials: 'same-origin', cache: 'no-store', ...options });
        const data = await response.json().catch(() => ({}));
        if (!response.ok)
            throw new Error(data.error || 'Falha HTTP ' + response.status);
        return data;
    }
    async function action(app, operation) {
        if (operation === 'logs') {
            try {
                const result = await request('/apps/' + app.slug + '/logs');
                element('appLogs').textContent = result.lines || 'Nenhum log encontrado.';
            }
            catch (error) {
                info(error instanceof Error ? error.message : 'Falha ao consultar logs.');
            }
            return;
        }
        if (!confirm(operation === 'remove'
            ? 'Remover o container ' + app.name + '? Essa ação não remove volumes externos e não pode ser desfeita.'
            : 'Deseja ' + operation + ' a aplicação ' + app.name + '?'))
            return;
        try {
            await request('/apps/' + app.slug + (operation === 'remove' ? '' : '/' + operation), { method: operation === 'remove' ? 'DELETE' : 'POST' });
            info(operation === 'remove' ? 'Container removido: ' + app.slug : 'Ação concluída: ' + operation + ' · ' + app.slug);
            await refreshManagedApplications();
        }
        catch (error) {
            info(error instanceof Error ? error.message : 'Falha na operação.');
        }
    }
    function addButton(container, app, operation, text) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.disabled = !enabled && operation !== 'logs';
        button.addEventListener('click', async () => {
            button.disabled = true;
            try {
                await action(app, operation);
            }
            finally {
                button.disabled = !enabled && operation !== 'logs';
            }
        });
        container.append(button);
    }
    function choice(values, selected, label) {
        const select = document.createElement('select');
        for (const value of values) {
            const option = document.createElement('option');
            option.value = String(value);
            option.textContent = label(value);
            select.append(option);
        }
        select.value = String(selected);
        return select;
    }
    function settingLabel(title, select) {
        const label = document.createElement('label');
        label.textContent = title;
        label.append(select);
        return label;
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
            if (data.allowedImages.includes(current))
                image.value = current;
            input('appCreateButton').disabled = !enabled || !data.allowedImages.length;
            list.replaceChildren();
            if (!data.applications.length)
                list.textContent = 'Nenhuma aplicação criada pelo painel.';
            for (const app of data.applications) {
                const row = document.createElement('div');
                row.className = 'managed-app-row';
                const detail = document.createElement('div');
                detail.className = 'managed-app-detail';
                const title = document.createElement('strong');
                title.textContent = app.slug;
                const subtitle = document.createElement('small');
                const diskUsed = app.diskUsedBytes == null ? 'disco indisponível' : (app.diskUsedBytes / 1048576).toFixed(1) + ' MB gravados';
                subtitle.textContent = app.state + ' · ' + app.image + ' · ' + (app.ramMb || '—') + ' MB RAM · ' +
                    (app.cpuCores || '—') + ' vCPU · ' + diskUsed;
                detail.append(title, subtitle);
                const actions = document.createElement('div');
                actions.className = 'managed-app-actions';
                if (app.state === 'running') {
                    addButton(actions, app, 'restart', 'Reiniciar');
                    addButton(actions, app, 'stop', 'Parar');
                }
                else
                    addButton(actions, app, 'start', 'Iniciar');
                addButton(actions, app, 'logs', 'Ver registros');
                for (const shortcut of [
                    { text: 'Ligar ao GitHub', hash: '#projects' },
                    { text: 'Escolher endereço', hash: '#domains' }
                ]) {
                    const link = document.createElement('a');
                    link.className = 'app-shortcut';
                    link.href = shortcut.hash;
                    link.textContent = shortcut.text;
                    link.addEventListener('click', () => Object.assign(window, { panelSelectedAppSlug: app.slug }));
                    actions.append(link);
                }
                if (app.state !== 'running')
                    addButton(actions, app, 'remove', 'Remover');
                const controls = document.createElement('div');
                controls.className = 'managed-app-controls';
                const ram = choice(data.ramChoices, app.ramMb, value => value + ' MB');
                const cpu = choice(data.cpuChoices, app.cpuCores, value => value + ' vCPU');
                const saveLimits = document.createElement('button');
                saveLimits.type = 'button';
                saveLimits.textContent = 'Salvar limites';
                saveLimits.disabled = !enabled;
                saveLimits.addEventListener('click', async () => {
                    if (!confirm('Aplicar novos limites de RAM e CPU ao container ' + app.slug + '?'))
                        return;
                    saveLimits.disabled = true;
                    try {
                        await request('/apps/' + app.slug + '/resources', { method: 'POST', headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ ramMb: Number(ram.value), cpuCores: Number(cpu.value) }) });
                        await refreshManagedApplications();
                    }
                    catch (error) {
                        info(error instanceof Error ? error.message : 'Não foi possível atualizar os limites.');
                    }
                    finally {
                        saveLimits.disabled = !enabled;
                    }
                });
                const idle = choice(data.idleChoices, app.idleMinutes, value => value ? value + ' min sem atividade' : 'Desligado');
                const saveIdle = document.createElement('button');
                saveIdle.type = 'button';
                saveIdle.textContent = 'Salvar ociosidade';
                saveIdle.disabled = !enabled;
                saveIdle.addEventListener('click', async () => {
                    if (Number(idle.value) && !confirm('Parar automaticamente ' + app.slug + ' quando não houver atividade de rede ou CPU? O reinício será manual.'))
                        return;
                    saveIdle.disabled = true;
                    try {
                        await request('/apps/' + app.slug + '/idle', { method: 'POST', headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ minutes: Number(idle.value) }) });
                        await refreshManagedApplications();
                    }
                    catch (error) {
                        info(error instanceof Error ? error.message : 'Não foi possível salvar a ociosidade.');
                    }
                    finally {
                        saveIdle.disabled = !enabled;
                    }
                });
                controls.append(settingLabel('RAM máxima', ram), settingLabel('CPU máxima', cpu), saveLimits, settingLabel('Parar por ociosidade', idle), saveIdle);
                const note = document.createElement('small');
                note.textContent = 'Uso de disco é apenas medido; Docker não oferece cota portátil para este volume. Containers parados são iniciados pelo botão Iniciar.';
                controls.append(note);
                row.append(detail, actions, controls);
                list.append(row);
            }
            info(enabled
                ? 'Aplicações no painel: ' + data.applications.length + ' de ' + data.maxApps +
                    ' disponíveis. A aplicação nova começa desligada; publicar na internet é uma etapa separada.'
                : 'Criação indisponível nesta VPS. O administrador precisa liberar as imagens e o gerenciador antes de você criar aplicações.');
        }
        catch (error) {
            list.textContent = 'Aplicações indisponíveis.';
            info(error instanceof Error ? error.message : 'Erro ao carregar aplicações.');
        }
    }
    element('appCreateForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!enabled || !confirm('Criar esta aplicação? Ela começa desligada, sem acesso público; depois você poderá iniciá-la e escolher um endereço.'))
            return;
        const button = input('appCreateButton');
        button.disabled = true;
        try {
            const slug = input('appSlug').value.trim();
            const image = input('appImage').value;
            await request('/apps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
                    slug, image, ramMb: Number(input('appRam').value), cpuCores: Number(input('appCpu').value)
                }) });
            input('appSlug').value = '';
            await refreshManagedApplications();
            info('Aplicação ' + slug + ' criada com segurança. Agora clique em Iniciar e depois use Escolher endereço quando estiver disponível.');
        }
        catch (error) {
            info(error instanceof Error ? error.message : 'Não foi possível criar o container.');
        }
        finally {
            button.disabled = !enabled;
        }
    });
    element('appsRefreshButton').addEventListener('click', refreshManagedApplications);
    Object.assign(window, { refreshManagedApplications });
    if (location.hash === '#apps')
        refreshManagedApplications();
})();
