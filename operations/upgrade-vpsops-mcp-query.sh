#!/usr/bin/env bash
# Manual, audited opt-in MCP metadata-query broker upgrade.
# No container changes, CLI invocation, shell execution, restart, network changes or deploy.
set -Eeuo pipefail
umask 077

[[ "$EUID" -eq 0 && "$#" -eq 2 && ( "$1" == "check" || "$1" == "apply" ) ]] || {
  echo "Usage: sudo bash upgrade-vpsops-mcp-query.sh check|apply /verified/Painel/checkout" >&2
  exit 2
}
mode="$1"
source_dir="$(realpath "$2")"
installed=/usr/local/lib/vps-operations
policy_file=/etc/vps-operations/policy.json

for name in receiver.py mcp_query.py; do
  [[ -f "$source_dir/operations/$name" ]] || { echo "Missing code source" >&2; exit 2; }
done
for file in "$source_dir/operations/policy.example.json" "$installed/receiver.py" "$policy_file" \
  /usr/local/libexec/vps-operations /etc/sudoers.d/vps-operations; do
  [[ -f "$file" ]] || { echo "Missing existing vpsops installation" >&2; exit 2; }
done
grep -Fq '/usr/local/libexec/vps-operations' /etc/sudoers.d/vps-operations
python3 -m py_compile "$source_dir/operations/receiver.py" "$source_dir/operations/mcp_query.py"
python3 - "$mode" "$source_dir" "$installed" "$policy_file" <<'PY'
import json
import os
from pathlib import Path
import sys
import tempfile

mode,src,installed,policy_file=sys.argv[1:]
src=Path(src)
installed=Path(installed)
policy_file=Path(policy_file)
current=json.loads(policy_file.read_text())
expected=json.loads((src/'operations/policy.example.json').read_text())
repo=current.get('repositories',{}).get('1433232532',{})
if repo.get('name')!='Softdown-prog/Painel' or 'infrastructure' not in repo.get('projects',[]):
    raise SystemExit('Installed repository ownership does not match')
if current.get('actor_ids')!=['189416996']:
    raise SystemExit('Installed actor policy differs; manual review required')
if (current.get('maintenance') or {}).get('actor_ids')!=['189416996'] or not (current.get('code_mcp') or {}).get('enabled'):
    raise SystemExit('Prior maintenance and MCP policies must already be installed')
if 'mcp_query' in current and current['mcp_query']!=expected['mcp_query']:
    raise SystemExit('Existing MCP query policy differs; manual review required')
new=json.loads(json.dumps(current))
new['mcp_query']=expected['mcp_query']
if 'mcp_query' not in new['repositories']['1433232532']['operations']:
    new['repositories']['1433232532']['operations'].append('mcp_query')
if 'vps-command.yml' not in new['repositories']['1433232532']['workflows']:
    raise SystemExit('Trusted workflow not installed')
if mode=='check':
    print(json.dumps({'safeToApply':True,'changesRequired':
                      'mcp_query' not in current or 'mcp_query' not in repo.get('operations',[]) or
                       not (installed/'mcp_query.py').exists(),
                      'containerChanges':False,'shellAccess':False}))
    sys.exit(0)

previous={name:(installed/name).read_bytes() if (installed/name).exists() else None
          for name in ('receiver.py','mcp_query.py')}
old_policy=policy_file.read_bytes()
try:
    with tempfile.TemporaryDirectory(prefix='.mcp-query-',dir=str(installed)) as tmp:
        stage=Path(tmp)
        for name in previous:
            target=stage/name
            target.write_bytes((src/'operations'/name).read_bytes())
            target.chmod(0o644)
        with tempfile.TemporaryDirectory(prefix='.mcp-query-',dir=str(policy_file.parent)) as policy_tmp:
            policy_staged=Path(policy_tmp)/'policy.json'
            policy_staged.write_text(json.dumps(new,indent=2)+'\n')
            policy_staged.chmod(0o600)
            for name in previous:
                os.replace(stage/name,installed/name)
            os.replace(policy_staged,policy_file)
            os.chmod(policy_file,0o600)
except BaseException:
    for name,data in previous.items():
        if data is None:
            (installed/name).unlink(missing_ok=True)
        else:
            (installed/name).write_bytes(data)
            (installed/name).chmod(0o644)
    policy_file.write_bytes(old_policy)
    policy_file.chmod(0o600)
    raise
print(json.dumps({'installed':True,'operation':'mcp_query','changed':True,
                 'containersChanged':False,'mainWorkflowRequired':True}))
PY
