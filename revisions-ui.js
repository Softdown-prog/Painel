(() => {
    const get = (id) => document.getElementById(id);
    const bytes = (size) => size >= 1073741824 ? (size / 1073741824).toFixed(2) + ' GB' : (size / 1048576).toFixed(1) + ' MB';
    const date = (value) => { const d = new Date(value); return Number.isNaN(d.getTime()) ? 'data desconhecida' : d.toLocaleString('pt-BR'); };
    const label = {
        em_uso: 'Em uso', reserva: 'Backup protegido', recente: 'Recente · manter', protegida: 'Protegida',
        antiga: 'Antiga · pode limpar', ausente: 'Não encontrada na VPS'
    };
    let reportCache = null;
    let liveRuns = [];
    function stateBadge(kind, title) {
        const badge = document.createElement('span');
        badge.className = 'revision-ci-stage revision-ci-' + (['running','success','failed','warning'].includes(kind)?kind:'neutral');
        const icon = document.createElement('span');
        icon.className = 'revision-ci-dot';
        icon.textContent = kind==='success'?'✓':kind==='failed'?'×':kind==='warning'?'!':'';
        icon.setAttribute('aria-hidden','true');
        const text=document.createElement('span'); text.textContent=title;
        badge.append(icon,text);
        return badge;
    }
    function renderRevisionRows(){
        const target=get('revisionsEntries');target.replaceChildren();
        const imports=reportCache?.entries||[];
        const shown=new Set();
        for(const run of liveRuns.slice(0,30)){
            const imported=imports.find(entry=>entry.slug===run.slug && entry.revision.toLowerCase()===run.sha);
            if(imported)shown.add(imported.slug+'/'+imported.revision);
            const row=document.createElement('tr');row.className='revision-live-row';
            const revisionCell=document.createElement('td');
            const link=document.createElement('a');link.href=run.url;link.target='_blank';link.rel='noopener noreferrer';
            link.textContent=run.sha.slice(0,10)+' · GitHub #'+run.runId;
            revisionCell.append(link);
            const stageCell=document.createElement('td');stageCell.className='revision-pipeline-cell';
            stageCell.append(stateBadge(run.ci.kind,run.ci.label),stateBadge(run.vps.kind,run.vps.label));
            const retainCell=document.createElement('td');
            retainCell.append(imported?stateBadge(imported.status==='ausente'||imported.status==='antiga'?'warning':'neutral',
                label[imported.status]||imported.status):stateBadge('neutral','Imagem não registrada'));
            row.append(cell('td',run.slug),revisionCell,stageCell,retainCell,
                cell('td',imported?bytes(imported.sizeBytes):'—'),cell('td',date(run.createdAt)));
            row.title=imported?.reason||'Execução observada no GitHub. Não é prova de importação ou ativação na VPS.';
            target.append(row);
        }
        for(const entry of imports){
            if(shown.has(entry.slug+'/'+entry.revision))continue;
            const row=document.createElement('tr');
            const pipeline=document.createElement('td');pipeline.className='revision-pipeline-cell';
            pipeline.append(stateBadge('neutral','Execução GitHub não vinculada'));
            const retention=document.createElement('td');
            retention.append(stateBadge(entry.status==='ausente'||entry.status==='antiga'?'warning':'neutral',
                label[entry.status]||entry.status));
            row.append(cell('td',entry.slug),cell('td',entry.revision.slice(0,10)),pipeline,retention,
                cell('td',bytes(entry.sizeBytes)),cell('td',date(entry.importedAt)));
            row.title=entry.reason;target.append(row);
        }
        if(!target.children.length){
            const row=document.createElement('tr'),empty=cell('td','Nenhuma revisão recebida. Consulte a conexão com o GitHub e a VPS.');
            empty.setAttribute('colspan','6');row.append(empty);target.append(row);
        }
    }
    async function call(path, options = {}) {
        return window.panelApi.request(path, options);
    }
    function info(text) { get('revisionsNotice').textContent = text; }
    function cell(tag, value) {
        const element = document.createElement(tag);
        element.textContent = value;
        return element;
    }
    function render(report) {
        get('revisionsCheckedAt').textContent = 'Última verificação: ' + date(report.checkedAt);
        get('revisionsCount').textContent = String(report.totalImports);
        get('revisionsOldCount').textContent = String(report.oldCount);
        get('revisionsOldSize').textContent = bytes(report.oldBytesEstimate);
        get('revisionsAuto').textContent = report.automatic && report.enabled ? 'Ligada · a cada 6 horas' : 'Desligada';
        get('revisionsCompose').textContent = report.scheduler?.enabledByCompose
            ? 'Compose: rotina habilitada · intervalo de ' + (report.scheduler.intervalHours || 6) + ' horas.'
            : 'Compose: rotina desabilitada na VPS.';
        get('revisionsRetention').textContent = 'Mantendo pelo menos ' + report.keepPerApp +
            ' revisões por aplicação e protegendo as importadas há menos de ' + report.ageDays + ' dias.';
        const autoButton = get('revisionsAutoButton');
        autoButton.disabled = !report.enabled;
        autoButton.textContent = report.automatic ? 'Pausar limpeza automática' : 'Ativar limpeza automática';
        autoButton.dataset.automatic = String(report.automatic);
        const button = get('revisionsCleanupButton');
        button.disabled = !report.enabled || report.oldCount === 0;
        button.title = !report.enabled ? 'A limpeza precisa ser habilitada pelo administrador na VPS.' : report.oldCount === 0 ? 'Não há imagens antigas elegíveis.' : 'Excluir apenas imagens antigas verificadas';
        reportCache=report;
        renderRevisionRows();
        const host = report.hostInventory;
        const hostTable = get('revisionsHostImages');
        hostTable.replaceChildren();
        const groups = get('revisionsHostGroups');
        groups.replaceChildren();
        if (!host?.available) {
            get('revisionsHostSummary').textContent = 'Não foi possível consultar o inventário completo do Docker nesta VPS.';
            hostTable.append(cell('tr', '')); // The table remains empty until the next successful refresh.
        }
        else {
            get('revisionsHostSummary').textContent = host.total + ' imagens Docker encontradas · ' + host.untagged +
                ' sem tag · tamanhos somados: ' + bytes(host.totalBytesEstimate) +
                ' (estimativa, sem deduplicar camadas compartilhadas).';
            for (const group of host.multipleVersionRepositories) {
                const span = cell('span', group.repository + ' · ' + group.versions + ' versões locais');
                groups.append(span);
            }
            if (!host.multipleVersionRepositories.length)
                groups.textContent = 'Nenhum repositório com múltiplas versões identificado nas imagens listadas.';
            for (const image of host.images.slice(0, 75)) {
                const row = document.createElement('tr');
                row.append(cell('td', image.tags.join(', ') || '(sem tag)'), cell('td', image.id.slice(0, 18)), cell('td', bytes(image.sizeBytes)), cell('td', image.createdAt ? date(image.createdAt) : 'desconhecida'));
                hostTable.append(row);
            }
            if (!host.images.length)
                hostTable.textContent = 'Nenhuma imagem listada.';
        }
        const history = get('revisionsHistory');
        history.replaceChildren();
        if (!report.history.length)
            history.textContent = 'Nenhuma limpeza foi registrada neste painel.';
        for (const item of [...report.history].reverse().slice(0, 12)) {
            const row = document.createElement('div');
            row.className = 'revision-history-line';
            row.append(cell('strong', date(item.at)), cell('span', (item.source === 'automatic' ? 'Automática' : 'Manual') +
                ' · ' + item.removed + ' removidas · ' + item.failed + ' falhas · ' + bytes(item.bytesEstimate)));
            history.append(row);
        }
        info(report.enabled ?
            'Limpeza de imagens autorizada. A versão ativa e o backup não serão excluídos. Espaço indicado é uma estimativa; camadas Docker podem ser compartilhadas.' :
            'Consulta disponível. Limpeza desligada na VPS; nenhuma imagem será apagada automaticamente.');
    }
    async function refreshManagedRevisions() {
        info('Conferindo revisões e versões antigas na VPS...');
        try {
            render(await call('/maintenance/revisions'));
        }
        catch (error) {
            reportCache=null;
            renderRevisionRows();
            get('revisionsCleanupButton').setAttribute('disabled', '');
            info('A API ainda não oferece esta consulta ou a VPS está indisponível: ' +
                (error instanceof Error ? error.message : 'falha inesperada') +
                '. O frontend sozinho não consegue garantir que imagens antigas foram removidas.');
        }
    }
    get('revisionsAutoButton').addEventListener('click', async () => {
        const element = get('revisionsAutoButton');
        const next = element.dataset.automatic !== 'true';
        if (!confirm(next
            ? 'Ativar limpeza automática a cada 6 horas?\n\nSomente imagens importadas há mais de 14 dias e fora das duas versões preservadas por aplicação poderão ser removidas.'
            : 'Pausar a limpeza automática de revisões antigas?'))
            return;
        element.disabled = true;
        try {
            const result = await call('/maintenance/revisions/settings', { method: 'POST',
                headers: { 'content-type': 'application/json' }, body: JSON.stringify({ automatic: next }) });
            info(result.message || 'Configuração salva.');
            await refreshManagedRevisions();
        }
        catch (error) {
            info(error instanceof Error ? error.message : 'Não foi possível mudar a limpeza automática.');
            await refreshManagedRevisions();
        }
    });
    get('revisionsRefreshButton').addEventListener('click', () => void refreshManagedRevisions());
    get('revisionsCleanupButton').addEventListener('click', async () => {
        if (!confirm('Excluir SOMENTE imagens antigas importadas pelo Painel?\\n\\nA versão em uso, backups, containers e volumes serão preservados. A operação não poderá ser desfeita.'))
            return;
        const btn = get('revisionsCleanupButton');
        btn.disabled = true;
        info('Solicitando limpeza de imagens antigas...');
        try {
            const result = await call('/maintenance/revisions/cleanup', { method: 'POST',
                headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'LIMPAR_REVISOES_ANTIGAS' }) });
            info('Limpeza solicitada: ' + result.removed + ' imagens removidas, ' + result.failed + ' falhas. Atualizando...');
            await refreshManagedRevisions();
        }
        catch (error) {
            info(error instanceof Error ? error.message : 'Falha ao limpar imagens antigas.');
            await refreshManagedRevisions();
        }
    });
    Object.assign(window, { refreshManagedRevisions });
})();
