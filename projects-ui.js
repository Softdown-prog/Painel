(() => {
    let projects = [];
    let buildsEnabled = false;
    const releaseReady = new Set();
    const importReady = new Set();
    const get = (id) => {
        const el = document.getElementById(id);
        if (!el)
            throw new Error('Elemento ausente: ' + id);
        return el;
    };
    const field = (id) => get(id);
    const notice = (message) => { get('projectsNotice').textContent = message; };
    async function call(path, options = {}) {
        const response = await fetch('/api' + path, { credentials: 'same-origin', cache: 'no-store', ...options });
        const data = await response.json().catch(() => ({}));
        if (!response.ok)
            throw new Error(data.error || 'HTTP ' + response.status);
        return data;
    }
    function button(label, callback, disabled = false) {
        const item = document.createElement('button');
        item.type = 'button';
        item.textContent = label;
        item.disabled = disabled;
        item.addEventListener('click', async () => {
            item.disabled = true;
            try {
                await callback();
            }
            finally {
                item.disabled = disabled;
            }
        });
        return item;
    }
    const publicationLabel = {
        queued: 'Na fila', importing: 'Baixando imagem', staging: 'Preparando versão',
        health: 'Testando versão', promoting: 'Publicando', completed: 'Publicado',
        attention: 'Precisa de revisão', failed: 'Falhou'
    };
    const publishing = new Set();
    const readyForDurable = new Set();
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    async function publishSuccessfulBuild(project, run, host) {
        const slug = project.slug;
        if (publishing.has(slug)) {
            notice('A publicação já está sendo acompanhada.');
            return;
        }
        if (run.conclusion !== 'success' || run.status !== 'completed' || !/^[0-9a-f]{40}$/.test(run.sha)) {
            notice('Selecione um build concluído com sucesso.');
            return;
        }
        if (!confirm('Publicar ' + slug + ' na revisão ' + run.sha.slice(0, 10) +
            '?\n\nA VPS executará os passos e guardará o resultado mesmo se você fechar esta página. ' +
            'A versão anterior continuará disponível para recuperação.'))
            return;
        publishing.add(slug);
        try {
            const answer = await call('/projects/' + slug + '/publication', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ runId: run.id })
            });
            if (answer.job?.runId !== run.id)
                throw new Error('A API não confirmou o build solicitado.');
            notice((answer.alreadyExists ? 'Publicação já registrada. ' : 'Publicação registrada. ') +
                'A VPS continuará executando mesmo se você fechar o navegador.');
            await showReleaseStatus(project, host);
            // Polling is display-only. It is safe for this tab to close during a deployment.
            for (let i = 0; i < 120; i++) {
                await delay(3000);
                const state = await call('/projects/' + slug + '/publication');
                const job = state.history?.find((j) => j.runId === run.id);
                if (!job)
                    throw new Error('A publicação não foi encontrada no servidor.');
                notice('Publicação ' + slug + ': ' + (publicationLabel[job.phase] || job.phase) + ' · ' + job.detail);
                if (['completed', 'failed', 'attention'].includes(job.phase)) {
                    await showReleaseStatus(project, host);
                    return;
                }
            }
            notice('O trabalho continua na VPS. Atualize Projetos GitHub para conferir o andamento.');
        }
        catch (error) {
            notice(error instanceof Error ? error.message : 'Não foi possível acompanhar a publicação.');
        }
        finally {
            publishing.delete(slug);
        }
    }
    async function loadRuns(slug, parent, releaseHost) {
        parent.textContent = 'Carregando execuções...';
        try {
            const data = await call('/projects/' + encodeURIComponent(slug) + '/runs');
            parent.replaceChildren();
            const runs = data.runs;
            if (!runs.length) {
                parent.textContent = 'Sem builds recentes.';
                return;
            }
            for (const run of runs) {
                const line = document.createElement('p');
                const link = document.createElement('a');
                link.href = 'https://github.com/' + projects.find(p => p.slug === slug).repository +
                    '/actions/runs/' + encodeURIComponent(String(run.id));
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.textContent = (run.sha || '').slice(0, 8) + ' · #' + run.id;
                const status = document.createElement('span');
                status.textContent = ' · ' + (run.conclusion || run.status) + ' · ' + new Date(run.createdAt).toLocaleString('pt-BR');
                line.append(link, status);
                if (run.conclusion === 'success' && run.status === 'completed' &&
                    importReady.has(slug) && releaseReady.has(slug) && readyForDurable.has(slug)) {
                    const project = projects.find(p => p.slug === slug);
                    line.append(button('Publicar revisão', () => publishSuccessfulBuild(project, run, releaseHost)));
                }
                if (run.conclusion === 'success' && importReady.has(slug)) {
                    line.append(button('Importar do GHCR', async () => {
                        if (!confirm('Importar esta revisão do GHCR por digest SHA-256? A operação não altera containers em execução.'))
                            return;
                        try {
                            const result = await call('/projects/' + slug + '/images/import', {
                                method: 'POST', headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({ runId: run.id })
                            });
                            notice('Download iniciado para ' + String(result.revision || '').slice(0, 8) +
                                '. Atualize o projeto para conferir o resultado antes de preparar a versão.');
                            const project = projects.find(p => p.slug === slug);
                            if (project)
                                await showReleaseStatus(project, releaseHost);
                        }
                        catch (error) {
                            notice(error instanceof Error ? error.message : 'Falha ao importar imagem.');
                        }
                    }));
                }
                if (run.conclusion === 'success' && releaseReady.has(slug)) {
                    line.append(button('Preparar na VPS', async () => {
                        if (!confirm('Preparar a imagem desta revisão na VPS? A imagem deve ter sido importada previamente. O container atual permanecerá ativo.'))
                            return;
                        try {
                            await call('/projects/' + slug + '/releases/stage', {
                                method: 'POST', headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({ runId: run.id })
                            });
                            notice('Candidata iniciada. Aguarde o HEALTHCHECK e atualize o estado da publicação.');
                            const project = projects.find(p => p.slug === slug);
                            if (project)
                                await showReleaseStatus(project, releaseHost);
                        }
                        catch (error) {
                            notice(error instanceof Error ? error.message : 'Falha ao preparar a imagem.');
                        }
                    }));
                }
                parent.append(line);
            }
        }
        catch (error) {
            parent.textContent = error instanceof Error ? error.message : 'Não foi possível consultar execuções.';
        }
    }
    async function showReleaseStatus(project, host) {
        host.textContent = 'Verificando publicação na VPS...';
        try {
            const status = await call('/projects/' + project.slug + '/releases');
            if (status.enabled)
                releaseReady.add(project.slug);
            else
                releaseReady.delete(project.slug);
            host.replaceChildren();
            const info = document.createElement('small');
            info.textContent = 'Publicação ' + (status.enabled ? 'habilitada' : 'desabilitada') +
                ' · Ativa: ' + (status.current.revision?.slice(0, 8) || status.current.image || 'não informado') +
                (status.candidate ? ' · Candidata ' + String(status.candidate.revision || '').slice(0, 8) +
                    ' (' + status.candidate.health + ')' : '') +
                (status.backup ? ' · Backup disponível' : '');
            host.append(info);
            try {
                const running = await call('/projects/' + project.slug + '/publication');
                if (running.enabled)
                    readyForDurable.add(project.slug);
                else
                    readyForDurable.delete(project.slug);
                const publication = document.createElement('small');
                const job = running.current;
                publication.textContent = !running.enabled ?
                    'Publicação pelo servidor ainda não habilitada na VPS.' :
                    job ? (publicationLabel[job.phase] || job.phase) + ' · ' + job.detail :
                        'Publicação pelo servidor pronta para receber um build.';
                host.append(publication);
            }
            catch {
                readyForDurable.delete(project.slug);
                const message = document.createElement('small');
                message.textContent = 'Publicação persistente indisponível nesta versão da API da VPS.';
                host.append(message);
            }
            const imageStatus = await call('/projects/' + project.slug + '/images/import');
            if (imageStatus.enabled)
                importReady.add(project.slug);
            else
                importReady.delete(project.slug);
            const importLine = document.createElement('small');
            importLine.textContent = 'GHCR: ' + (imageStatus.job?.status || (imageStatus.imported ? 'importado' : 'sem importação')) +
                (imageStatus.imported ? ' · Digest ' + String(imageStatus.imported.digest).slice(0, 20) + '…' : '') +
                (imageStatus.job?.message ? ' · ' + imageStatus.job.message : '');
            host.append(importLine);
            if (status.enabled && status.candidate?.health === 'healthy' && !status.backup) {
                host.append(button('Publicar candidata', async () => {
                    if (!confirm('Substituir ' + project.slug + ' pela candidata saudável? A aplicação poderá ficar indisponível brevemente.'))
                        return;
                    await releaseOperation(project, 'promote', host);
                }));
            }
            if (status.enabled && status.backup && !status.candidate) {
                host.append(button('Restaurar anterior', async () => {
                    if (!confirm('Restaurar a versão anterior de ' + project.slug + '?'))
                        return;
                    await releaseOperation(project, 'rollback', host);
                }));
            }
            if (status.enabled && (status.backup || status.candidate)) {
                host.append(button('Descartar reserva', async () => {
                    if (!confirm('Remover definitivamente o container reserva de ' + project.slug + '? Isso pode eliminar a opção de rollback.'))
                        return;
                    try {
                        await call('/projects/' + project.slug + '/releases/finalize', {
                            method: 'POST', headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ confirm: 'DELETE_BACKUP' })
                        });
                        await showReleaseStatus(project, host);
                    }
                    catch (error) {
                        notice(error instanceof Error ? error.message : 'Falha ao limpar reserva.');
                    }
                }));
            }
        }
        catch (error) {
            host.textContent = error instanceof Error ? error.message : 'Publicação indisponível.';
        }
        try {
            const recovery = await call('/projects/' + project.slug + '/releases/recovery');
            const detail = document.createElement('small');
            detail.textContent = 'Recuperação: ' + recovery.detail;
            host.append(detail);
            if (recovery.enabled && recovery.state === 'recoverable') {
                host.append(button('Restaurar estado seguro', async () => {
                    if (!confirm('Executar recuperação de ' + project.slug + '? A versão anterior poderá ser reiniciada. Confirme somente se nenhuma manutenção externa estiver em andamento.'))
                        return;
                    try {
                        await call('/projects/' + project.slug + '/releases/recovery', {
                            method: 'POST', headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ confirm: 'RESTORE_SAFE_STATE' })
                        });
                        notice('Recuperação executada. Verifique novamente os containers.');
                    }
                    catch (error) {
                        notice(error instanceof Error ? error.message : 'Falha na recuperação.');
                    }
                    await showReleaseStatus(project, host);
                }));
            }
        }
        catch {
            const warning = document.createElement('small');
            warning.textContent = 'Diagnóstico de recuperação indisponível.';
            host.append(warning);
        }
    }
    async function releaseOperation(project, action, host) {
        try {
            await call('/projects/' + project.slug + '/releases/' + action, { method: 'POST' });
            notice(action === 'promote' ? 'Versão publicada. Backup mantido para rollback.' : 'Rollback solicitado e versão anterior restaurada.');
            await showReleaseStatus(project, host);
        }
        catch (error) {
            notice(error instanceof Error ? error.message : 'Falha na operação de release.');
            await showReleaseStatus(project, host);
        }
    }
    async function refreshManagedProjects() {
        const list = get('managedProjects');
        list.textContent = 'Carregando projetos...';
        try {
            const [linked, services, repos] = await Promise.all([
                call('/projects'),
                call('/apps'),
                call('/repositories')
            ]);
            projects = linked.projects;
            buildsEnabled = linked.buildsEnabled;
            const selectApp = get('projectApp');
            const selectRepo = get('projectRepo');
            const previousApp = selectApp.value;
            const previousRepo = selectRepo.value;
            selectApp.replaceChildren();
            selectRepo.replaceChildren();
            for (const app of services.applications) {
                if (projects.some(project => project.slug === app.slug))
                    continue;
                const option = document.createElement('option');
                option.value = app.slug;
                option.textContent = app.slug + ' · ' + app.image;
                selectApp.append(option);
            }
            for (const repo of repos.repositories) {
                const option = document.createElement('option');
                option.value = repo.fullName;
                option.textContent = repo.fullName + ' · ' + repo.workflow;
                selectRepo.append(option);
            }
            if (Array.from(selectApp.options).some(x => x.value === previousApp))
                selectApp.value = previousApp;
            if (Array.from(selectRepo.options).some(x => x.value === previousRepo))
                selectRepo.value = previousRepo;
            field('projectLinkButton').disabled = !selectApp.value || !selectRepo.value;
            list.replaceChildren();
            if (!projects.length)
                list.textContent = 'Nenhuma aplicação vinculada a um repositório.';
            for (const project of projects) {
                const row = document.createElement('article');
                row.className = 'managed-project-row';
                const info = document.createElement('div');
                info.className = 'managed-project-info';
                const label = document.createElement('strong');
                label.textContent = project.slug;
                const detail = document.createElement('small');
                detail.textContent = project.repository +
                    ' · ' + (project.branch || 'repositório desconectado') + ' · ' + (project.workflow || 'sem workflow') +
                    ' · ' + project.services.length + (project.services.length === 1 ? ' serviço' : ' serviços');
                info.append(label, detail);
                const serviceEditor = document.createElement('details');
                const serviceTitle = document.createElement('summary');
                serviceTitle.textContent = 'Serviços deste projeto';
                serviceEditor.append(serviceTitle);
                const assignedElsewhere = new Set(projects.filter(item => item.slug !== project.slug).flatMap(item => item.services));
                for (const app of services.applications.filter(item => !assignedElsewhere.has(item.slug))) {
                    const line = document.createElement('label');
                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.value = app.slug;
                    checkbox.checked = project.services.includes(app.slug);
                    line.append(checkbox, document.createTextNode(' ' + app.slug));
                    serviceEditor.append(line);
                }
                serviceEditor.append(button('Salvar serviços', async () => {
                    const selected = Array.from(serviceEditor.querySelectorAll('input:checked')).map(input => input.value);
                    await call('/projects/' + project.slug + '/services', {
                        method: 'PUT', headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ services: selected })
                    });
                    notice('Serviços do projeto atualizados. Nenhum container foi removido.');
                    await refreshManagedProjects();
                }));
                info.append(serviceEditor);
                const actions = document.createElement('div');
                actions.className = 'managed-project-actions';
                const runs = document.createElement('div');
                runs.className = 'managed-project-runs';
                const releasePanel = document.createElement('div');
                releasePanel.className = 'managed-project-releases';
                const supported = project.workflow === linked.requiredWorkflow &&
                    project.services.length === 1 && project.services[0] === project.slug;
                actions.append(button('Consultar builds', () => loadRuns(project.slug, runs, releasePanel), !supported));
                actions.append(button('Executar build', async () => {
                    if (!confirm('Executar build de ' + project.repository + '? Isso publica uma imagem no GHCR, sem alterar o container da VPS.'))
                        return;
                    try {
                        await call('/projects/' + project.slug + '/build', { method: 'POST' });
                        notice('Build solicitado. Consulte as execuções do GitHub para acompanhar; a VPS não foi alterada.');
                        await loadRuns(project.slug, runs, releasePanel);
                    }
                    catch (error) {
                        notice(error instanceof Error ? error.message : 'Não foi possível executar o build.');
                    }
                }, !buildsEnabled || !supported));
                actions.append(button('Desvincular', async () => {
                    if (!confirm('Desvincular ' + project.slug + '? O container será preservado.'))
                        return;
                    try {
                        await call('/projects/' + project.slug, { method: 'DELETE' });
                        await refreshManagedProjects();
                        notice('Vínculo removido; container preservado.');
                    }
                    catch (error) {
                        notice(error instanceof Error ? error.message : 'Não foi possível desvincular.');
                    }
                }));
                row.append(info, actions, releasePanel, runs);
                list.append(row);
                if (supported)
                    void showReleaseStatus(project, releasePanel);
                else
                    releasePanel.textContent = 'A publicação integrada está disponível para projetos com um serviço principal. Os demais serviços permanecem preservados.';
            }
            notice(buildsEnabled
                ? 'Build habilitado. Somente o workflow panel-app-build.yml é aceito; nenhum container é substituído.'
                : 'Vínculos disponíveis. O administrador precisa habilitar builds na VPS para permitir execuções.');
        }
        catch (error) {
            list.textContent = 'Projetos indisponíveis.';
            notice(error instanceof Error ? error.message : 'Não foi possível carregar projetos.');
        }
    }
    get('projectLinkForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        field('projectLinkButton').disabled = true;
        try {
            await call('/projects', { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ slug: field('projectApp').value, repository: field('projectRepo').value }) });
            await refreshManagedProjects();
            notice('Aplicação e repositório vinculados.');
        }
        catch (error) {
            notice(error instanceof Error ? error.message : 'Erro ao vincular projeto.');
        }
        finally {
            field('projectLinkButton').disabled = !field('projectApp').value || !field('projectRepo').value;
        }
    });
    get('projectsRefreshButton').addEventListener('click', refreshManagedProjects);
    Object.assign(window, { refreshManagedProjects });
})();
