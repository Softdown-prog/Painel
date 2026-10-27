(() => {
  type Service = { id: string; state: string; status: string };
  type Project = { id: string; name: string; kind: 'managed' | 'legacy'; repository: string | null;
    state: 'running' | 'partial' | 'stopped' | 'empty'; services: Service[] };
  async function refreshHostedProjects(): Promise<void> {
    const host = document.getElementById('hostedProjects');
    if (!host) return;
    try {
      const response = await fetch('/api/hosted-projects', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('Não foi possível consultar os projetos.');
      const data = await response.json() as { projects: Project[] };
      host.replaceChildren();
      if (!data.projects.length) { host.textContent = 'Nenhum projeto cadastrado nesta VPS.'; return; }
      for (const project of data.projects) {
        const card = document.createElement('article'); card.className = 'hosted-project-card';
        const name = document.createElement('strong'); name.textContent = project.name;
        const state = document.createElement('small');
        state.textContent = ({ running: 'Em execução', partial: 'Parte em execução',
          stopped: 'Parado', empty: 'Sem serviços' } as const)[project.state] || 'Estado indisponível';
        const detail = document.createElement('p');
        detail.textContent = project.services.length + (project.services.length === 1 ? ' serviço' : ' serviços') +
          (project.repository ? ' · ' + project.repository : ' · Sem repositório conectado');
        const link = document.createElement('a'); link.className = 'text-link';
        link.href = project.kind === 'legacy' ? '#services' :
          project.services.length === 1 ? '#site?slug=' + encodeURIComponent(project.services[0].id) : '#projects';
        link.textContent = 'Gerenciar →';
        card.append(name, state, detail, link);
        host.append(card);
      }
    } catch (error) {
      host.textContent = error instanceof Error ? error.message : 'Dados indisponíveis.';
    }
  }
  Object.assign(window, { refreshHostedProjects });
})();
