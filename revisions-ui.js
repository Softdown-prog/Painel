(() => {
    const get = (id) => document.getElementById(id);
    const bytes = (size) => size >= 1073741824 ? (size / 1073741824).toFixed(2) + ' GB' : (size / 1048576).toFixed(1) + ' MB';
    const date = (value) => { const d = new Date(value); return Number.isNaN(d.getTime()) ? 'data desconhecida' : d.toLocaleString('pt-BR'); };
    const label = {
        em_uso: 'Em uso', reserva: 'Backup protegido', recente: 'Recente · manter', protegida: 'Protegida',
        antiga: 'Antiga · pode limpar', ausente: 'Não encontrada na VPS'
    };
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
        const entries = get('revisionsEntries');
        entries.replaceChildren();
        if (!report.entries.length) {
            entries.textContent = 'Nenhuma revisão de imagem foi importada por este painel.';
        }
        for (const entry of report.entries) {
            const row = document.createElement('tr');
            row.append(cell('td', entry.slug), cell('td', entry.revision.slice(0, 10)), cell('td', label[entry.status] || entry.status), cell('td', bytes(entry.sizeBytes)), cell('td', date(entry.importedAt)));
            row.title = entry.reason;
            entries.append(row);
        }
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
