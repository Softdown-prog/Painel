#!/usr/bin/env bash
# One-time, separately authorized bootstrap of a fixed-purpose code-MCP broker operation.
# NOT invoked by CI: existing forced-command SSH refuses unregistered operations.
set -Eeuo pipefail
umask 077
[[ "$EUID" -eq 0 && "$#" -eq 1 ]] || {
 echo 'Root authorization and one verified checkout path are required.' >&2
 exit 2
}
source_dir="$(realpath "$1")"
installed=/usr/local/lib/vps-operations
policy_file=/etc/vps-operations/policy.json
for file in "$source_dir/operations/receiver.py" "$source_dir/operations/code_mcp.py" \
            "$source_dir/operations/policy.example.json" "$installed/receiver.py" \
            "$policy_file" /usr/local/libexec/vps-operations /etc/sudoers.d/vps-operations; do
 [[ -f "$file" ]] || { echo "Missing expected file" >&2; exit 2; }
done
grep -Fq '/usr/local/libexec/vps-operations' /etc/sudoers.d/vps-operations
python3 -m py_compile "$source_dir/operations/receiver.py" "$source_dir/operations/code_mcp.py"
python3 - "$source_dir" <<'PY'
import json,os,pathlib,sys,tempfile
src=pathlib.Path(sys.argv[1])
dst=pathlib.Path('/usr/local/lib/vps-operations')
policy_file=pathlib.Path('/etc/vps-operations/policy.json')
policy=json.loads(policy_file.read_text())
expected=json.loads((src/'operations/policy.example.json').read_text())
repo=policy.get('repositories',{}).get('1433232532',{})
if repo.get('name')!='Softdown-prog/Painel' or 'infrastructure' not in repo.get('projects',[]):
    raise SystemExit('Installed broker repo/infrastructure policy mismatches')
if '189416996' not in policy.get('actor_ids',[]):
    raise SystemExit('Installed broker administrative actor mismatches')
if 'maintenance' not in policy or (policy['maintenance'].get('actor_ids') or [])!=['189416996']:
    raise SystemExit('Required maintenance policy not installed; do not bypass it')
if 'code_mcp' in policy and policy['code_mcp'] != expected['code_mcp']:
    raise SystemExit('MCP policy already exists with unexpected values; manual review required')
policy['code_mcp']=expected['code_mcp']
for field,value in [('workflows','code-mcp-vps.yml'),('operations','code_mcp')]:
    if value not in repo.get(field,[]):
        repo[field].append(value)
existing={name:(dst/name).read_bytes() if (dst/name).exists() else None
          for name in ('receiver.py','code_mcp.py')}
old_policy=policy_file.read_bytes()
with tempfile.TemporaryDirectory(dir=str(dst),prefix='.mcp-upgrade-') as tmp:
    staging=pathlib.Path(tmp)
    for name in ('receiver.py','code_mcp.py'):
        p=staging/name
        p.write_bytes((src/'operations'/name).read_bytes());p.chmod(0o644)
    with tempfile.TemporaryDirectory(dir=str(policy_file.parent),prefix='.mcp-policy-') as temporary:
        new_policy=pathlib.Path(temporary)/'policy.json'
        new_policy.write_text(json.dumps(policy,indent=2)+'\n')
        new_policy.chmod(0o600)
        try:
            for name in ('receiver.py','code_mcp.py'):
                os.replace(staging/name,dst/name)
            os.replace(new_policy,policy_file)
            os.chmod(policy_file,0o600)
        except BaseException:
            for name,data in existing.items():
                if data is None:(dst/name).unlink(missing_ok=True)
                else:(dst/name).write_bytes(data);(dst/name).chmod(0o644)
            policy_file.write_bytes(old_policy);policy_file.chmod(0o600)
            raise
PY
echo 'Code-MCP operation installed in vpsops broker; no containers changed.'
echo 'GitHub workflow still requires protected vps-maintenance environment and approval.'
