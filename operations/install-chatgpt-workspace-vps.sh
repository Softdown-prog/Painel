#!/usr/bin/env bash
# Explicit root-only opt-in. No container, Codex, API or runner restart.
set -Eeuo pipefail
umask 077
if [[ "$EUID" -ne 0 || "$#" -ne 4 || ( "$1" != check && "$1" != apply ) ]]; then
  echo 'Usage: sudo bash operations/install-chatgpt-workspace-vps.sh check|apply /reviewed/Painel/checkout RECEIVER_SHA256 SUPERVISOR_SHA256' >&2
  exit 2
fi
mode="$1"
checkout="$(realpath -e -- "$2")"
expected_receiver="$3"
expected_supervisor="$4"
[[ "$expected_receiver" =~ ^[a-f0-9]{64}$ && "$expected_supervisor" =~ ^[a-f0-9]{64}$ ]] || {
  echo 'Exact SHA-256 of installed receiver and supervisor required' >&2
  exit 2
}
src="$checkout/operations"
target=/usr/local/lib/vps-operations
policy=/etc/vps-operations/policy.json
supervisor=/usr/local/lib/panel-workspaces/workspace_build.py
sources=/srv/panel-chatgpt-sources
jobs=/srv/panel-workspace-builds
for file in "$src/receiver.py" "$src/chatgpt_workspace.py" "$src/workspace_build.py" "$src/policy.example.json" "$supervisor" "$policy" "$target/receiver.py"; do
  [[ -f "$file" && ! -L "$file" ]] || { echo "Untrusted/missing file: $file" >&2; exit 2; }
done
for dir in "$target" /usr/local/lib/panel-workspaces /srv; do
  [[ -d "$dir" && ! -L "$dir" ]] || { echo "Unsafe directory: $dir" >&2; exit 2; }
done
[[ ! -L "$sources" && ! -L "$jobs" ]] || { echo 'Source/jobs root may not be symbolic' >&2; exit 2; }
[[ "$(sha256sum "$target/receiver.py" | cut -d' ' -f1)" == "$expected_receiver" ]] || {
  echo 'Installed receiver changed; refusing update' >&2; exit 2;
}
[[ "$(sha256sum "$supervisor" | cut -d' ' -f1)" == "$expected_supervisor" ]] || {
  echo 'Installed workspace supervisor changed; refusing update' >&2; exit 2;
}
python3 -m py_compile "$src/receiver.py" "$src/chatgpt_workspace.py" "$src/workspace_build.py"
bash -n "$src/install-chatgpt-workspace-vps.sh"
python3 - "$policy" "$src/policy.example.json" <<'PY'
import json,sys
from pathlib import Path
current=json.loads(Path(sys.argv[1]).read_text())
example=json.loads(Path(sys.argv[2]).read_text())
repo=current['repositories']['1433232532']
assert repo['name']=='Softdown-prog/Painel'
assert 'vps-command.yml' in repo['workflows'] and 'infrastructure' in repo['projects']
assert example['workspace']['projects']==['lhs','terrania']
print('PASS: existing root policy and immutable workflow allowlist')
PY
if [[ "$mode" == check ]]; then
  echo 'PASS: preflight only; no filesystem, container or service modified'
  exit 0
fi
# A live browser job must not swap its supervisor executable.
[[ -d "$jobs" ]] || { echo 'Workspace supervisor jobs directory missing' >&2; exit 2; }
exec 9>"$jobs/.active.lock"
flock -n 9 || { echo 'Workspace build currently running: installer refused' >&2; exit 2; }
python3 - "$jobs" <<'PY'
import json,sys
from pathlib import Path
for entry in Path(sys.argv[1]).iterdir():
    if entry.is_dir() and len(entry.name)==16 and all(c in '0123456789abcdef' for c in entry.name):
        state=entry/'status.json'
        if state.is_file() and json.loads(state.read_text()).get('status') in ('queued','running'):
            raise SystemExit('Queued/running job found: refusing program replacement')
PY
install -d -o root -g root -m 0755 "$sources"
[[ "$(stat -c '%u' "$sources")" == 0 ]] || { echo 'Source root not owned by root' >&2; exit 2; }
[[ -z "$(find "$sources" -maxdepth 0 -perm /022 -print)" ]] || { echo 'Source root is writable by non-root' >&2; exit 2; }
install -m 0755 -o root -g root "$src/workspace_build.py" /usr/local/lib/panel-workspaces/.workspace_build.py.new
mv -f /usr/local/lib/panel-workspaces/.workspace_build.py.new "$supervisor"
install -m 0644 -o root -g root "$src/chatgpt_workspace.py" "$target/.chatgpt_workspace.py.new"
mv -f "$target/.chatgpt_workspace.py.new" "$target/chatgpt_workspace.py"
python3 - "$policy" <<'PY'
import json,os,sys,tempfile
from pathlib import Path
p=Path(sys.argv[1]); data=json.loads(p.read_text())
repo=data['repositories']['1433232532']
if 'workspace' not in repo['operations']:
    repo['operations'].append('workspace')
data['workspace']={'enabled':True,'actor_ids':['189416996'],'projects':['lhs','terrania']}
fd,tmp=tempfile.mkstemp(prefix='.policy-',dir=p.parent)
try:
    with os.fdopen(fd,'w') as out:
        json.dump(data,out,indent=2)
        out.flush(); os.fsync(out.fileno())
    os.chmod(tmp,0o600)
    os.replace(tmp,p)
finally:
    if os.path.exists(tmp): os.unlink(tmp)
PY
install -m 0644 -o root -g root "$src/receiver.py" "$target/.receiver.py.new"
mv -f "$target/.receiver.py.new" "$target/receiver.py"
echo 'ChatGPT bridge enabled; only root broker, supervisor and policy updated.'
