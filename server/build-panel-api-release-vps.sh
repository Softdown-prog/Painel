#!/usr/bin/env bash
# Download immutable Panel GitHub source and build a SHA-identified API image.
# Run under detached systemd-run; never stops/restarts containers or removes volumes.
set -Eeuo pipefail
umask 077
SHA="${1:-}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'Informe um SHA completo de 40 caracteres'; exit 2; }
TARGET="/opt/vps-panel/releases/$SHA"
IMAGE="vps-panel-api:$SHA"
command -v docker >/dev/null
command -v curl >/dev/null
command -v tar >/dev/null
mkdir -p /opt/vps-panel/releases
if [[ ! -f "$TARGET/server/Dockerfile" ]]; then
  [[ ! -e "$TARGET" ]] || { echo 'A revisão está parcialmente instalada: revisar manualmente'; exit 2; }
  temp=$(mktemp -d /opt/vps-panel/releases/.incoming-XXXXXXXX)
  archive=$(mktemp /tmp/panel-src-XXXXXXXX.tar.gz)
  cleanup() { rm -f "$archive"; if [[ -n "${temp:-}" && -d "$temp" ]]; then rm -rf "$temp"; fi; }
  trap cleanup EXIT
  curl --fail --location --silent --show-error --retry 2 --connect-timeout 8 --max-time 100 \
    "https://codeload.github.com/Softdown-prog/Painel/tar.gz/$SHA" -o "$archive"
  tar -xzf "$archive" -C "$temp" --strip-components=1
  [[ -f "$temp/server/Dockerfile" && -f "$temp/server/database.ts" ]] ||
    { echo 'Código recebido incompleto'; exit 2; }
  mv "$temp" "$TARGET"
  temp=''
fi
docker build --label "org.opencontainers.image.revision=$SHA" \
  --label "org.opencontainers.image.source=https://github.com/Softdown-prog/Painel" \
  -t "$IMAGE" "$TARGET/server"
reported=$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
[[ "$reported" == "$SHA" ]] || { echo 'Revisão da imagem não confere'; exit 2; }
echo "IMAGEM PRONTA: $IMAGE (nenhum container alterado)."
