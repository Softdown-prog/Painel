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
service_source="$checkout/operations/systemd/vps-panel-terminal-gc.service"
timer_source="$checkout/operations/systemd/vps-panel-terminal-gc.timer"
service_target=/etc/systemd/system/vps-panel-terminal-gc.service
timer_target=/etc/systemd/system/vps-panel-terminal-gc.timer

for file in "$source" "$service_source" "$timer_source"; do
  [[ -f "$file" && ! -L "$file" ]] || { echo 'Missing or unsafe install source' >&2; exit 2; }
done
[[ -d /usr/local/libexec && ! -L /usr/local/libexec ]] || { echo 'Unsafe libexec directory' >&2; exit 2; }
for dest in "$target" "$service_target" "$timer_target"; do
  [[ ! -L "$dest" ]] || { echo 'Refusing a symlink installation' >&2; exit 2; }
done
[[ ! -e "$data" || ( -d "$data" && ! -L "$data" ) ]] || {
  echo 'Unsafe terminal data directory' >&2
  exit 2
}
python3 - "$source" "$service_source" "$timer_source" <<'PY'
from pathlib import Path
import sys
sources=[Path(p) for p in sys.argv[1:]]
compile(sources[0].read_bytes(), str(sources[0]), 'exec')
for source in sources:
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
install -o root -g root -m 0644 "$service_source" "$service_target"
install -o root -g root -m 0644 "$timer_source" "$timer_target"
systemctl daemon-reload
systemctl enable --now vps-panel-terminal-gc.timer
systemctl is-active --quiet vps-panel-terminal-gc.timer || {
  echo 'Host cleanup timer did not start; do not enable persistent terminal' >&2
  exit 1
}
echo 'Host helper and reboot-safe cleanup timer installed; API untouched.'
echo 'Enable PANEL_TERMINAL_PERSISTENT=1 separately only after reviewing the API deployment.'
