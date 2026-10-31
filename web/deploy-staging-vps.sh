#!/usr/bin/env bash
# Operator-triggered staging; never changes the live domain, Pages, Caddy or other containers.
set -euo pipefail
umask 077
if [[ $# -ne 1 || ! "$1" =~ ^[a-f0-9]{40}$ ]]; then
  echo "Uso: PANEL_PUBLIC_ORIGIN=https://teste.exemplo bash web/deploy-staging-vps.sh <SHA40>"
  exit 2
fi
: "${PANEL_PUBLIC_ORIGIN:?Informe o endereco HTTPS futuro para validar Origin}"
if [[ ! "$PANEL_PUBLIC_ORIGIN" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]]; then
  echo "PANEL_PUBLIC_ORIGIN deve ser uma origem HTTPS sem caminho ou parametros."
  exit 2
fi
for cmd in docker curl tar; do command -v "$cmd" >/dev/null || { echo "Falta: $cmd"; exit 2; }; done
docker network inspect vps_panel_control >/dev/null 2>&1 || { echo "Rede administrativa ausente; nao recriar a rede."; exit 1; }
test -r /etc/softload-panel/edge-key || { echo "Chave de borda existente nao legivel."; exit 1; }
docker inspect softload-panel-api --format '{{.State.Running}}' 2>/dev/null | grep -qx true || { echo "API parada; recuperar backend primeiro."; exit 1; }

sha="$1"
root="/opt/vps-panel/web-releases"
release="$root/$sha"
install -d -m 0700 "$root"
if [[ ! -d "$release" ]]; then
  tmp="$(mktemp -d "$root/.stage-XXXXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  curl -fL --retry 2 --connect-timeout 10 --max-time 120 -o "$tmp/source.tar.gz" \
    "https://codeload.github.com/Softdown-prog/Painel/tar.gz/$sha"
  install -d -m 0700 "$tmp/source"
  tar -xzf "$tmp/source.tar.gz" --strip-components=1 -C "$tmp/source"
  test -f "$tmp/source/web/Dockerfile"
  test -f "$tmp/source/server/compose.web.yaml"
  mv "$tmp/source" "$release"
fi
cd "$release/server"
export PANEL_WEB_REVISION="$sha"
echo "Preparando apenas a interface do painel, commit $sha"
docker compose -f compose.yaml -f compose.web.yaml config --quiet
docker compose -f compose.yaml -f compose.web.yaml build panel-web
docker compose -f compose.yaml -f compose.web.yaml up -d --no-deps --no-build panel-web
ready=0
for _ in $(seq 1 20); do
  if [[ "$(docker inspect softload-panel-web --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null)" == healthy ]]; then
    ready=1
    break
  fi
  sleep 2
done
if [[ "$ready" -ne 1 ]]; then echo "Frontend nao ficou healthy. Revisar apenas softload-panel-web."; exit 1; fi
docker exec softload-panel-web node -e '
  (async()=>{
    const base="http://127.0.0.1:8081";
    const [html,api]=await Promise.all([fetch(base+"/"),fetch(base+"/api/session")]);
    if(html.status!==200 || api.status!==200)throw Error("Frontend/API not ready: "+html.status+"/"+api.status);
    const body=await api.json();
    if(typeof body.authenticated!=="boolean"||typeof body.setupRequired!=="boolean")
      throw Error("API session response is not the expected JSON contract");
    console.log("PASS: frontend interno 200 e API com sessao valida");
  })().catch(e=>{console.error(e.message);process.exit(1)})
'
echo "STAGING CONCLUIDO para $sha. Nao foi feita troca de DNS, Caddy, Tunnel ou Cloudflare Pages."
