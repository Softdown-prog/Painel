#!/usr/bin/env bash
# Read-only production preflight. Never starts/stops containers or changes volumes.
set -euo pipefail
cd "$(dirname "$0")"
cd ..

compose=(-f compose.yaml)
for overlay in "$@"; do
  if [[ "$overlay" != compose.*.yaml || ! -f "$overlay" ]]; then
    echo "ERROR: Provide existing compose.*.yaml overlay filenames only." >&2
    exit 2
  fi
  compose+=(-f "$overlay")
done

command -v docker >/dev/null || { echo 'ERROR: Docker CLI unavailable' >&2; exit 2; }
command -v python3 >/dev/null || { echo 'ERROR: Python 3 unavailable' >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo 'ERROR: Docker daemon unavailable or no permission' >&2; exit 2; }
docker compose version >/dev/null || { echo 'ERROR: Docker Compose plugin missing' >&2; exit 2; }
docker compose "${compose[@]}" config --quiet

# Validate the effective merged configuration. Never print interpolated environment or secrets.
docker compose "${compose[@]}" config --format json | python3 -c '
import json,sys
data=json.load(sys.stdin); sv=data.get("services",{})
api=sv.get("api",{}); ex=sv.get("executor",{})
def mounts(s): return [v for v in s.get("volumes",[]) if isinstance(v,dict)]
def target(v): return v.get("target","")
am=mounts(api); em=mounts(ex)
assert ex.get("network_mode")=="none", "Executor must have network_mode none"
assert api.get("depends_on",{}).get("executor",{}).get("condition")=="service_healthy", "Missing health dependency"
assert all(target(v)!="/var/run/docker.sock" for v in am), "API must not mount Docker host socket"
assert sum(target(v)=="/var/run/docker.sock" for v in em)==1, "Executor must have one Docker socket"
assert sum(target(v)=="/run/panel-executor" for v in am)==1, "API must have executor volume"
assert sum(target(v)=="/run/panel-executor" for v in em)==1, "Executor must have socket volume"
assert all(v.get("read_only") for v in am if target(v)=="/run/panel-executor"), "API socket mount must be read-only"
assert api.get("environment",{}).get("PANEL_DOCKER_SOCKET_PATH")=="/run/panel-executor/docker.sock", "API client socket misconfigured"
print("PASS: effective Compose isolates Docker socket in networkless executor")
'

for path in /etc/softload-panel/edge-key /opt/softload-infra/softload/.env; do
  if [[ -r "$path" ]]; then echo "PASS: Required host file available: $path"
  else echo "ERROR: Required host file inaccessible: $path" >&2; exit 2; fi
done

if docker volume inspect softload_panel_data >/dev/null 2>&1; then
  echo 'PASS: Existing panel data volume located (backup independently before any rollout)'
else
  echo 'NOTICE: No existing panel data volume. Confirm whether this is a fresh installation.'
fi
if docker container inspect softload-panel-api >/dev/null 2>&1; then
  docker inspect softload-panel-api --format '{{range .Mounts}}{{if eq .Destination "/var/run/docker.sock"}}NOTICE: Current API still has direct Docker socket; deploy required.{{end}}{{end}}'
  echo 'PASS: Existing Panel API container detected. Its production state was not modified.'
else
  echo 'NOTICE: Existing Panel API container was not found.'
fi
for name in softload-vps-app-1 softload-vps-agent-1 softload-vps-sandbox-1 softload-vps-embeddings-1 softload-caddy; do
  if docker container inspect "$name" >/dev/null 2>&1; then
    echo "PASS: Production container exists: $name"
  else
    echo "NOTICE: Production container not present under expected name: $name"
  fi
done
echo 'Preflight complete: read-only. No service was recreated or restarted.'
