#!/usr/bin/env bash
# Optional image installation ONLY. Never enables services or replaces LHS QA.
set -Eeuo pipefail
umask 077

if [[ "$EUID" -ne 0 || "$#" -lt 2 || "$#" -gt 3 || ( "$1" != check && "$1" != apply ) ]]; then
  echo 'Usage: sudo bash operations/install-dev-toolbox-vps.sh check|apply /reviewed/Painel/checkout [core|browser|full]' >&2
  exit 2
fi
mode="$1"
checkout="$(realpath -e -- "$2")"
target="${3:-browser}"
case "$target" in core|browser|full) ;; *) echo 'Invalid toolbox target' >&2; exit 2 ;; esac
dockerfile="$checkout/operations/dev-toolbox.Dockerfile"
smoke="$checkout/operations/dev-toolbox/smoke.sh"
requirements="$checkout/operations/dev-toolbox/python-requirements.in"
for file in "$dockerfile" "$smoke" "$requirements"; do
  [[ -f "$file" && ! -L "$file" ]] || { echo "Missing or symlink source: $file" >&2; exit 2; }
  [[ $(( $(stat -c '%a' "$file") % 10 )) -le 4 ]] || { echo 'Untrusted installation source permission' >&2; exit 2; }
done
if ! git -C "$checkout" rev-parse --is-inside-work-tree | grep -qx true; then
  echo 'Only an inspected Git checkout is supported' >&2; exit 2
fi
if [[ -n "$(git -C "$checkout" status --porcelain --untracked-files=no)" ]]; then
  echo 'Tracked source is dirty; no image was built' >&2; exit 2
fi
bash -n "$smoke"
command -v docker >/dev/null
docker info --format '{{.ServerVersion}}' >/dev/null
disk_gib=$(( $(df -Pk "$checkout" | awk 'NR==2 {print $4}') / 1048576 ))
need_gib=4
if [[ "$target" == browser ]]; then need_gib=8; fi
if [[ "$target" == full ]]; then need_gib=12; fi
if [[ "$disk_gib" -lt "$need_gib" ]]; then
  echo "Insufficient free disk for $target image: need at least ${need_gib} GiB" >&2; exit 2
fi
available_kib="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
if [[ "$target" != core && "${available_kib:-0}" -lt 2621440 ]]; then
  echo 'Not enough free host memory to build the heavier toolbox safely' >&2; exit 2
fi
sha="$(git -C "$checkout" rev-parse HEAD)"
image="panel-dev-toolbox:${target}"
echo "Reviewed checkout: $sha; target=$target; free disk=${disk_gib}GiB"
if [[ "$mode" == check ]]; then
  echo 'PASS: preflight only. No image built or containers/services modified.'
  exit 0
fi
# The reviewed Dockerfile is the only build input, with no production volumes.
docker build --pull --target "$target" -f "$dockerfile" -t "$image" "$checkout/operations"
docker run --rm --init --read-only --cap-drop ALL --network none \
  --security-opt no-new-privileges:true --pids-limit 128 \
  --memory 2048m --memory-swap 2048m --cpus 2 --shm-size 384m \
  --user 61110:61110 --tmpfs /tmp:rw,nosuid,nodev,size=128m \
  -v "$smoke:/smoke.sh:ro" "$image" sh /smoke.sh "$target"
echo 'Toolbox image created and smoke-tested; the Codex/MCP service was not changed.'
echo 'Workspace image selection requires a separate reviewed integration and authorization.'
