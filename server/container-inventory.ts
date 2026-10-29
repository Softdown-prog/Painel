import { LEGACY_SOFTLOAD_SERVICES } from './legacy-softload-profile.ts';

/**
 * Only expose a minimal host-wide Docker inventory to an authenticated admin.
 * Never forward arbitrary Docker labels, ports, mounts, environment or IDs.
 * Viewing a container does not grant any operation over it.
 */
const LIMIT = 500;
const core = new Set(Object.values(LEGACY_SOFTLOAD_SERVICES).map(item => item.container));
type DockerSummary = {
  Names?: unknown;
  Image?: unknown;
  State?: unknown;
  Status?: unknown;
  Labels?: unknown;
};
export type HostContainer = {
  name: string;
  image: string;
  state: string;
  status: string;
  project: string | null;
  ownership: 'softload' | 'managed' | 'external';
};
const safe = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.slice(0, max) : '';
const label = (labels: unknown, key: string): string =>
  labels !== null && typeof labels === 'object' && !Array.isArray(labels)
    ? safe((labels as Record<string, unknown>)[key], 80)
    : '';

export function hostContainerInventory(raw: unknown): {
  containers: HostContainer[];
  truncated: boolean;
} {
  if (!Array.isArray(raw)) throw new Error('Lista Docker inválida.');
  const containers: HostContainer[] = [];
  for (const item of raw.slice(0, LIMIT) as DockerSummary[]) {
    if (!item || !Array.isArray(item.Names)) continue;
    const name = item.Names.find(value => typeof value === 'string' &&
      /^\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value));
    if (!name) continue;
    const cleanName = (name as string).slice(1);
    const project = label(item.Labels, 'com.docker.compose.project') || null;
    const managedSlug = label(item.Labels, 'com.softload.panel.slug');
    const owned = label(item.Labels, 'com.softload.panel.managed') === 'true' &&
      /^softload-(app|candidate|backup)-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cleanName) &&
      cleanName.endsWith('-' + managedSlug) && managedSlug.length >= 2 &&
      managedSlug.length <= 40;
    containers.push({
      name: cleanName,
      image: safe(item.Image, 180) || 'Imagem não informada',
      state: safe(item.State, 30) || 'unknown',
      status: safe(item.Status, 120) || 'Estado não informado',
      project,
      ownership: core.has(cleanName) ? 'softload' : owned ? 'managed' : 'external'
    });
  }
  containers.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return { containers, truncated: raw.length > LIMIT };
}
