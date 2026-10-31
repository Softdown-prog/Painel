#!/usr/bin/env bash
# Read-only readiness check for shared passwordless PostgreSQL.
set -euo pipefail
docker container inspect vps-postgres >/dev/null
docker network inspect vps_pg_private >/dev/null
docker volume inspect softload_panel_data >/dev/null
root=$(docker volume inspect softload_panel_data --format '{{.Mountpoint}}')
echo 'POSTGRESQL MULTIPROJETOS — DIAGNÓSTICO SEM ALTERAÇÕES'
docker exec -u postgres vps-postgres psql -X -d postgres -Atqc \
  "SELECT 'ssl='||current_setting('ssl')"
docker exec -u postgres vps-postgres psql -X -d postgres -Atqc \
  "SELECT 'bancos='||count(*) FROM pg_database WHERE NOT datistemplate"
docker exec -u postgres vps-postgres psql -X -d postgres -Atqc \
  "SELECT 'regras_host_trust='||count(*) FROM pg_hba_file_rules WHERE type LIKE 'host%' AND auth_method='trust'"
docker exec -u postgres vps-postgres psql -X -d postgres -Atqc \
  "SELECT 'regras_host_cert='||count(*) FROM pg_hba_file_rules WHERE type='hostssl' AND auth_method='cert'"
if [[ -f "$root/postgres-tls/ca.key" && -f "$root/postgres-tls/admin.crt" && -f /etc/vps-postgres-tls/server.crt ]]; then
  echo 'certificados_preparados=sim'
else
  echo 'certificados_preparados=nao'
fi
echo 'Operação somente leitura; o serviço continua como estava.'
