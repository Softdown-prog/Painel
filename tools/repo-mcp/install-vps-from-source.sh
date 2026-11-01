#!/usr/bin/env bash
# Instalação inicial explícita do Code MCP via Shell administrativa da VPS.
# Sem alteração do broker, outros containers, Docker networks ou publicação externa.
set -Eeuo pipefail
umask 077
[[ ${EUID} -eq 0 && $# -eq 2 ]] || {
  echo 'Uso: bash install-vps-from-source.sh <checkout-confirmado> <commit-SHA40>' >&2
  exit 2
}
source_dir="$(realpath "$1")"
revision="$2"
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || { echo 'SHA inválido' >&2; exit 2; }
for f in tools/repo-mcp/Dockerfile tools/repo-mcp/indexer.mjs tools/repo-mcp/http-server.mjs; do
  [[ -f "$source_dir/$f" ]] || { echo "Arquivo ausente: $f" >&2; exit 2; }
done
command -v docker >/dev/null
command -v python3 >/dev/null
command -v curl >/dev/null
if docker container inspect vps-code-mcp >/dev/null 2>&1; then
  echo 'O container vps-code-mcp já existe. Nenhuma alteração foi feita.' >&2
  exit 3
fi
if [[ ! -d /etc/vps-operations ]]; then
  echo 'Broker vpsops ainda não foi instalado. Abortando.' >&2
  exit 2
fi
# Autorização precisa estar efetivamente habilitada no host; não basta o código do GitHub.
python3 - <<'PY'
import json
from pathlib import Path
p=json.loads(Path('/etc/vps-operations/policy.json').read_text())
if not p.get('code_mcp',{}).get('enabled',False):
    raise SystemExit('Code MCP não autorizado pela política instalada')
if 'code_mcp' not in p.get('repositories',{}).get('1433232532',{}).get('operations',[]):
    raise SystemExit('Operação code_mcp não consta da política instalada')
PY
context="$(mktemp -d)"
cleanup() { rm -rf -- "$context"; }
trap cleanup EXIT
mkdir -p "$context/repos/Painel" "$context/tools/repo-mcp"
# Tarball de uma revisão fixa; somente o diretório extraído é copiado.
cp -a "$source_dir/." "$context/repos/Painel/"
cp "$source_dir/tools/repo-mcp/indexer.mjs" "$source_dir/tools/repo-mcp/http-server.mjs" "$context/tools/repo-mcp/"
printf '%s\n' '{"repos":[{"name":"Painel","path":"/srv/repos/Painel"}]}' > "$context/registry.json"
image="vps-code-mcp:$revision"
docker build -q --build-arg "SOURCE_REVISION=$revision" \
  -f "$source_dir/tools/repo-mcp/Dockerfile" -t "$image" "$context" >/dev/null
installed_rev="$(docker image inspect "$image" -f '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
installed_src="$(docker image inspect "$image" -f '{{index .Config.Labels "org.opencontainers.image.source"}}')"
[[ "$installed_rev" == "$revision" && "$installed_src" == 'https://github.com/Softdown-prog/Painel' ]] || {
  echo 'Imagem não passou pela verificação de revisão/origem' >&2
  exit 2
}
secret=/etc/vps-operations/code-mcp-token
token_created=0
if [[ -e "$secret" ]]; then
  [[ -f "$secret" && ! -L "$secret" ]] || { echo 'Arquivo de token inválido' >&2; exit 2; }
  python3 - "$secret" <<'PY'
import sys
from pathlib import Path
assert len(Path(sys.argv[1]).read_bytes().strip()) >= 32, 'Token MCP existente inválido'
PY
else
  python3 - "$secret" <<'PY'
import os,sys,secrets
path=sys.argv[1]
fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o440)
with os.fdopen(fd,'w') as f:f.write(secrets.token_urlsafe(48)+'\n')
PY
  token_created=1
fi
chown root:65534 "$secret"
chmod 0440 "$secret"
created=0
rollback() {
  rc=$?
  if (( rc != 0 )); then
    if (( created )); then docker rm -f vps-code-mcp >/dev/null 2>&1 || true; fi
    if (( token_created )); then rm -f "$secret"; fi
    echo 'Instalação do MCP interrompida; outros serviços preservados.' >&2
  fi
  cleanup
}
trap rollback EXIT
docker create --name vps-code-mcp --restart unless-stopped \
  --label com.softdown.code-mcp.managed=true \
  --label "org.opencontainers.image.revision=$revision" \
  --network bridge --publish '127.0.0.1:8789:8789' \
  --read-only --user '65534:65534' --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 64 --memory 192m --cpus 0.5 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,uid=65534,gid=65534 \
  --mount "type=bind,src=$secret,dst=/run/secrets/code-mcp-token,readonly" \
  -e REPO_MCP_REGISTRY_FILE=/srv/registry.json \
  -e REPO_MCP_TOKEN_FILE=/run/secrets/code-mcp-token \
  -e PORT=8789 \
  "$image" >/dev/null
created=1
docker start vps-code-mcp >/dev/null
healthy=0
for i in $(seq 1 40); do
  status="$(docker inspect vps-code-mcp -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}')"
  if [[ "$status" == 'healthy' ]]; then healthy=1; break; fi
  [[ "$status" == 'unhealthy' ]] && break
  sleep 2
done
if (( ! healthy )); then
  echo 'Container MCP não atingiu estado healthy.' >&2
  docker logs --tail 15 vps-code-mcp >&2 || true
  exit 1
fi
curl -fsS --max-time 10 http://127.0.0.1:8789/health
[[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8789/mcp)" == 401 ]] || {
  echo 'Servidor não exigiu autenticação.' >&2; exit 1;
}
echo
echo 'MCP instalado: vps-code-mcp'
echo "Revisão: $revision"
echo 'Endereço: 127.0.0.1:8789 (somente VPS; sem acesso público)'
echo 'Autenticação: exigida, token não mostrado'
