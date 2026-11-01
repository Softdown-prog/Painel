#!/usr/bin/env bash
# Deliberate host-side opt-in. Never invoked by ordinary CI or branch pushes.
set -Eeuo pipefail
umask 077

if [[ "$EUID" -ne 0 || "$#" -ne 2 || ( "$1" != "check" && "$1" != "apply" ) ]]; then
  echo "Usage: sudo bash install-terminal-host-jobs.sh check|apply /verified/Painel/checkout" >&2
  exit 2
fi
mode="$1"
checkout="$(realpath -- "$2")"
source="$checkout/operations/terminal_host_jobs.py"
target=/usr/local/libexec/vps-panel-terminal-jobs
data=/var/lib/vps-panel-terminal-jobs

[[ -f "$source" && ! -L "$source" ]] || { echo 'Missing expected helper' >&2; exit 2; }
[[ -d /usr/local/libexec && ! -L /usr/local/libexec ]] || { echo 'Unsafe libexec directory' >&2; exit 2; }
[[ ! -L "$target" ]] || { echo 'Refusing a symlink installation' >&2; exit 2; }
[[ ! -e "$data" || ( -d "$data" && ! -L "$data" ) ]] || {
  echo 'Unsafe terminal data directory' >&2
  exit 2
}
python3 - "$source" <<'PY'
from pathlib import Path
import sys
source=Path(sys.argv[1])
compile(source.read_bytes(), str(source), 'exec')
if source.stat().st_mode & 0o022:
    raise SystemExit('Refusing source writable by group or other')
print('PASS: terminal helper syntax and permissions')
PY
if [[ "$mode" == 'check' ]]; then
  echo 'No changes made'
  exit 0
fi
install -d -o root -g root -m 0700 "$data"
install -o root -g root -m 0755 "$source" "$target"
echo 'Host terminal supervisor installed; no services restarted or configuration changed.'
echo 'Enable PANEL_TERMINAL_PERSISTENT=1 separately only after reviewing the API deployment.'
