import { existsSync, readFileSync } from 'node:fs';
import type { DomainRoute } from './domains.ts';

export type PublishState = 'reserved' | 'dns_ready' | 'certificate_pending' | 'published' | 'failed';
export type PublishDetails = { state: PublishState; updatedAt: string; message?: string; dnsRecordId?: string };

type CloudflareRecord = { id: string; type: string; name: string; content: string; proxied?: boolean; comment?: string };
type PublishConfig = { token: string; zoneId: string; origin: string };
export type SshResult = { exitCode: number; output: string; truncated: boolean; timedOut: boolean };

const ipv4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const zoneId = /^[a-f0-9]{32}$/i;
const safeSecretFile = (file: string) => file.startsWith('/run/secrets/') || file.startsWith('/run/panel-managed-secrets/');

export function publishConfig(env: NodeJS.ProcessEnv = process.env): PublishConfig | null {
  const file = env.PANEL_CLOUDFLARE_DNS_TOKEN_FILE || '';
  const id = env.PANEL_CLOUDFLARE_ZONE_ID || '';
  const origin = env.PANEL_DOMAIN_ORIGIN_IPV4 || '';
  if (!safeSecretFile(file) || !existsSync(file) || !zoneId.test(id) || !ipv4.test(origin)) return null;
  const token = readFileSync(file, 'utf8').trim();
  return token.length >= 20 ? { token, zoneId: id, origin } : null;
}

export function renderPublicCaddy(routes: readonly DomainRoute[]): string {
  const lines = ['# Gerado pelo Softload Painel. Não editar manualmente.', '# Encaminha apenas endereços de apps administrados para o gateway isolado.'];
  for (const route of [...routes].sort((a, b) => a.host.localeCompare(b.host))) {
    lines.push('http://' + route.host + ' {');
    lines.push('    redir https://' + route.host + '{uri} 308');
    lines.push('}');
    lines.push('https://' + route.host + ' {');
    lines.push('    reverse_proxy app-gateway:8081 {');
    lines.push('        header_up Host {host}');
    lines.push('        header_up X-Forwarded-Host {host}');
    lines.push('        header_up X-Forwarded-Proto {scheme}');
    lines.push('    }');
    lines.push('}');
  }
  return lines.join('\n') + '\n';
}

export function renderCaddyInstallCommand(content: string): string {
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  // All values in `content` originate from strict domain/slug validation. The
  // base64 transport avoids shell interpolation and protects the Caddyfile.
  return [
    'set -eu',
    'test -S /var/run/docker.sock',
    'docker network inspect softload_panel_apps >/dev/null',
    'docker inspect -f "{{.State.Running}}" softload-caddy | grep -qx true',
    'docker inspect -f "{{.State.Running}}" softload-panel-app-gateway-1 2>/dev/null | grep -qx true || docker inspect -f "{{.State.Running}}" softload-panel-app-gateway | grep -qx true',
    'docker network connect softload_panel_apps softload-caddy 2>/dev/null || true',
    'd=/opt/softload-infra/caddy/sites; f="$d/panel-managed-apps.caddy"; b="$f.panel-backup"; t="$f.tmp"',
    'install -d -m 700 "$d"',
    'test ! -e "$f" || cp -p "$f" "$b"',
    'printf %s "' + encoded + '" | base64 -d > "$t"',
    'chmod 600 "$t"; mv "$t" "$f"',
    'if ! docker exec softload-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then test ! -e "$b" || mv "$b" "$f"; exit 1; fi',
    'if ! docker exec softload-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then test ! -e "$b" || mv "$b" "$f"; docker exec softload-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || true; exit 1; fi',
    'rm -f "$b"'
  ].join('\n');
}

async function cfRequest(config: PublishConfig, path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
    ...init,
    headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(12_000)
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok || !value.success) throw new Error('Cloudflare não aceitou a alteração DNS.');
  return value.result;
}

function ownership(route: DomainRoute) { return 'softload-panel-domain:' + route.slug; }

export async function ensureDnsRecord(config: PublishConfig, route: DomainRoute): Promise<string> {
  const records = await cfRequest(config, '/zones/' + config.zoneId + '/dns_records?name=' + encodeURIComponent(route.host) + '&per_page=10') as CloudflareRecord[];
  const existing = records[0];
  const record = { type: 'A', name: route.host, content: config.origin, ttl: 1, proxied: true, comment: ownership(route) };
  if (!existing) {
    const created = await cfRequest(config, '/zones/' + config.zoneId + '/dns_records', { method: 'POST', body: JSON.stringify(record) }) as CloudflareRecord;
    return created.id;
  }
  if (existing.comment !== ownership(route)) throw new Error('Já existe um DNS nesse endereço que não pertence a esta aplicação.');
  const updated = await cfRequest(config, '/zones/' + config.zoneId + '/dns_records/' + existing.id, { method: 'PUT', body: JSON.stringify(record) }) as CloudflareRecord;
  return updated.id;
}

export async function removeDnsRecord(config: PublishConfig, route: DomainRoute): Promise<void> {
  const records = await cfRequest(config, '/zones/' + config.zoneId + '/dns_records?name=' + encodeURIComponent(route.host) + '&per_page=10') as CloudflareRecord[];
  const existing = records.find(record => record.comment === ownership(route));
  if (existing) await cfRequest(config, '/zones/' + config.zoneId + '/dns_records/' + existing.id, { method: 'DELETE' });
}

export async function checkPublicHttps(host: string): Promise<boolean> {
  try {
    const response = await fetch('https://' + host + '/', { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    return response.status > 0 && response.status < 500;
  } catch { return false; }
}

export async function installPublicGateway(routes: readonly DomainRoute[], execute: (command: string) => Promise<SshResult>): Promise<void> {
  const result = await execute(renderCaddyInstallCommand(renderPublicCaddy(routes)));
  if (result.exitCode !== 0 || result.timedOut || result.truncated) throw new Error('O gateway da VPS não confirmou a atualização.');
}
