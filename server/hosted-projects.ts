import type { ProjectBinding } from './projects.ts';

type Container = { Names?: string[]; Labels?: Record<string, string>; Image?: string; State?: string; Status?: string };
type LegacyService = { id: string; name: string; state: string; status: string; image: string | null };
type ServiceView = { id: string; name: string; state: string; status: string; image: string | null };
type HostedProject = {
  id: string; name: string; kind: 'managed' | 'legacy'; repository: string | null;
  services: ServiceView[]; state: 'running' | 'partial' | 'stopped' | 'empty';
};

function stateOf(services: ServiceView[]): HostedProject['state'] {
  if (!services.length) return 'empty';
  const running = services.filter(service => service.state === 'running').length;
  return running === services.length ? 'running' : running ? 'partial' : 'stopped';
}

export function hostedProjects(bindings: ProjectBinding[], apps: Container[], legacy: LegacyService[]): HostedProject[] {
  const bySlug = new Map(apps.map(app => [app.Labels?.['com.softload.panel.slug'], app]));
  const assigned = new Set(bindings.flatMap(project => project.services));
  const managed: HostedProject[] = bindings.map(project => {
    const services = project.services.map(id => {
      const app = bySlug.get(id);
      return {
        id, name: 'softload-app-' + id, state: app?.State || 'missing',
        status: app?.Status || 'Não encontrado', image: app?.Image || null
      };
    });
    return { id: project.slug, name: project.slug, kind: 'managed' as const,
      repository: project.repository, services, state: stateOf(services) };
  });
  for (const app of apps) {
    const id = app.Labels?.['com.softload.panel.slug'];
    if (!id || assigned.has(id)) continue;
    const services = [{ id, name: app.Names?.[0]?.replace(/^\//, '') || 'softload-app-' + id,
      state: app.State || 'unknown', status: app.Status || '', image: app.Image || null }];
    managed.push({ id, name: id, kind: 'managed', repository: null,
      services, state: stateOf(services) });
  }
  const core = legacy.filter(service => ['app', 'agent'].includes(service.id) && service.state !== 'missing')
    .map(({ id, name, state, status, image }) => ({ id, name, state, status, image }));
  const legacyProject: HostedProject[] = core.length ? [{
    id: 'legacy:softload-v4', name: 'Softload V4', kind: 'legacy', repository: 'Softdown-prog/Softloadv4',
    services: core, state: stateOf(core)
  }] : [];
  return [...legacyProject, ...managed];
}
