#!/usr/bin/env bash
# Stage a pinned frontend revision inside the existing control network.
# Never touches live Caddy, Cloudflare, the panel API, executor, PostgreSQL or other projects.
set -Eeuo pipefail
umask 077

fail() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }
if [[ $# -ne 1 || ! "$1" =~ ^[a-f0-9]{40}$ ]]; then
  echo "Uso: PANEL_PUBLIC_ORIGIN=https://staging.exemplo.com bash web/deploy-staging-vps.sh <SHA40>" >&2
  exit 2
fi
[[ -n "${PANEL_PUBLIC_ORIGIN:-}" ]] || fail "PANEL_PUBLIC_ORIGIN não configurada"
[[ "$PANEL_PUBLIC_ORIGIN" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] ||
  fail "PANEL_PUBLIC_ORIGIN deve ser HTTPS, sem caminho ou parâmetros"
(( EUID == 0 )) || fail "É necessário executar por acesso administrativo autorizado (root)"
for cmd in docker curl tar mktemp install flock; do
  command -v "$cmd" >/dev/null || fail "Ferramenta ausente: $cmd"
done
docker network inspect vps_panel_control >/dev/null 2>&1 || fail "Rede vps_panel_control ausente"
[[ -f /etc/softload-panel/edge-key && -r /etc/softload-panel/edge-key ]] ||
  fail "Chave privada da API não está disponível; instalação abortada"
install -d -m 0700 /run/lock/softload-panel
exec 9>/run/lock/softload-panel/panel-web-deploy.lock
flock -n 9 || fail "Outra implantação do frontend já está em andamento"
[[ "$(docker inspect -f '{{.State.Running}}' softload-panel-api 2>/dev/null)" == true ]] ||
  fail "API principal não está em execução"

sha="$1"
root=/opt/vps-panel/web-releases
release="$root/$sha"
image_name="vps-panel-web:$sha"
candidate="panel-web-candidate-$(printf '%s' "$sha" | cut -c1-12)-$BASHPID"
old_revision=''
old_origin=''
old_container=0
promoted=0
completed=0
temp_dir=''

cleanup() {
  docker rm -f "$candidate" >/dev/null 2>&1 || true
  if [[ -n "$temp_dir" && -d "$temp_dir" ]]; then rm -rf -- "$temp_dir"; fi
}
rollback() {
  if (( completed == 1 || promoted == 0 )); then return; fi
  echo "A validação falhou após a troca; revertendo SOMENTE panel-web." >&2
  if (( old_container == 1 )); then
    if [[ -n "$old_revision" && -d "$root/$old_revision/server" ]]; then
      (
        cd "$root/$old_revision/server"
        PANEL_WEB_REVISION="$old_revision" PANEL_PUBLIC_ORIGIN="$old_origin" \
          docker compose -f compose.yaml -f compose.web.yaml up -d --no-deps --no-build panel-web
      ) || echo "FALHA DE REVERSÃO: revisar softload-panel-web com acesso independente." >&2
    fi
  else
    (
      cd "$release/server"
      docker compose -f compose.yaml -f compose.web.yaml stop panel-web >/dev/null 2>&1 || true
      docker compose -f compose.yaml -f compose.web.yaml rm -f panel-web >/dev/null 2>&1 || true
    )
  fi
}
trap 'result=$?; rollback; cleanup; exit "$result"' EXIT

# Never clobber a non-owned container. Prior staging revisions are read from the
# existing service environment, not from mutable tags like latest.
if docker container inspect softload-panel-web >/dev/null 2>&1; then
  old_container=1
  owner="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}/{{index .Config.Labels "com.docker.compose.service"}}' softload-panel-web)"
  [[ "$owner" == "softload-panel/panel-web" ]] ||
    fail "Container com nome softload-panel-web não pertence ao serviço esperado"
  old_revision="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' softload-panel-web | sed -n 's/^PANEL_WEB_REVISION=//p' | head -n1)"
  old_origin="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' softload-panel-web | sed -n 's/^PANEL_PUBLIC_ORIGIN=//p' | head -n1)"
  [[ "$old_revision" =~ ^[a-f0-9]{40}$ && -d "$root/$old_revision/server" ]] ||
    fail "A versão anterior não tem registro local para reversão; nenhuma troca realizada"
  [[ "$old_origin" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] ||
    fail "A origem anterior é inválida; nenhuma troca realizada"
  docker image inspect "vps-panel-web:$old_revision" >/dev/null 2>&1 ||
    fail "Imagem anterior ausente; nenhuma troca realizada"
fi

install -d -m 0700 "$root"
if [[ ! -d "$release" ]]; then
  temp_dir="$(mktemp -d "$root/.stage-XXXXXXXX")"
  echo "Obtendo revisão imutável $sha do GitHub"
  curl -fLsS --retry 2 --connect-timeout 10 --max-time 120 \
    -o "$temp_dir/source.tar.gz" "https://codeload.github.com/Softdown-prog/Painel/tar.gz/$sha"
  install -d -m 0700 "$temp_dir/source"
  tar -xzf "$temp_dir/source.tar.gz" --strip-components=1 -C "$temp_dir/source"
  [[ -f "$temp_dir/source/web/Dockerfile" && -f "$temp_dir/source/server/compose.web.yaml" ]] ||
    fail "Revisão sem os arquivos necessários"
  mv "$temp_dir/source" "$release"
fi

cd "$release/server"
export PANEL_WEB_REVISION="$sha"
docker compose -f compose.yaml -f compose.web.yaml config --quiet
echo "Compilando SOMENTE a imagem do frontend de staging"
docker compose -f compose.yaml -f compose.web.yaml build panel-web
docker image inspect "$image_name" >/dev/null || fail "Imagem não foi criada"

# Probe new image before promoting; previous container and reverse proxy stay intact.
echo "Testando nova revisão isoladamente antes de substituir o staging anterior"
docker run -d --name "$candidate" \
  --network vps_panel_control --read-only \
  --cap-drop ALL --cap-add SETUID --cap-add SETGID \
  --security-opt no-new-privileges --memory 128m --cpus 0.5 --pids-limit 64 \
  --mount type=bind,src=/etc/softload-panel/edge-key,dst=/run/secrets/panel-edge-key,readonly \
  -e PANEL_WEB_REVISION="$sha" -e PANEL_PUBLIC_ORIGIN="$PANEL_PUBLIC_ORIGIN" \
  "$image_name" >/dev/null

probe='
(async () => {
  const base = "http://127.0.0.1:8081";
  const [page, health, api] = await Promise.all([
    fetch(base + "/"), fetch(base + "/__panel_web_health"), fetch(base + "/api/session")
  ]);
  if (page.status !== 200 || health.status !== 200 || api.status !== 200)
    throw Error("HTTP inesperado: " + page.status + "/" + health.status + "/" + api.status);
  const html = await page.text(), meta = await health.json(), session = await api.json();
  if (!html.includes("terminal-ui.js?v=") || meta.revision !== process.env.PANEL_WEB_REVISION ||
      typeof session.authenticated !== "boolean" || typeof session.setupRequired !== "boolean")
    throw Error("Conteúdo ou contrato da API inválido");
})().catch(e=>{ console.error(e.message); process.exit(1); });
'
passed=0
for _ in $(seq 1 20); do
  if docker exec "$candidate" node -e "$probe" >/dev/null 2>&1; then passed=1; break; fi
  sleep 2
done
(( passed == 1 )) || fail "Nova revisão não passou nos testes internos; estágio anterior foi mantido"

echo "Nova revisão testada. Atualizando somente o serviço panel-web."
# This command never re-creates api, executor, Caddy, Tunnel or customer workloads.
promoted=1
docker compose -f compose.yaml -f compose.web.yaml up -d --no-deps --no-build panel-web
passed=0
for _ in $(seq 1 20); do
  if [[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' softload-panel-web 2>/dev/null)" == healthy ]] &&
      docker exec softload-panel-web node -e "$probe" >/dev/null 2>&1; then
    passed=1
    break
  fi
  sleep 2
done
(( passed == 1 )) || fail "Container promovido não passou no teste de ponta a ponta"
completed=1
echo "PASS: panel-web em staging, revisão $sha; API /session válida."
echo "Nenhum domínio, Caddy, Cloudflare Pages, Tunnel, executor ou projeto hospedado foi modificado."
