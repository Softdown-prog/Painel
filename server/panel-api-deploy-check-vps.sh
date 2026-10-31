#!/usr/bin/env bash
# Read-only: compare running Panel API to GitHub main and check its dependencies.
set -euo pipefail
for cmd in docker python3 curl; do command -v "$cmd" >/dev/null || { echo "Falta: $cmd"; exit 2; }; done
echo '=== PAINEL DA VPS — DIAGNÓSTICO SEM ALTERAÇÕES ==='
docker inspect softload-panel-api --format 'API: {{.Config.Image}} | estado={{.State.Status}} | saúde={{if .State.Health}}{{.State.Health.Status}}{{else}}sem healthcheck{{end}}'
docker inspect softload-panel-tunnel --format 'Túnel: {{.State.Status}}'
docker inspect softload-panel-executor --format 'Executor: {{.State.Status}}'
docker inspect vps-postgres --format 'PostgreSQL: {{.State.Status}}'
echo 'Revisão de arquivos aplicada no host:'
readlink -f /opt/vps-panel/current
echo 'Redes ligadas à API:'
docker inspect softload-panel-api --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'
echo 'Revisão atual do GitHub:'
remote=$(curl -fsSL --connect-timeout 4 --max-time 12 \
  -H 'Accept: application/vnd.github+json' \
  https://api.github.com/repos/Softdown-prog/Painel/commits/main |
  python3 -c 'import json,sys;print(json.load(sys.stdin)["sha"])') || {
  echo 'Não foi possível consultar a main do GitHub; não afirmo que está atualizada.'
  exit 0
}
echo "$remote"
active=$(docker inspect softload-panel-api --format '{{.Config.Image}}')
if [[ "$active" == "vps-panel-api:$remote" ]]; then
  echo 'OK: versão da API bate com a main do GitHub.'
else
  echo 'PENDENTE: a API instalada na VPS NÃO está na última revisão do GitHub.'
  echo 'Cloudflare Pages e CI aprovados não atualizam esse container automaticamente.'
fi
echo 'Nenhum container reiniciado e nenhum dado alterado.'
