(() => {
  type LineKind = 'command' | 'response' | 'error' | 'success' | 'muted';
  const input = document.getElementById('terminalInput') as HTMLInputElement;
  const form = document.getElementById('terminalForm') as HTMLFormElement;
  const output = document.getElementById('terminalOutput') as HTMLElement;
  const runButton = document.getElementById('terminalRunButton') as HTMLButtonElement;
  const connection = document.getElementById('terminalConnection') as HTMLElement;
  const light = document.getElementById('terminalLight') as HTMLElement;
  if (!input || !form || !output || !runButton || !connection || !light) return;

  const history: string[] = [];
  let historyIndex = 0;
  let busy = false;
  let sshToken: string | null = null;
  const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const SERVICES = ['app', 'agent', 'sandbox', 'embeddings', 'caddy', 'portainer'];
  const ACTIONS: Record<string, string> = { iniciar: 'start', parar: 'stop', reiniciar: 'restart' };
  const HELP = [
    'COMANDOS DA VPS',
    '  ajuda                            mostra esta lista',
    '  status                           situação geral da VPS',
    '  recursos                         memória, CPU e espaço em disco',
    '  servicos                         componentes da Softload',
    '  apps                             seus containers de hospedagem',
    '  dominios                         endereços reservados (não garante publicação)',
    '  repos                            repositórios GitHub conectados',
    '  projetos                         aplicações ligadas ao GitHub',
    '  deploys                          publicações recentes',
    '  logs <nome>                      últimas mensagens de um serviço ou app',
    '  iniciar <nome>                   liga um serviço ou app',
    '  parar <nome>                     desliga um serviço ou app',
    '  reiniciar <nome>                 reinicia um serviço ou app',
    '  app criar <nome> <imagem> [ram] [cpu]',
    '                                   cria app autorizado; RAM em MB (padrão 256), CPU (padrão 0.5)',
    '  app recursos <nome> <ram> <cpu>  altera limites de um app',
    '  app remover <nome>               exclui um app parado sem domínio',
    '  dominio criar <app> <porta>      reserva endereço (não publica na internet)',
    '  dominio remover <app>            remove endereço reservado',
    '  limpar                           limpa a tela',
    '  revisoes                         lista versões antigas e protegidas',
    '  revisoes limpar                  limpa apenas imagens antigas aprovadas',
    '  revisoes auto ligar|desligar     altera a limpeza automática no painel',
    '  historico                        mostra comandos desta sessão',
    '  linux <comando>                  executa na VPS via SSH, se o administrador ativou',
    '  linux travar                     bloqueia o acesso Linux novamente',
    '',
    'ATALHOS COMPATÍVEIS: docker ps, docker logs <nome>, docker restart <nome>.',
    'O modo linux usa SSH opcional, com senha do painel para desbloqueio.',
    'Sem SSH configurado, somente os comandos administrativos acima funcionam.',
    'Os comandos usam a API administrativa da VPS; alterações pedem confirmação.'
  ].join('\n');

  function line(message: string, kind: LineKind = 'response'): void {
    const div = document.createElement('div');
    div.className = 'terminal-line terminal-' + kind;
    div.textContent = message.slice(0, 30000);
    output.append(div);
    while (output.childElementCount > 100) output.firstElementChild?.remove();
    output.scrollTop = output.scrollHeight;
  }
  function setConnection(ok: boolean, message: string): void {
    light.classList.toggle('connected', ok);
    connection.textContent = message;
  }
  async function api(path: string, options: RequestInit = {}): Promise<any> {
    const response = await fetch('/api' + path, { ...options, cache: 'no-store', credentials: 'same-origin' });
    let result: any;
    try { result = await response.json(); } catch { throw new Error('A VPS respondeu em formato inesperado.'); }
    if (!response.ok) {
      if (response.status === 401) setConnection(false, 'Entre novamente no painel');
      throw new Error(result.error || 'Erro HTTP ' + response.status);
    }
    return result;
  }
  const fmt = (bytes: number) => Number.isFinite(bytes) ? (bytes / 1073741824).toFixed(1) + ' GB' : 'indisponível';
  const symbol = (state: string) => state === 'running' ? '● ativo' : state === 'exited' ? '○ parado' : '◌ ' + (state || 'desconhecido');
  function validSlug(value: string): boolean { return value.length >= 2 && value.length <= 40 && SLUG.test(value); }
  function validateName(name: string): string {
    if (!validSlug(name)) throw new Error('Nome inválido. Use letras minúsculas e traços (ex.: loja-cliente).');
    return encodeURIComponent(name);
  }
  function confirmAction(action: string, target: string, consequences: string): boolean {
    return confirm(action + ' "' + target + '" na VPS?\n\n' + consequences);
  }
  async function mutate(path: string, method: string, data?: object): Promise<any> {
    const result = await api(path, { method, ...(data ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) } : {}) });
    setConnection(true, 'API da VPS conectada');
    return result;
  }
  async function runCommand(command: string): Promise<string> {
    const args = command.trim().split(/\s+/);
    let cmd = args[0].toLowerCase();
    if (cmd === 'docker') {
      if (args[1] === 'ps' && args.length === 2) { cmd = 'servicos'; args.splice(0, args.length, cmd); }
      else if (args[1] === 'logs' && args.length === 3) { cmd = 'logs'; args.splice(0, args.length, cmd, args[2]); }
      else if (args[1] === 'restart' && args.length === 3) { cmd = 'reiniciar'; args.splice(0, args.length, cmd, args[2]); }
      else throw new Error('Docker direto não está liberado. Digite ajuda para ver os comandos disponíveis.');
    }
    if (cmd === 'linux') {
      const shellCommand = command.slice(5).trim();
      if (!shellCommand) throw new Error('Uso: linux <comando> — Exemplo: linux uptime');
      if (shellCommand === 'travar') {
        if (sshToken) {
          try { await api('/terminal/ssh/lock', { method: 'POST' }); } finally { sshToken = null; }
        }
        return 'Terminal Linux bloqueado. A próxima operação exigirá sua senha administrativa.';
      }
      const state = await api('/terminal/ssh/status');
      if (!state.enabled) throw new Error('Modo Linux ainda não foi ativado na VPS. Os comandos administrativos continuam disponíveis.');
      if (!state.configured) throw new Error('O acesso SSH ainda precisa ser configurado na VPS. Consulte o guia técnico.');
      if (!sshToken || !state.unlocked) {
        sshToken = null;
        const password = prompt('Confirme a senha do painel para desbloquear comandos Linux por 10 minutos:');
        if (!password) return 'Operação cancelada.';
        const auth = await api('/terminal/ssh/unlock', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
        sshToken = auth.token;
      }
      try {
        const result = await api('/terminal/ssh/exec', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: shellCommand, token: sshToken }) });
        return 'LINUX DA VPS · código de saída ' + result.exitCode +
          (result.timedOut ? ' · tempo limite atingido' : '') +
          (result.truncated ? ' · saída limitada' : '') + '\n' +
          (result.output || '(comando concluído sem saída)');
      } catch (error) {
        if (error instanceof Error && /bloqueado|desbloqueie/i.test(error.message)) sshToken = null;
        throw error;
      }
    }
    if (cmd === 'ajuda' || cmd === 'help' || cmd === '?') return HELP;
    if (cmd === 'revisoes') {
      if (args.length === 1) {
        const d = await api('/maintenance/revisions');
        const rows = [
          'REVISÕES DA VPS',
          '  Registradas: ' + d.totalImports + ' · antigas elegíveis: ' + d.oldCount,
          '  Espaço estimado: ' + fmt(d.oldBytesEstimate),
          '  Limpeza automática: ' + (d.automatic && d.enabled ? 'ligada (a cada 6h)' : 'desligada'),
          '  Retenção: últimas ' + d.keepPerApp + ' revisões/app; prazo ' + d.ageDays + ' dias'
        ];
        for (const r of d.entries || []) rows.push('  ' + r.slug + '  ' +
          String(r.revision||'').slice(0,8) + '  ' + r.status);
        return rows.join('\n');
      }
      if (args[1] === 'limpar' && args.length === 2) {
        if (!confirmAction('Limpar revisões antigas', 'VPS', 'Remove apenas imagens antigas, sem apagar containers ou volumes.')) return 'Cancelado.';
        const result = await mutate('/maintenance/revisions/cleanup','POST',{confirm:'LIMPAR_REVISOES_ANTIGAS'});
        return 'Limpeza concluída: ' + result.removed + ' removidas · ' + result.failed + ' falhas.';
      }
      if (args[1] === 'auto' && args.length === 3 && ['ligar','desligar'].includes(args[2])) {
        const automatic = args[2] === 'ligar';
        if (!confirmAction(automatic?'Ativar limpeza automática':'Pausar limpeza automática', 'VPS',
          automatic ? 'Verifica a cada seis horas, protegendo backups e duas últimas revisões/app.' : 'Nenhuma imagem será apagada automaticamente.'))
          return 'Cancelado.';
        const result = await mutate('/maintenance/revisions/settings','POST',{automatic});
        return result.message||'Configuração alterada.';
      }
      throw new Error('Uso: revisoes | revisoes limpar | revisoes auto ligar | revisoes auto desligar');
    }
    if (cmd === 'historico') return history.map((x, i) => String(i + 1).padStart(2) + '  ' + x).join('\n') || 'Nenhum comando anterior.';
    if (cmd === 'limpar' || cmd === 'clear') { output.replaceChildren(); return 'Tela limpa.'; }
    if (cmd === 'status' || cmd === 'recursos') {
      if (args.length !== 1) throw new Error('Uso: ' + cmd);
      const d = await api('/overview');
      setConnection(true, 'API da VPS conectada');
      const services = d.services || [];
      const running = services.filter((x: any) => x.state === 'running').length;
      const lines = [
        'VPS SOFTLOAD — dados informados pela API',
        '  Serviços Softload: ' + running + '/' + services.length + ' ativos',
        '  Memória: ' + fmt(d.memory?.used) + ' / ' + fmt(d.memory?.total),
        '  CPU (carga 1 min): ' + (d.cpu?.load1 ?? '—') + ' em ' + (d.cpu?.cores ?? '—') + ' núcleos',
        '  Disco reportado: ' + (d.disk ? fmt(d.disk.used) + ' / ' + fmt(d.disk.total) : 'não disponível'),
        '  Versão Softload: ' + (d.currentSha?.slice(0, 12) || 'não informada'),
        '  Atualizado: ' + (d.updatedAt ? new Date(d.updatedAt).toLocaleString('pt-BR') : 'agora')
      ];
      return lines.join('\n');
    }
    if (cmd === 'servicos') {
      if (args.length !== 1) throw new Error('Uso: servicos');
      const data = await api('/services');
      return 'SERVIÇOS SOFTLOAD\n' + (data.services || []).map((s: any) =>
        '  ' + String(s.id).padEnd(12) + symbol(s.state) + '  ' + (s.status || '')).join('\n');
    }
    if (cmd === 'apps') {
      if (args.length !== 1) throw new Error('Uso: apps');
      const data = await api('/apps');
      const apps = data.applications || [];
      return 'SITES E APPS (' + apps.length + '/' + data.maxApps + ')\n' +
        (apps.length ? apps.map((a: any) =>
          '  ' + String(a.slug).padEnd(24) + symbol(a.state) + '  RAM ' + (a.ramMb || '—') + ' MB').join('\n')
          : '  Nenhuma aplicação cadastrada.') + '\n' +
        (data.enabled ? '' : 'Criação e alterações desabilitadas no servidor.');
    }
    if (cmd === 'dominios' || cmd === 'enderecos') {
      if (args.length !== 1) throw new Error('Uso: dominios');
      const d = await api('/domains');
      return 'ENDEREÇOS (' + (d.zone || 'zona não configurada') + ')\n' +
        (d.routes?.length ? d.routes.map((r: any) => '  ' + r.host + ' → ' + r.slug + ':' + r.port + '  [reservado; publicação não verificada]').join('\n')
          : '  Nenhum endereço reservado.') +
        '\n' + (d.enabled ? 'Cadastro disponível.' : 'Cadastro desabilitado na VPS.');
    }
    if (cmd === 'repos' || cmd === 'github') {
      if (args.length !== 1) throw new Error('Uso: repos');
      const d = await api('/repositories');
      return 'GITHUB\n' + (d.repositories?.length ? d.repositories.map((r: any) =>
        '  ' + (r.fullName || r.repository || JSON.stringify(r)) + '  [' + (r.branch || 'main') + ']').join('\n')
        : '  Nenhum repositório conectado.') + '\nCredencial no servidor: ' + (d.tokenConfigured ? 'configurada' : 'não configurada');
    }
    if (cmd === 'projetos') {
      if (args.length !== 1) throw new Error('Uso: projetos');
      const d = await api('/projects');
      const projects = d.projects || [];
      return 'PROJETOS LIGADOS AO GITHUB\n' +
        (projects.length ? projects.map((p: any) => '  ' + p.slug + ' → ' + p.repository).join('\n') : '  Nenhum projeto vinculado.');
    }
    if (cmd === 'deploys' || cmd === 'publicacoes') {
      if (args.length !== 1) throw new Error('Uso: deploys');
      const d = await api('/deploys');
      return 'PUBLICAÇÕES SOFTLOAD\n' + (d.runs?.length ?
        d.runs.slice(0, 8).map((r: any) => '  ' + String(r.sha || '').slice(0, 8) + '  ' +
          (r.conclusion || r.status) + '  ' + (r.branch || 'main')).join('\n') : '  Nenhuma execução disponível.');
    }
    if (cmd === 'logs') {
      if (args.length !== 2) throw new Error('Uso: logs <nome-do-serviço-ou-app>');
      const target = args[1];
      let path: string;
      if (SERVICES.includes(target)) path = '/services/' + target + '/logs?tail=100';
      else path = '/apps/' + validateName(target) + '/logs';
      const d = await api(path);
      return 'REGISTROS: ' + target + '\n' + (d.lines || 'Nenhuma mensagem recente.');
    }
    if (Object.hasOwn(ACTIONS, cmd)) {
      if (args.length !== 2) throw new Error('Uso: ' + cmd + ' <serviço-ou-app>');
      const target = args[1];
      const action = ACTIONS[cmd];
      const isService = SERVICES.includes(target);
      if (isService && (target === 'caddy' || target === 'portainer'))
        throw new Error('Caddy e Portainer são somente leitura neste painel.');
      const path = isService ? '/services/' + target + '/' + action : '/apps/' + validateName(target) + '/' + action;
      if (!confirmAction(cmd, target, 'O estado do container será alterado na VPS.')) return 'Operação cancelada.';
      await mutate(path, 'POST');
      return 'Concluído: ' + cmd + ' ' + target + '.';
    }
    if (cmd === 'app') {
      const operation = args[1];
      if (operation === 'criar' && args.length >= 4 && args.length <= 6) {
        const name = args[2];
        validateName(name);
        const image = args[3];
        const ramMb = Number(args[4] || 256);
        const cpuCores = Number(args[5] || 0.5);
        const configured = await api('/apps');
        if (!configured.enabled) throw new Error('Criação ainda não está habilitada na API da VPS.');
        if (!configured.allowedImages?.includes(image)) throw new Error('Imagem não autorizada. Veja as imagens disponíveis em Sites e apps.');
        if (!configured.ramChoices?.includes(ramMb) || !configured.cpuChoices?.includes(cpuCores))
          throw new Error('Limites não autorizados. Veja as opções em Sites e apps.');
        if (!confirmAction('Criar aplicação', name, 'Imagem: ' + image + '\nRAM: ' + ramMb + ' MB; CPU: ' + cpuCores + '.\nComeçará desligada e sem domínio.'))
          return 'Operação cancelada.';
        await mutate('/apps', 'POST', { slug: name, image, ramMb, cpuCores });
        return 'Aplicação criada: ' + name + '. Digite iniciar ' + name + ' para ligá-la.';
      }
      if (operation === 'recursos' && args.length === 5) {
        const name = args[2]; validateName(name);
        const ramMb = Number(args[3]); const cpuCores = Number(args[4]);
        if (!Number.isFinite(ramMb) || !Number.isFinite(cpuCores)) throw new Error('Informe RAM em MB e CPU numérica.');
        if (!confirmAction('Ajustar memória/processador', name, 'RAM: ' + ramMb + ' MB; CPU: ' + cpuCores)) return 'Operação cancelada.';
        await mutate('/apps/' + name + '/resources', 'POST', { ramMb, cpuCores });
        return 'Limites atualizados para ' + name + '.';
      }
      if (operation === 'remover' && args.length === 3) {
        const name = args[2]; validateName(name);
        if (!confirmAction('Remover aplicação', name, 'Exige que o container esteja parado e sem domínio vinculado. A exclusão não pode ser desfeita.'))
          return 'Operação cancelada.';
        await mutate('/apps/' + name, 'DELETE');
        return 'Aplicação removida: ' + name + '.';
      }
      throw new Error('Uso: app criar <nome> <imagem> [ram] [cpu] | app recursos <nome> <ram> <cpu> | app remover <nome>');
    }
    if (cmd === 'dominio') {
      if (args[1] === 'criar' && args.length === 4) {
        const name = args[2]; validateName(name);
        const port = Number(args[3]);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Porta deve ser entre 1024 e 65535.');
        if (!confirmAction('Reservar domínio', name, 'Porta interna: ' + port + '. Atenção: isto NÃO publica o site na internet.'))
          return 'Operação cancelada.';
        const d = await mutate('/domains', 'POST', { slug: name, port });
        return 'Endereço reservado: ' + d.route.host + '\nA publicação pública ainda depende de DNS, HTTPS e recarga do gateway.';
      }
      if (args[1] === 'remover' && args.length === 3) {
        const name = args[2]; validateName(name);
        if (!confirmAction('Remover domínio', name, 'Será removido do cadastro; a configuração do gateway ainda exige atualização.'))
          return 'Operação cancelada.';
        await mutate('/domains/' + name, 'DELETE');
        return 'Endereço removido do cadastro. A publicação no gateway pode exigir recarga.';
      }
      throw new Error('Uso: dominio criar <app> <porta> | dominio remover <app>');
    }
    throw new Error('Comando não disponível: ' + cmd + '. Digite ajuda.\nEste terminal não executa bash, sudo nem comandos arbitrários.');
  }

  async function execute(text: string): Promise<void> {
    if (busy) return;
    const command = text.trim();
    if (!command) return;
    if (command.length > (command.startsWith('linux ') ? 605 : 180)) { line('Comando muito longo.', 'error'); return; }
    busy = true;
    runButton.disabled = true;
    input.disabled = true;
    history.push(command);
    if (history.length > 50) history.shift();
    historyIndex = history.length;
    line('vps > ' + command, 'command');
    try {
      const answer = await runCommand(command);
      line(answer, 'response');
    } catch (error) {
      line('ERRO: ' + (error instanceof Error ? error.message : 'Falha ao executar a operação.'), 'error');
    } finally {
      busy = false; runButton.disabled = false; input.disabled = false;
      input.value = ''; input.focus();
    }
  }

  form.addEventListener('submit', event => { event.preventDefault(); void execute(input.value); });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowUp' && history.length) {
      event.preventDefault(); historyIndex = Math.max(0, historyIndex - 1);
      input.value = history[historyIndex] || ''; input.setSelectionRange(input.value.length, input.value.length);
    } else if (event.key === 'ArrowDown' && history.length) {
      event.preventDefault(); historyIndex = Math.min(history.length, historyIndex + 1);
      input.value = history[historyIndex] || '';
    }
  });
  document.getElementById('terminalHelpButton')?.addEventListener('click', () => void execute('ajuda'));
  document.getElementById('terminalClearButton')?.addEventListener('click', () => { output.replaceChildren(); input.focus(); });
  window.addEventListener('beforeunload', () => { sshToken = null; });
  document.querySelectorAll<HTMLButtonElement>('[data-terminal-command]').forEach(button =>
    button.addEventListener('click', () => void execute(button.dataset.terminalCommand || 'ajuda')));

  async function refreshTerminalConnection(): Promise<void> {
    try {
      const session = await api('/session');
      setConnection(Boolean(session.authenticated), session.authenticated ? 'Sessão ativa · API conectada' : 'Faça login no painel');
    } catch { setConnection(false, 'API indisponível'); }
  }
  Object.assign(window, { refreshTerminalConnection });
  if (location.hash === '#terminal') void refreshTerminalConnection();
})();
