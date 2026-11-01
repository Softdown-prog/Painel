(() => {
  type Service = { id: string; state: string; status: string };
  type Project = { id: string; name: string; kind: 'managed' | 'legacy'; repository: string | null;
    state: 'running' | 'partial' | 'stopped' | 'empty'; services: Service[] };
  async function refreshHostedProjects(): Promise<void> {
    const host = document.getElementById('hostedProjects');
    if (!host) return;
    try {
      const data = await window.panelApi.request<{ projects: Project[] }>("/hosted-projects");
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
          project.services.length === 1 && project.services[0] ? '#site?slug=' + encodeURIComponent(project.services[0].id) : '#projects';
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
