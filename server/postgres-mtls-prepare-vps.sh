#!/usr/bin/env bash
# Stage TLS certificates for one shared PostgreSQL and multiple project roles.
# Does NOT edit PostgreSQL, restart containers, enable writes or expose keys.
set -euo pipefail
umask 077
[[ "$(id -u)" = 0 ]] || { echo "ERRO: execute como administrador da VPS."; exit 2; }
for tool in docker openssl mktemp install; do command -v "$tool" >/dev/null || exit 2; done
docker container inspect vps-postgres >/dev/null
docker volume inspect softload_panel_data >/dev/null
docker network inspect vps_pg_private >/dev/null
panel_root=$(docker volume inspect softload_panel_data --format '{{.Mountpoint}}')
[[ -d "$panel_root" && ! -L "$panel_root" ]] || exit 2
panel_tls="$panel_root/postgres-tls"
server_tls=/etc/vps-postgres-tls
[[ ! -e "$panel_tls" && ! -e "$server_tls" ]] || {
  echo "ERRO: certificados já preparados. Recusei sobrescrever chaves existentes."; exit 3;
}
tmp=$(mktemp -d "$panel_root/.pg-cert-prep-XXXXXXXX")
trap 'rm -rf -- "$tmp"' EXIT
mkdir -m 700 "$tmp/panel" "$tmp/server"
ca="$tmp/ca"
mkdir -m 700 "$ca"
openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 1825 \
  -keyout "$ca/ca.key" -out "$ca/ca.crt" \
  -subj '/CN=Private VPS PostgreSQL CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
cat > "$tmp/server.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:vps-postgres
EOF
cat > "$tmp/client.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth
EOF
openssl req -new -newkey rsa:3072 -nodes \
  -keyout "$tmp/server/server.key" -out "$tmp/server.csr" \
  -subj '/CN=vps-postgres' >/dev/null 2>&1
openssl x509 -req -in "$tmp/server.csr" -CA "$ca/ca.crt" -CAkey "$ca/ca.key" \
  -set_serial "0x$(openssl rand -hex 16)" -sha256 -days 825 \
  -extfile "$tmp/server.ext" -out "$tmp/server/server.crt" >/dev/null 2>&1
openssl req -new -newkey rsa:3072 -nodes \
  -keyout "$tmp/panel/admin.key" -out "$tmp/admin.csr" \
  -subj '/CN=postgres' >/dev/null 2>&1
openssl x509 -req -in "$tmp/admin.csr" -CA "$ca/ca.crt" -CAkey "$ca/ca.key" \
  -set_serial "0x$(openssl rand -hex 16)" -sha256 -days 825 \
  -extfile "$tmp/client.ext" -out "$tmp/panel/admin.crt" >/dev/null 2>&1
openssl verify -CAfile "$ca/ca.crt" -purpose sslserver "$tmp/server/server.crt" >/dev/null
openssl verify -CAfile "$ca/ca.crt" -purpose sslclient "$tmp/panel/admin.crt" >/dev/null
install -m 600 "$ca/ca.key" "$tmp/panel/ca.key"
install -m 644 "$ca/ca.crt" "$tmp/panel/ca.crt"
install -m 644 "$ca/ca.crt" "$tmp/server/ca.crt"
chmod 0600 "$tmp/panel/admin.key" "$tmp/server/server.key"
chmod 0644 "$tmp/panel/admin.crt" "$tmp/server/server.crt"
# Never put server private keys or client CA private keys in GitHub.
# Publish Panel files inside its existing Docker volume.
mv "$tmp/panel" "$panel_tls"
if ! mkdir -m 700 "$server_tls"; then
  rm -rf -- "$panel_tls"
  echo "ERRO: não foi possível preparar pasta privada do servidor"; exit 4
fi
if ! install -m 600 "$tmp/server/server.key" "$server_tls/server.key" ||
   ! install -m 644 "$tmp/server/server.crt" "$server_tls/server.crt" ||
   ! install -m 644 "$tmp/server/ca.crt" "$server_tls/ca.crt"; then
  rm -rf -- "$server_tls" "$panel_tls"
  echo "ERRO: preparação incompleta; estado original preservado"; exit 5
fi
echo "PREPARADO: certificados sem senhas para PostgreSQL compartilhado."
echo "Arquivos privados do Painel e do servidor gerados; nenhum container foi alterado."
echo "PENDENTE: migrar SSL/HBA com rollback, testar acesso sem certificado e atualizar API."
