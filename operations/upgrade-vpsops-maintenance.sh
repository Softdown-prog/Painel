#!/usr/bin/env bash
# Upgrade the EXISTING root-owned vpsops broker without changing SSH/sudo configuration.
set -Eeuo pipefail
umask 077
[[ "$EUID" -eq 0 && "$#" -eq 1 ]] || {
  echo "Uso: sudo bash operations/upgrade-vpsops-maintenance.sh <diretorio-Painel>" >&2; exit 2;
}
source_dir="$(realpath "$1")"
installed=/usr/local/lib/vps-operations
policy_file=/etc/vps-operations/policy.json
for f in "$source_dir/operations/receiver.py" "$source_dir/operations/maintenance.py" \
         "$source_dir/operations/policy.example.json" "$installed/receiver.py" "$policy_file" \
         /usr/local/libexec/vps-operations /etc/sudoers.d/vps-operations; do
  [[ -f "$f" ]] || { echo "Arquivo esperado ausente: $f" >&2; exit 2; }
done
grep -Fq '/usr/local/libexec/vps-operations' /etc/sudoers.d/vps-operations || {
  echo "Executor vpsops divergente; abortando" >&2; exit 2;
}
python3 -m py_compile "$source_dir/operations/receiver.py" "$source_dir/operations/maintenance.py"
python3 - "$source_dir" <<'PY'
import json,os,pathlib,sys,tempfile
src=pathlib.Path(sys.argv[1])
dst=pathlib.Path('/usr/local/lib/vps-operations')
file=pathlib.Path('/etc/vps-operations/policy.json')
policy=json.loads(file.read_text())
expected=json.loads((src/'operations/policy.example.json').read_text())
repo=policy.get('repositories',{}).get('1433232532',{})
if repo.get('name')!='Softdown-prog/Painel' or 'infrastructure' not in repo.get('projects',[]):
    raise SystemExit('Política do executor atual não reconhecida')
if '189416996' not in policy.get('actor_ids',[]):
    raise SystemExit('Identidade administrativa esperada ausente')
if 'maintenance' in policy and policy['maintenance']!=expected['maintenance']:
    raise SystemExit('Há configurações de manutenção divergentes; revisar manualmente')
policy['maintenance']=expected['maintenance']
for field,value in [('workflows','vps-maintenance.yml'),('operations','maintain')]:
    if value not in repo[field]:
        repo[field].append(value)
orig_receiver=(dst/'receiver.py').read_bytes()
old_maint=(dst/'maintenance.py').read_bytes() if (dst/'maintenance.py').exists() else None
old_policy=file.read_bytes()
with tempfile.TemporaryDirectory(dir=str(dst),prefix='.maintenance-') as tmp:
    staging=pathlib.Path(tmp)
    for item in ('receiver.py','maintenance.py'):
        p=staging/item
        p.write_bytes((src/'operations'/item).read_bytes());p.chmod(0o644)
    with tempfile.TemporaryDirectory(dir=str(file.parent),prefix='.maintenance-policy-') as tmp_pol:
        p=pathlib.Path(tmp_pol)/'policy.json'
        p.write_text(json.dumps(policy,indent=2)+'\n');p.chmod(0o600)
        try:
            os.replace(staging/'maintenance.py',dst/'maintenance.py')
            os.replace(staging/'receiver.py',dst/'receiver.py')
            os.replace(p,file)
            os.chmod(file,0o600)
        except BaseException:
            (dst/'receiver.py').write_bytes(orig_receiver)
            (dst/'receiver.py').chmod(0o644)
            if old_maint is None:(dst/'maintenance.py').unlink(missing_ok=True)
            else:(dst/'maintenance.py').write_bytes(old_maint)
            file.write_bytes(old_policy);file.chmod(0o600)
            raise
PY
echo 'Executor vpsops atual atualizado; SSH, sudoers, chaves e containers preservados.'
echo 'Configurar aprovadores obrigatórios em Actions > Environments > vps-maintenance.'
