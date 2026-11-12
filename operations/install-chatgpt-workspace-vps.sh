#!/usr/bin/env bash
# Explicit root-only opt-in. Does not restart Codex, API, containers or runners.
set -Eeuo pipefail
umask 077
if [[ "$EUID" -ne 0 || "$#" -ne 3 || ( "$1" != check && "$1" != apply ) ]]; then
  echo 'Usage: sudo bash operations/install-chatgpt-workspace-vps.sh check|apply /reviewed/Painel/checkout EXPECTED_RECEIVER_SHA256' >&2
  exit 2
fi
mode="$1"
checkout="$(realpath -e -- "$2")"
expected="$3"
[[ "$expected" =~ ^[a-f0-9]{64}$ ]] || { echo 'Expected installed SHA-256 required' >&2; exit 2; }
src="$checkout/operations"
target=/usr/local/lib/vps-operations
policy=/etc/vps-operations/policy.json
supervisor=/usr/local/lib/panel-workspaces/workspace_build.py
for file in "$src/receiver.py" "$src/chatgpt_workspace.py" "$src/policy.example.json" "$supervisor" "$policy" "$target/receiver.py"; do
  [[ -f "$file" && ! -L "$file" ]] || { echo "Missing or symbolic installation file: $file" >&2; exit 2; }
done
[[ ! -L "$target" && ! -L /srv/panel-codex/workspace ]] || exit 2
actual="$(sha256sum "$target/receiver.py" | cut -d' ' -f1)"
[[ "$actual" == "$expected" ]] || { echo 'Installed receiver changed: refusing mutation' >&2; exit 2; }
python3 -m py_compile "$src/receiver.py" "$src/chatgpt_workspace.py" "$supervisor"
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
print('PASS: trusted existing GitHub policy')
PY
if [[ "$mode" == check ]]; then
  echo 'PASS: preflight only, no file, container or service modified'
  exit 0
fi
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
echo 'ChatGPT issue bridge enabled; no services restarted, no deployments.'
