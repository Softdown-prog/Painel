import type { HostInventory } from './overview-state';

export type InventoryStatusFilter = 'all' | 'running' | 'other';
export type ContainerEntry = HostInventory['containers'][number];
export type InventoryFilters = Readonly<{ query: string; status: InventoryStatusFilter; project: string }>;

/** Only projects actually returned by the authorized read-only inventory are selectable. */
export function inventoryProjects(inventory: HostInventory | null): string[] {
  const names = new Set<string>();
  for (const item of inventory?.containers ?? []) {
    if (item.project) names.add(item.project);
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

const simplify = (value: string): string =>
  value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');

/** Filters locally. No new API permissions, container IDs, or lifecycle commands. */
export function filterInventory(
  inventory: HostInventory | null, filters: InventoryFilters
): ContainerEntry[] {
  if (!inventory) return [];
  const query = simplify(filters.query.trim().slice(0, 100));
  return inventory.containers.filter(item => {
    if (filters.project && item.project !== filters.project) return false;
    if (filters.status === 'running' && item.state !== 'running') return false;
    if (filters.status === 'other' && item.state === 'running') return false;
    if (!query) return true;
    return [item.name, item.image, item.project ?? ''].some(value => simplify(value).includes(query));
  });
}
