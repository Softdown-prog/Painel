#!/usr/bin/env bash
# One-time root opt-in of the EXISTING vpsops broker. No container restart.
set -Eeuo pipefail
umask 077
[[ "$EUID" -eq 0 && "$#" -eq 1 ]] || {
  echo "Uso: sudo bash operations/upgrade-vpsops-codex.sh <diretorio-Painel>" >&2; exit 2;
}
source_dir="$(realpath "$1")"
installed=/usr/local/lib/vps-operations
policy_file=/etc/vps-operations/policy.json
for f in "$installed/receiver.py" "$installed/driver.py" "$installed/admission.py" "$policy_file" \
         "$source_dir/operations/codex.py" "$source_dir/operations/driver.py" \
         "$source_dir/operations/admission.py" "$source_dir/operations/policy.example.json" \
         /usr/local/libexec/vps-operations /etc/sudoers.d/vps-operations; do
  [[ -f "$f" ]] || { echo "Arquivo esperado ausente: $f" >&2; exit 2; }
done
grep -Fq 'admission = admit(project, sha, images)' "$installed/driver.py" || {
  echo "Barreira de admissão ausente; não é seguro instalar o novo adaptador." >&2; exit 2;
}
grep -Fq '/usr/local/libexec/vps-operations' /etc/sudoers.d/vps-operations || {
  echo "Executor vpsops divergente; nada foi modificado." >&2; exit 2;
}
python3 -m py_compile "$source_dir/operations/codex.py" \
  "$source_dir/operations/driver.py" "$source_dir/operations/admission.py"
python3 - "$source_dir" <<'PY'
import json,os,pathlib,sys,tempfile
src=pathlib.Path(sys.argv[1])
dst=pathlib.Path('/usr/local/lib/vps-operations')
path=pathlib.Path('/etc/vps-operations/policy.json')
policy=json.loads(path.read_text())
expected=json.loads((src/'operations/policy.example.json').read_text())
ident='1433232532'
repo=policy.get('repositories',{}).get(ident,{})
if repo.get('name')!='Softdown-prog/Painel' or '189416996' not in policy.get('actor_ids',[]):
    raise SystemExit('Identidade ou repositório não reconhecido: abortado')
if not {'deploy','inventory','verify'}.issubset(set(repo.get('operations',[]))):
    raise SystemExit('Executor ainda não oferece o protocolo de deploy esperado')
for project in ('panel','panel-web'):
    if project not in repo.get('projects',[]) or project not in policy.get('projects',{}):
        raise SystemExit('Projetos de painel instalados divergentes')
name='panel-codex'
new_project=expected['projects'][name]
prior=policy.get('projects',{}).get(name)
if prior is not None and prior!=new_project:
    raise SystemExit('Registro Codex existente difere da nova política; revisão manual necessária')
policy['projects'][name]=new_project
for field,value in [('workflows','stage-codex-bridge.yml'),('projects',name)]:
    allowed=repo.setdefault(field,[])
    if value not in allowed: allowed.append(value)
files=('driver.py','admission.py','codex.py')
original={name:(dst/name).read_bytes() if (dst/name).exists() else None for name in files}
old_policy=path.read_bytes()
with tempfile.TemporaryDirectory(dir=dst,prefix='.codex-policy-') as tmp:
    stage=pathlib.Path(tmp)
    for name in files:
        dest=stage/name
        dest.write_bytes((src/'operations'/name).read_bytes())
        dest.chmod(0o644)
    with tempfile.TemporaryDirectory(dir=path.parent,prefix='.codex-policy-') as temp_policy:
        pending=pathlib.Path(temp_policy)/'policy.json'
        pending.write_text(json.dumps(policy,indent=2)+'\n')
        pending.chmod(0o600)
        try:
            for name in files: os.replace(stage/name,dst/name)
            os.replace(pending,path)
            path.chmod(0o600)
        except BaseException:
            for name,content in original.items():
                target=dst/name
                if content is None: target.unlink(missing_ok=True)
                else:
                    target.write_bytes(content)
                    target.chmod(0o644)
            path.write_bytes(old_policy)
            path.chmod(0o600)
            raise
PY
echo 'Política vpsops atualizada somente para panel-codex. Nenhum container foi reiniciado.'
echo 'Após conferir o Compose real, use o workflow stage-codex-bridge.yml (ativação explícita).'
