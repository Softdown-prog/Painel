"use strict";
(() => {
    const phases = {
        queued: 'NA FILA', importing: 'IMPORTANDO IMAGEM', staging: 'PREPARANDO VERSÃO',
        health: 'CONFERINDO CONTAINER', promoting: 'ATIVANDO VERSÃO',
        completed: 'ETAPAS CONCLUÍDAS', attention: 'REQUER ATENÇÃO', failed: 'FALHOU'
    };
    const el = (id) => document.getElementById(id);
    function renderProjectPublicationHistory(history, error = '') {
        const entries = history.filter(item => item && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.slug));
        el('deployedRevision').textContent = error || 'Histórico dos projetos administrados por este painel.';
        el('deployTag').textContent = error ? 'INDISPONÍVEL' : 'POR PROJETO';
        el('deployRuntimeDetails').textContent = error ||
            'O histórico registra as etapas da publicação. Abra a aplicação para conferir a imagem atual, os registros e o acesso ao site.';
        const table = el('deployTable'), header = table.firstElementChild;
        const rows = entries.map(item => {
            const row = document.createElement('div');
            row.className = 'deploy-row';
            const project = document.createElement('span'), link = document.createElement('a');
            link.href = '#site?slug=' + encodeURIComponent(item.slug);
            link.textContent = item.slug;
            project.append(link);
            const source = document.createElement('span');
            source.textContent = item.repository + (item.revision ? ' · ' + item.revision.slice(0, 8) : '');
            const state = document.createElement('span'), badge = document.createElement('i'), detail = document.createElement('small');
            badge.className = 'status-badge';
            badge.textContent = phases[item.phase] || 'ESTADO NÃO CONFIRMADO';
            detail.textContent = item.detail;
            state.append(badge, detail);
            const date = document.createElement('span');
            const time = Date.parse(item.createdAt);
            date.textContent = Number.isFinite(time) ? new Date(time).toLocaleString('pt-BR') : 'Data não informada';
            row.append(project, source, state, date);
            return row;
        });
        table.replaceChildren(...(header ? [header] : []), ...rows);
        const activity = el('activityList');
        activity.replaceChildren();
        for (const item of entries.slice(0, 3)) {
            const row = document.createElement('div');
            row.className = 'timeline-item';
            const copy = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('p');
            title.textContent = item.slug + ' · ' + (phases[item.phase] || 'Estado não confirmado');
            detail.textContent = item.detail;
            copy.append(title, detail);
            row.append(copy);
            activity.append(row);
        }
        if (!entries.length) {
            const empty = document.createElement('p');
            empty.textContent = error || 'Ainda não há publicações registradas. Abra Projetos GitHub para acompanhar cada aplicação.';
            table.append(empty);
            activity.textContent = empty.textContent;
        }
        el('activityTag').textContent = 'PROJETOS';
        const footer = document.querySelector('.activity-footer');
        if (footer)
            footer.textContent = 'Consulte cada aplicação para conferir seu estado e o acesso ao site.';
    }
    Object.assign(window, { renderProjectPublicationHistory });
})();
