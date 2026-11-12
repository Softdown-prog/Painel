#!/usr/bin/env bash
# Explicit host-side opt-in. Not called by ordinary CI, push or deploy.
set -Eeuo pipefail
umask 077

if [[ "$EUID" -ne 0 || "$#" -ne 2 || ( "$1" != "check" && "$1" != "apply" ) ]]; then
  echo "Usage: sudo bash operations/install-workspace-build-vps.sh check|apply /verified/Painel/checkout" >&2
  exit 2
fi

mode="$1"
checkout="$(realpath -- "$2")"
source_py="$checkout/operations/workspace_build.py"
dockerfile="$checkout/operations/workspace-build.Dockerfile"
service_source="$checkout/operations/systemd/vps-panel-workspace-gc.service"
timer_source="$checkout/operations/systemd/vps-panel-workspace-gc.timer"
target_dir=/usr/local/lib/panel-workspaces
target="$target_dir/workspace_build.py"
data_dir=/srv/panel-workspace-builds
service_target=/etc/systemd/system/vps-panel-workspace-gc.service
timer_target=/etc/systemd/system/vps-panel-workspace-gc.timer
image=panel-lhs-qa:node24-pw1.56.1
workspace_root=/srv/panel-codex/workspace

for path in "$source_py" "$dockerfile" "$service_source" "$timer_source"; do
  [[ -f "$path" && ! -L "$path" ]] || { echo "Unsafe or missing source: $path" >&2; exit 2; }
done
for path in "$target_dir" "$data_dir" "$workspace_root"; do
  [[ ! -L "$path" ]] || { echo "Symlink directory is not permitted: $path" >&2; exit 2; }
done
for path in "$target" "$service_target" "$timer_target"; do
  [[ ! -L "$path" ]] || { echo "Symlink destination is not permitted: $path" >&2; exit 2; }
done
[[ -d "$workspace_root" && -d /usr/local/lib && -d /etc/systemd/system ]] || {
  echo "Required host workspace or system directory is absent; no installation attempted" >&2
  exit 2
}
command -v docker >/dev/null
command -v python3 >/dev/null
command -v flock >/dev/null
command -v systemctl >/dev/null

python3 - "$source_py" "$dockerfile" "$service_source" "$timer_source" <<'PY'
from pathlib import Path
import sys
files=[Path(p) for p in sys.argv[1:]]
compile(files[0].read_bytes(),str(files[0]),'exec')
for path in files:
    if path.stat().st_mode & 0o022:
        raise SystemExit('Refusing group/world-writable installer inputs')
for unit in files[2:]:
    if 'ExecStart=' not in unit.read_text() and unit.name.endswith('.service'):
        raise SystemExit('GC service missing ExecStart')
print('PASS: root-managed workspace source and timer preflight')
PY
bash -n "$checkout/operations/install-workspace-build-vps.sh"
docker info --format '{{.ServerVersion}}' >/dev/null
free_kib="$(df -Pk "$checkout" | awk 'NR==2 {print $4}')"
if [[ ! "$free_kib" =~ ^[0-9]+$ || "$free_kib" -lt 3145728 ]]; then
  echo 'Insufficient free disk space: need 3 GiB for the QA image and dependencies' >&2
  exit 2
fi

if [[ "$mode" == check ]]; then
  echo 'PASS: installation preflight complete; no files, services or containers modified'
  echo 'NOTE: host memory headroom and end-to-end LHS build still require acceptance testing'
  exit 0
fi

install -d -o root -g root -m 0700 "$data_dir"
exec 9>"$data_dir/.active.lock"
flock -n 9 || { echo 'A workspace build is active; refusing image replacement' >&2; exit 2; }

# Build from the reviewed Git checkout, never from the agent-writable workspace.
# Intentionally no secret mounts, --privileged, or Docker socket in the QA image.
docker build --pull -f "$dockerfile" -t "$image" "$checkout/operations"
docker run --rm --init --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 64 \
  --user 61110:61110 --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  "$image" node --version >/dev/null

install -d -o root -g root -m 0755 "$target_dir"
install -o root -g root -m 0755 "$source_py" "$target"
install -o root -g root -m 0644 "$service_source" "$service_target"
install -o root -g root -m 0644 "$timer_source" "$timer_target"
systemctl daemon-reload
systemctl enable --now vps-panel-workspace-gc.timer
systemctl is-active --quiet vps-panel-workspace-gc.timer || {
  echo 'GC timer did not activate; do not enable the agent build tool' >&2
  exit 1
}
echo 'Workspace QA supervisor installed. GC timer active; no project build was started.'
echo 'Run a manually approved test and check resource headroom before enabling automatic agent requests.'
