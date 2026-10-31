#!/usr/bin/env bash
# Deploy only the Panel API from a detached systemd unit.
# Preserve current Compose overlays, tunnel, executor, volumes and hosted projects.
set -Eeuo pipefail
umask 077
SHA=e4469c7c9c004afcb37047ea7d3142998fe87a8e
NEW=/opt/vps-panel/releases/$SHA/server
OLD=$(readlink -f /opt/vps-panel/current)
REG=/etc/softload-panel/compose-production-files.json
ENVFILE=/etc/softload-panel/runtime.env
IMAGE=vps-panel-api:$SHA
CONTAINER=softload-panel-api
exec 9>/run/lock/vps-panel-api-rollout.lock
flock -n 9 || { echo 'Atualização já em andamento'; exit 1; }
[[ -f "$NEW/compose.postgres.yaml" && -f "$NEW/compose.yaml" && -r "$REG" && -r "$ENVFILE" ]] || { echo 'Arquivos necessários ausentes'; exit 1; }
[[ "$NEW" != "$OLD" ]] || { echo 'Revisão já instalada'; exit 1; }
[[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" == true ]] || exit 1
[[ "$(docker inspect -f '{{.State.Running}}' vps-postgres)" == true ]] || exit 1
[[ "$(docker inspect -f '{{.State.Running}}' softload-panel-tunnel)" == true ]] || exit 1
docker image inspect "$IMAGE" >/dev/null
OLD_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")
docker image inspect "$OLD_IMAGE" >/dev/null
CSV=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$CONTAINER")
IFS=, read -r -a FILES <<< "$CSV"
[[ ${#FILES[@]} -eq 13 ]] || { echo 'Compose atual não tem os 13 overlays esperados'; exit 1; }
old_args=()
new_args=()
count=0
for path in "${FILES[@]}"; do
  [[ "$path" == "$OLD"/compose*.yaml && -f "$path" ]] || exit 1
  name=${path##*/}
  [[ -f "$NEW/$name" || "$name" == compose.install.yaml ]] || exit 1
  old_args+=(-f "$path")
  new_args+=(-f "$NEW/$name")
  if [[ "$name" == compose.install.yaml ]]; then count=$((count+1)); fi
done
[[ $count -eq 1 ]] || exit 1
new_args+=(-f "$NEW/compose.postgres.yaml")
python3 - "$OLD/compose.install.yaml" "$NEW/compose.install.yaml" "$OLD_IMAGE" "$IMAGE" <<'PY'
from pathlib import Path
import sys
src,dst,old,new=sys.argv[1:]
s=Path(src).read_text()
if s.count(old)!=1: raise SystemExit('Imagem antiga não localizada exatamente uma vez')
Path(dst).write_text(s.replace(old,new))
PY
docker compose --env-file "$ENVFILE" "${new_args[@]}" config --format json | python3 -c '
import json,sys
c=json.load(sys.stdin); a=c["services"]["api"]; e=c["services"]["executor"]
assert a["image"]==sys.argv[1]
assert set(a["networks"])=={"proxy","postgres_shared"}
assert c["networks"]["proxy"]["name"]=="vps_panel_control"
assert c["networks"]["postgres_shared"]["name"]=="vps_pg_private"
assert e["network_mode"]=="none"
assert a["environment"]["PANEL_POSTGRES_ENABLED"]=="1"
assert a["environment"]["PANEL_POSTGRES_HOST"]=="vps-postgres"
assert a["environment"]["PANEL_TERMINAL_SSH_ENABLED"]=="1"
assert not a.get("ports") and not a.get("depends_on")
assert c["volumes"]["panel_data"]["name"]=="softload_panel_data"
print("Compose, terminal, dados e redes: OK")
' "$IMAGE"
docker run --rm --network vps_pg_private -e PANEL_POSTGRES_ENABLED=1 --entrypoint node "$IMAGE" --experimental-strip-types --input-type=module -e '
import {getDatabaseStatus} from "./database.ts";
if((await getDatabaseStatus()).integration!=="connected")process.exit(1);
console.log("PostgreSQL: conectado");
'
swapped=0
rollback() {
  status=$?
  trap - EXIT
  if [[ $status -ne 0 && $swapped -eq 1 ]]; then
    echo 'Falha; restaurando apenas a API anterior...'
    docker compose --env-file "$ENVFILE" "${old_args[@]}" up -d --no-deps --no-build --force-recreate api || true
    docker inspect "$CONTAINER" --format 'API restaurada: {{.Config.Image}} / {{.State.Status}}' || true
  fi
  exit "$status"
}
trap rollback EXIT
echo 'Validações aprovadas; trocando exclusivamente a API.'
swapped=1
docker compose --env-file "$ENVFILE" "${new_args[@]}" up -d --no-deps --no-build --force-recreate api
ready=0
for i in $(seq 1 30); do
  if [[ "$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)" == "$IMAGE" ]] &&
     docker exec "$CONTAINER" node check-api-connection.mjs --check-panel-connection >/dev/null 2>&1 &&
     [[ "$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || true)" == healthy ]]; then
    ready=1; break
  fi
  sleep 3
done
[[ $ready -eq 1 ]] || { echo 'API não saudável'; exit 1; }
docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$CONTAINER" | grep -qx vps_panel_control
docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$CONTAINER" | grep -qx vps_pg_private
[[ "$(docker inspect -f '{{.State.Running}}' softload-panel-tunnel)" == true ]]
# Only after healthy probe, atomically update production registry and release pointer.
python3 - "$OLD" "$NEW" "$REG" <<'PY'
import json,os,pathlib,sys,tempfile,stat
old,new,reg=sys.argv[1:]
p=pathlib.Path(reg)
before=p.read_bytes()
text=before.decode()
assert old in text, 'Registry not aligned with installed release'
after=text.replace(old,new)
json.loads(after)
meta=p.stat()
fd,tmp=tempfile.mkstemp(dir=p.parent,prefix='.panel-compose-')
link=pathlib.Path('/opt/vps-panel/.current-next')
try:
    with os.fdopen(fd,'wb') as f: f.write(after.encode())
    os.chmod(tmp,stat.S_IMODE(meta.st_mode))
    os.chown(tmp,meta.st_uid,meta.st_gid)
    if link.is_symlink(): link.unlink()
    os.symlink(new,link)
    os.replace(tmp,p)
    try: os.replace(link,'/opt/vps-panel/current')
    except Exception:
        fd2,restore=tempfile.mkstemp(dir=p.parent,prefix='.panel-restore-')
        with os.fdopen(fd2,'wb') as f:f.write(before)
        os.chmod(restore,stat.S_IMODE(meta.st_mode))
        os.chown(restore,meta.st_uid,meta.st_gid)
        os.replace(restore,p)
        raise
finally:
    if os.path.exists(tmp):os.unlink(tmp)
    if link.is_symlink():link.unlink()
PY
swapped=0
echo "SUCESSO: somente $CONTAINER atualizado para $IMAGE; PostgreSQL e túnel preservados."
