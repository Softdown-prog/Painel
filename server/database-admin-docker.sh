#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
network="panel-pg-test-$RANDOM"
pg="panel-pg-$RANDOM"
cleanup(){ docker rm -f "$pg" >/dev/null 2>&1 || true; docker network rm "$network" >/dev/null 2>&1 || true; sudo rm -rf -- "$tmp"; }
trap cleanup EXIT
mkdir -m700 "$tmp/data" "$tmp/data/postgres-tls" "$tmp/server"
tls="$tmp/data/postgres-tls"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$tls/ca.key" -out "$tls/ca.crt" -days 2 -subj /CN=TestCA >/dev/null 2>&1
for pair in 'server:vps-postgres:serverAuth' 'admin:panel_db_admin:clientAuth'; do
  IFS=: read -r name cn purpose <<< "$pair"
  openssl req -new -newkey rsa:2048 -nodes -keyout "$tmp/$name.key" -out "$tmp/$name.csr" -subj "/CN=$cn" >/dev/null 2>&1
  printf 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=%s\nsubjectAltName=DNS:%s\n' "$purpose" "$cn" > "$tmp/$name.ext"
  openssl x509 -req -in "$tmp/$name.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -set_serial "0x$(openssl rand -hex 16)" -out "$tmp/$name.crt" -days 2 -extfile "$tmp/$name.ext" >/dev/null 2>&1
done
cp "$tmp/admin.crt" "$tmp/admin.key" "$tls/"
cp "$tmp/server.crt" "$tmp/server.key" "$tls/ca.crt" "$tmp/server/"
chmod 600 "$tls/"* "$tmp/server/"*
sudo chown -R 0:0 "$tmp/data"
sudo chown -R 999:999 "$tmp/server"
docker network create --internal "$network" >/dev/null
docker run -d --name "$pg" --network "$network" --network-alias vps-postgres --memory 384m \
  -e POSTGRES_HOST_AUTH_METHOD=trust --mount "type=bind,src=$tmp/server,dst=/certs,readonly" postgres:18 >/dev/null
for _ in $(seq 1 60); do if docker exec "$pg" pg_isready -U postgres >/dev/null 2>&1; then break; fi; sleep 1; done
sql(){ docker exec "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -Atc "$1" >/dev/null; }
sql 'CREATE ROLE panel_db_admin LOGIN SUPERUSER PASSWORD NULL; CREATE ROLE vps_panel_certificate_clients NOLOGIN; CREATE ROLE owner_alpha NOLOGIN; CREATE ROLE owner_beta NOLOGIN;'
sql 'CREATE DATABASE alpha OWNER owner_alpha';sql 'CREATE DATABASE beta OWNER owner_beta'
sql "ALTER SYSTEM SET ssl_cert_file='/certs/server.crt'";sql "ALTER SYSTEM SET ssl_key_file='/certs/server.key'"
sql "ALTER SYSTEM SET ssl_ca_file='/certs/ca.crt'";sql "ALTER SYSTEM SET ssl='on'"
docker exec -i "$pg" sh -c 'cat > "$PGDATA/panel-hba"; cat "$PGDATA/pg_hba.conf" >> "$PGDATA/panel-hba"; cat "$PGDATA/panel-hba" > "$PGDATA/pg_hba.conf"' <<'HBA'
hostssl all panel_db_admin 0.0.0.0/0 cert
host all panel_db_admin 0.0.0.0/0 reject
hostssl all +vps_panel_certificate_clients 0.0.0.0/0 cert
host all +vps_panel_certificate_clients 0.0.0.0/0 reject
HBA
sql 'SELECT pg_reload_conf()';sleep 2
docker build -t vps-panel-api:database-test server
docker run --rm --network "$network" --memory 200m --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$tmp/data,dst=/data" \
  --mount "type=bind,src=$PWD/server/database-admin.integration.mjs,dst=/app/database-admin.integration.mjs,readonly" \
  -e PANEL_POSTGRES_ENABLED=1 -e PANEL_POSTGRES_HOST=vps-postgres -e PANEL_POSTGRES_USER=panel_db_admin \
  -e PANEL_POSTGRES_TLS_ENABLED=1 -e PANEL_POSTGRES_WRITE_ENABLED=1 -e PANEL_POSTGRES_CERTIFICATE_LANE=1 \
  --entrypoint node vps-panel-api:database-test --experimental-strip-types database-admin.integration.mjs
