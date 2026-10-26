(() => {
    const get = (id) => document.getElementById(id);
    const fmt = (value) => value >= 1024 ** 4 ? (value / 1024 ** 4).toFixed(2) + ' TB' : value >= 1024 ** 3 ? (value / 1024 ** 3).toFixed(2) + ' GB' : value >= 1024 ** 2 ? (value / 1024 ** 2).toFixed(1) + ' MB' : value + ' B';
    async function call(path, options = {}) { const response = await fetch('/api' + path, { credentials: 'same-origin', cache: 'no-store', ...options }); const data = await response.json().catch(() => ({})); if (!response.ok)
        throw new Error(data.error || 'Falha na VPS.'); return data; }
    function draw(items) { const chart = get('trafficChart'); chart.replaceChildren(); const max = Math.max(1, ...(items || []).map(x => x.rx + x.tx)); for (const item of items || []) {
        const bar = document.createElement('div');
        bar.className = 'traffic-day';
        bar.title = item.date + ' · RX ' + fmt(item.rx) + ' · TX ' + fmt(item.tx);
        const rx = document.createElement('span');
        rx.className = 'traffic-rx';
        rx.style.height = Math.max(2, item.rx / max * 100) + '%';
        const tx = document.createElement('span');
        tx.className = 'traffic-tx';
        tx.style.height = Math.max(2, item.tx / max * 100) + '%';
        bar.append(rx, tx);
        chart.append(bar);
    } if (!(items || []).length)
        chart.textContent = 'O histórico começará nas próximas coletas.'; }
    async function refreshTraffic() { const notice = get('trafficNotice'); notice.textContent = 'Consultando tráfego da VPS...'; try {
        const d = await call('/traffic');
        if (!d.available) {
            notice.textContent = d.message || 'Dados indisponíveis.';
            return;
        }
        const month = d.month;
        get('trafficRx').textContent = fmt(month.rx);
        get('trafficTx').textContent = fmt(month.tx);
        get('trafficTotal').textContent = fmt(month.total);
        get('trafficPercent').textContent = month.percentage.toFixed(1) + '%';
        const bar = get('trafficBar');
        bar.style.width = Math.min(100, month.percentage) + '%';
        bar.className = 'traffic-bar ' + month.alert;
        get('trafficCycle').textContent = 'Ciclo desde ' + month.periodStart + ' · renovação dia ' + d.settings.resetDay;
        get('trafficMeta').textContent = 'Interface externa: ' + d.interface + ' · coleta a cada 5 minutos · início do histórico: ' + (d.historyStartsAt || 'agora');
        notice.textContent = month.alert === 'ok' ? 'Consumo dentro da referência configurada.' : month.alert === 'warning' ? 'Atenção: 70% da referência atingidos.' : month.alert === 'high' ? 'Alerta alto: 85% da referência atingidos.' : 'Alerta crítico: 95% da referência atingidos.';
        get('trafficAllowance').value = (d.settings.allowanceBytes / (1024 ** 4)).toString();
        get('trafficResetDay').value = String(d.settings.resetDay);
        draw(d.daily);
    }
    catch (error) {
        notice.textContent = error instanceof Error ? error.message : 'Dados indisponíveis.';
    } }
    get('trafficForm').addEventListener('submit', async (event) => { event.preventDefault(); const button = get('trafficSave'); button.disabled = true; try {
        await call('/traffic', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ allowanceTb: Number(get('trafficAllowance').value), resetDay: Number(get('trafficResetDay').value) }) });
        await refreshTraffic();
    }
    catch (error) {
        get('trafficNotice').textContent = error instanceof Error ? error.message : 'Não foi possível salvar.';
    }
    finally {
        button.disabled = false;
    } });
    get('trafficRefresh').addEventListener('click', () => void refreshTraffic());
    Object.assign(window, { refreshTraffic });
})();
