#!/usr/bin/env bash
# Opt-in, reviewed root-owned read-only SAC Worker broker installation.
# Run locally on the VPS only after manual code review and approval.
set -Eeuo pipefail
umask 077
if [[ $EUID -ne 0 || $# -ne 3 || ( "$1" != check && "$1" != apply ) ]]; then
  echo "Usage: sudo bash upgrade-vpsops-sac-worker.sh check|apply /verified/Painel/checkout <full-reviewed-commit-sha>" >&2
  exit 2
fi
mode="$1"
checkout="$(realpath -e "$2")"
sha="$3"
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || { echo "Invalid reviewed commit SHA" >&2; exit 2; }
[[ -f "$checkout/operations/sac_worker_upgrade.py" && -f "$checkout/operations/sac_worker.py" &&
   -f "$checkout/operations/receiver.py" && -f "$checkout/operations/policy.example.json" ]] ||
  { echo "Missing verified source files" >&2; exit 2; }
[[ "$(git -C "$checkout" rev-parse --show-toplevel)" == "$checkout" &&
   "$(git -C "$checkout" rev-parse HEAD)" == "$sha" ]] ||
  { echo "Checkout must match the exact manually reviewed commit" >&2; exit 2; }
[[ -z "$(git -C "$checkout" status --porcelain --untracked-files=no)" ]] ||
  { echo "Checkout has uncommitted tracked modifications" >&2; exit 2; }
for file in /usr/local/libexec/vps-operations /etc/sudoers.d/vps-operations; do
  [[ -f "$file" && ! -L "$file" ]] || { echo "Forced-command broker guard missing" >&2; exit 2; }
done
grep -Fq '/usr/local/libexec/vps-operations' /etc/sudoers.d/vps-operations ||
  { echo "Forced-command sudo policy missing" >&2; exit 2; }
# Validate without py_compile: it writes __pycache__ even during 'check'.
# ast.parse checks syntax in memory and produces no .pyc or source-tree writes.
python3 - "$checkout" <<'PY'
import ast
from pathlib import Path
import sys
source = Path(sys.argv[1]) / 'operations'
for name in ('receiver.py', 'sac_worker.py', 'sac_worker_upgrade.py'):
    ast.parse((source / name).read_text('utf8'), filename=name)
PY
python3 "$checkout/operations/sac_worker_upgrade.py" "$mode" "$checkout"
