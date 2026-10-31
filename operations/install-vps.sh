#!/usr/bin/env bash
# Install the dedicated, forced-command identity; public key is supplied by the authorized operator.
set -euo pipefail
[[ $EUID -eq 0 && $# -eq 2 ]] || { echo 'Usage: install-vps.sh <source directory> <public key file>'; exit 2; }
src=$(realpath "$1")
key=$(realpath "$2")
python3 -c 'import cryptography'
[[ -f "$src/receiver.py" && -f "$src/driver.py" && -f "$src/policy.json" ]] || exit 2
install -d -m 0700 /etc/vps-operations /var/lib/vps-operations
install -d -m 0755 /usr/local/lib/vps-operations /usr/local/libexec
install -m 0644 "$src/receiver.py" "$src/driver.py" /usr/local/lib/vps-operations/
install -m 0600 "$src/policy.json" /etc/vps-operations/policy.json
cat > /usr/local/libexec/vps-operations <<'WRAPPER'
#!/bin/sh
exec /usr/bin/python3 -I /usr/local/lib/vps-operations/receiver.py
WRAPPER
chmod 0755 /usr/local/libexec/vps-operations
id vpsops >/dev/null 2>&1 || useradd --create-home --shell /bin/sh vpsops
# No Docker group, no general sudo, no password login, no forwarding/PTY.
install -d -o root -g root -m 0755 /home/vpsops/.ssh
printf 'restrict,command="sudo -n /usr/local/libexec/vps-operations" %s\n' "$(cat "$key")" > /home/vpsops/.ssh/authorized_keys
chown root:root /home/vpsops/.ssh/authorized_keys
chmod 0644 /home/vpsops/.ssh/authorized_keys
printf 'vpsops ALL=(root) NOPASSWD: /usr/local/libexec/vps-operations ""\n' > /etc/sudoers.d/vps-operations
chmod 0440 /etc/sudoers.d/vps-operations
visudo -cf /etc/sudoers.d/vps-operations
python3 -m py_compile /usr/local/lib/vps-operations/receiver.py /usr/local/lib/vps-operations/driver.py
echo 'Dedicated executor installed; existing services were not restarted.'
