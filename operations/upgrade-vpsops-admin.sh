#!/usr/bin/env bash
# Upgrade the EXISTING root-owned vpsops forced-command receiver in place.
# No new SSH users, keys, listeners, sudoers grants or containers are created.
set -Eeuo pipefail
umask 077
[[ "$EUID" -eq 0 && "$#" -eq 1 ]] || { echo "Uso: sudo bash operations/upgrade-vpsops-admin.sh <diretorio-do-Painel>"; exit 2; }
src="$(realpath "$1")"
dir=/usr/local/lib/vps-operations
policy=/etc/vps-operations/policy.json
for p in "$dir/receiver.py" "$dir/driver.py" "$policy" /usr/local/libexec/vps-operations /etc/sudoers.d/vps-operations "$src/operations/receiver.py" "$src/operations/admin.py"; do
  [[ -f "$p" ]] || { echo "Arquivo ausente: $p"; exit 2; }
done
python3 -m py_compile "$src/operations/receiver.py" "$src/operations/admin.py"
# Preserve the original forced-command identity, SSH key and existing policy entries.
grep -Fq '/usr/local/libexec/vps-operations' /etc/sudoers.d/vps-operations || { echo "sudoers do executor diverge"; exit 2; }
python3 - "$src" <<'PY'
import json,os,pathlib,sys,tempfile
src=pathlib.Path(sys.argv[1]); dst=pathlib.Path('/usr/local/lib/vps-operations')
policy_file=pathlib.Path('/etc/vps-operations/policy.json')
policy=json.loads(policy_file.read_text())
repo=policy.get('repositories',{}).get('1433232532',{})
if repo.get('name')!='Softdown-prog/Painel' or 'infrastructure' not in repo.get('projects',[]):
    raise SystemExit('Identidade/projeto do broker divergente')
if '189416996' not in policy.get('actor_ids', []):
    raise SystemExit('Identidade administrativa não está autorizada')
admin={'repository_id':'1433232532', 'workflow':'vps-admin.yml',
       'project':'infrastructure', 'actor_ids':['189416996'],
       'environment':'vps-admin'}
if 'admin' in policy and policy['admin'] != admin:
    raise SystemExit('A política administrativa existente diverge; revisar antes de modificar')
policy['admin']=admin
for key,value in [('workflows','vps-admin.yml'),('operations','admin')]:
    if value not in repo[key]:repo[key].append(value)
# This identity retains exactly its previous restricted SSH/sudo permissions.
# The signed root receiver is the only entry point for arbitrary admin commands.
with tempfile.TemporaryDirectory(dir=str(dst),prefix='.admin-upgrade-') as t:
    tmp=pathlib.Path(t)
    for name in ('receiver.py','admin.py'):
        p=tmp/name;p.write_bytes((src/'operations'/name).read_bytes());p.chmod(0o644)
    config=tmp/'policy.json';config.write_text(json.dumps(policy,indent=2)+'\n');config.chmod(0o600)
    original_receiver=(dst/'receiver.py').read_bytes()
    original_admin=(dst/'admin.py').read_bytes() if (dst/'admin.py').exists() else None
    original_policy=policy_file.read_bytes()
    try:
        os.replace(tmp/'admin.py',dst/'admin.py')
        os.replace(tmp/'receiver.py',dst/'receiver.py')
        os.replace(config,policy_file)
        os.chmod(policy_file,0o600)
    except BaseException:
        (dst/'receiver.py').write_bytes(original_receiver)
        if original_admin is None:(dst/'admin.py').unlink(missing_ok=True)
        else:(dst/'admin.py').write_bytes(original_admin)
        policy_file.write_bytes(original_policy);os.chmod(policy_file,0o600)
        raise
PY
echo 'Executor vpsops EXISTENTE atualizado: administração root autenticada disponível.'
echo 'SSH forced-command, usuário, chave, sudoers e containers foram preservados.'
