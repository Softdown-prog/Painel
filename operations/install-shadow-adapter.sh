#!/usr/bin/env bash
# Explicit, one-time VPS maintenance for a previously installed forced-command broker.
# Does not modify SSH credentials, Docker services, Caddy, ports, or the root policy of other projects.
set -euo pipefail
[[ "${EUID}" -eq 0 && $# -eq 1 ]] || {
  echo 'Usage: sudo bash operations/install-shadow-adapter.sh /path/to/Painel/operations' >&2
  exit 2
}
src=$(realpath "$1")
lib=/usr/local/lib/vps-operations
policy=/etc/vps-operations/policy.json
[[ -f "$policy" && -f "$lib/receiver.py" && -f "$lib/driver.py" ]] || {
  echo 'Broker existente nao encontrado; instalacao abortada' >&2
  exit 2
}
for file in receiver.py driver.py shadow.py policy.example.json; do
  [[ -f "$src/$file" ]] || { echo "Falta $file" >&2; exit 2; }
done
python3 -m py_compile "$src/receiver.py" "$src/driver.py" "$src/shadow.py"
# Verify current production policy before changing any root-owned file.
python3 - "$policy" "$src/policy.example.json" <<'PY'
import json,sys
live=json.load(open(sys.argv[1]))
new=json.load(open(sys.argv[2]))
repo=live['repositories']['1438758092']
if repo['name']!='Softdown-prog/Terrania' or 'deploy-vps.yml' not in repo['workflows']:
    raise SystemExit('Terrania policy shape unexpected, abort')
if repo.get('workflow_scopes') and 'deploy-go-shadow.yml' in repo['workflow_scopes']:
    print('Shadow policy already known; verifying desired scope')
print('Current root policy validated')
PY
install -m 0644 "$src/receiver.py" "$src/driver.py" "$src/shadow.py" "$lib/"
python3 - "$policy" "$src/policy.example.json" <<'PY'
import json,os,sys,tempfile
target,example=sys.argv[1:]
with open(target) as f: policy=json.load(f)
with open(example) as f: candidate=json.load(f)
repos=policy['repositories']
terrania=repos['1438758092']
addition=candidate['repositories']['1438758092']
for key in ('workflows','projects'):
    for item in addition[key]:
        if item not in terrania[key]: terrania[key].append(item)
scopes=terrania.setdefault('workflow_scopes',{})
for workflow, projects in addition['workflow_scopes'].items():
    if workflow in scopes and scopes[workflow]!=projects:
        raise SystemExit('Existing workflow scope differs; manual review required: '+workflow)
    scopes[workflow]=projects
name='terrania-go-shadow'
if name in policy['projects'] and policy['projects'][name]!=candidate['projects'][name]:
    raise SystemExit('Existing shadow project differs; manual review required')
policy['projects'][name]=candidate['projects'][name]
directory=os.path.dirname(target)
fd,tmp=tempfile.mkstemp(prefix='.policy-shadow-',dir=directory)
try:
    with os.fdopen(fd,'w') as f:
        json.dump(policy,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
    os.chmod(tmp,0o600)
    os.replace(tmp,target)
finally:
    if os.path.exists(tmp):os.unlink(tmp)
PY
python3 -m py_compile "$lib/receiver.py" "$lib/driver.py" "$lib/shadow.py"
echo 'Shadow broker installed. Existing project containers and routes were not changed.'
