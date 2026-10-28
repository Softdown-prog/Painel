(() => {
  type Point = { at: string; memoryPercent: number | null; diskPercent: number | null };
  type History = { available: boolean; samples?: Point[]; lastSampleAt?: string | null; explanation?: string };
  type Metric = 'memoryPercent' | 'diskPercent';
  const ns = 'http://www.w3.org/2000/svg';
  const el = (id: string) => document.getElementById(id)!;
  function graph(target: HTMLElement, items: Point[], metric: Metric, name: string) {
    target.replaceChildren();
    const values = items
      .map(point => ({ time: Date.parse(point.at), value: point[metric] }))
      .filter((point): point is {time:number;value:number} =>
        Number.isFinite(point.time) && typeof point.value === 'number' &&
        Number.isFinite(point.value) && point.value >= 0 && point.value <= 100)
      .sort((a, b) => a.time - b.time);
    if (values.length < 2 || values.at(-1)!.time <= values[0].time) {
      target.textContent = 'Aguardando pelo menos duas leituras diferentes.';
      return { count: values.length, label: 'Histórico começando' };
    }
    const width = 360, height = 105, left = 8, right = 352, top = 9, bottom = 90;
    const minTime = values[0].time, maxTime = values.at(-1)!.time;
    const x = (t: number) => left + (t-minTime)/(maxTime-minTime)*(right-left);
    const y = (v: number) => bottom-(v/100)*(bottom-top);
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 360 105');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', name + ': evolução percentual de ' + values.length + ' medições');
    svg.setAttribute('preserveAspectRatio', 'none');
    for (const tick of [25,50,75]) {
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', String(left)); line.setAttribute('x2', String(right));
      line.setAttribute('y1', String(y(tick))); line.setAttribute('y2', String(y(tick)));
      line.setAttribute('stroke', '#343946'); line.setAttribute('stroke-dasharray', '3 5');
      svg.append(line);
    }
    let segment: {time:number;value:number}[] = [];
    const flush = () => {
      if (segment.length >= 2) {
        const polyline = document.createElementNS(ns, 'polyline');
        polyline.setAttribute('points', segment.map(p => x(p.time).toFixed(1)+','+y(p.value).toFixed(1)).join(' '));
        polyline.setAttribute('fill', 'none');
        polyline.setAttribute('stroke', 'currentColor');
        polyline.setAttribute('stroke-width', '2.5');
        polyline.setAttribute('stroke-linecap', 'round');
        polyline.setAttribute('stroke-linejoin', 'round');
        svg.append(polyline);
      }
      segment = [];
    };
    for (const p of values) {
      if (segment.length && p.time - segment.at(-1)!.time > 12*60_000) flush();
      segment.push(p);
    }
    flush();
    for (const p of values) {
      const circle = document.createElementNS(ns, 'circle');
      circle.setAttribute('cx', x(p.time).toFixed(1));
      circle.setAttribute('cy', y(p.value).toFixed(1));
      circle.setAttribute('r', values.length > 50 ? '1.5' : '2.6');
      circle.setAttribute('fill', 'currentColor');
      const tooltip = document.createElementNS(ns, 'title');
      tooltip.textContent = new Date(p.time).toLocaleString('pt-BR')+' · '+p.value.toFixed(1).replace('.', ',')+'%';
      circle.append(tooltip);
      svg.append(circle);
    }
    target.append(svg);
    const time = (t: number) => new Date(t).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    return {count:values.length, label:values[0].value.toFixed(1).replace('.', ',')+'% → '+
      values.at(-1)!.value.toFixed(1).replace('.', ',')+'% · '+time(minTime)+' a '+time(maxTime)};
  }
  function renderResourceHistory(input?: History | null) {
    const meta = el('resourceHistoryMeta');
    const ram = el('resourceRamChart'), disk = el('resourceDiskChart');
    const ramSummary = el('resourceRamSummary'), diskSummary = el('resourceDiskSummary');
    if (!input || input.available !== true || !Array.isArray(input.samples)) {
      meta.textContent = input?.explanation || 'Histórico não confirmado. Verifique se a API da VPS já foi atualizada.';
      ram.replaceChildren(); disk.replaceChildren();
      ram.textContent = 'Sem dados de histórico.'; disk.textContent = 'Sem dados de histórico.';
      ramSummary.textContent = '—'; diskSummary.textContent = '—';
      return;
    }
    const points = input.samples.filter(p => p && typeof p.at === 'string');
    const ramResult = graph(ram, points, 'memoryPercent', 'Memória RAM');
    const diskResult = graph(disk, points, 'diskPercent', 'Armazenamento');
    ramSummary.textContent = ramResult.label;
    diskSummary.textContent = diskResult.label;
    meta.textContent = points.length ? points.length + ' leitura(s) no período de até 24 horas. Coleta automática a cada 5 minutos enquanto a API está ligada.'
      : 'Coleta iniciada. Os gráficos aparecerão após duas medições. Leituras anteriores à implantação não existem.';
  }
  Object.assign(window, { renderResourceHistory });
})();
