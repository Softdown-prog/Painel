#!/usr/bin/env bash
# Read-only verification of the existing shared PostgreSQL and Panel deployment.
# Safe to run from the authenticated VPS terminal: does not print credentials,
# modify Docker objects, install packages or change the host.
set -euo pipefail

has_docker() {
  command -v docker >/dev/null 2>&1 || { echo 'ERRO: Docker não encontrado.' >&2; exit 2; }
  docker info >/dev/null 2>&1 || { echo 'ERRO: Não foi possível consultar o daemon Docker.' >&2; exit 2; }
}
has_docker

if ! docker container inspect vps-postgres >/dev/null 2>&1; then
  echo 'ERRO: container vps-postgres não encontrado.' >&2
  exit 2
fi

if [[ "$(docker inspect -f '{{.State.Running}}' vps-postgres)" != true ]]; then
  echo 'ERRO: vps-postgres existe, mas não está em execução.' >&2
  exit 2
fi

if ! docker network inspect vps_pg_private >/dev/null 2>&1; then
  echo 'ERRO: rede Docker vps_pg_private ausente.' >&2
  exit 2
fi

db_networks="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' vps-postgres)"
if ! grep -Fxq vps_pg_private <<< "$db_networks"; then
  echo 'ERRO: vps-postgres não está conectado à rede vps_pg_private.' >&2
  exit 2
fi

if [[ "$(docker network inspect -f '{{.Internal}}' vps_pg_private)" != true ]]; then
  echo 'ATENÇÃO: a rede vps_pg_private não está marcada como interna.' >&2
fi

if [[ -n "$(docker port vps-postgres 5432/tcp 2>/dev/null || true)" ]]; then
  echo 'ATENÇÃO: o PostgreSQL possui porta 5432 publicada no host.' >&2
else
  echo 'OK: porta PostgreSQL 5432 não está publicada no host.'
fi

docker exec vps-postgres pg_isready -U postgres
echo 'OK: PostgreSQL respondeu à verificação de prontidão.'

if docker container inspect softload-panel-api >/dev/null 2>&1; then
  echo "Painel API: $(docker inspect -f '{{.State.Status}}' softload-panel-api)"
  echo "Imagem API: $(docker inspect -f '{{.Config.Image}}' softload-panel-api)"
  echo 'Redes atuais da API:'
  docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' softload-panel-api
else
  echo 'ATENÇÃO: container de API do Painel não encontrado pelo nome esperado.'
fi

if docker network inspect vps_panel_control >/dev/null 2>&1; then
  echo 'OK: rede administrativa vps_panel_control existe.'
else
  echo 'ERRO: rede administrativa do Painel não encontrada.' >&2
  exit 2
fi

if [[ -L /opt/vps-panel/current ]]; then
  echo "Revisão instalada: $(readlink -f /opt/vps-panel/current)"
elif [[ -d /opt/vps-panel/current ]]; then
  echo 'OK: diretório /opt/vps-panel/current existe (não é link).'
else
  echo 'ATENÇÃO: diretório /opt/vps-panel/current não encontrado.'
fi

if [[ -r /etc/softload-panel/compose-production-files.json ]]; then
  echo 'OK: registro dos overlays Compose existe e é legível (conteúdo oculto).'
else
  echo 'ATENÇÃO: registro privado dos overlays Compose não está legível.'
fi

echo 'Conferência concluída: nenhuma alteração feita na VPS.'
