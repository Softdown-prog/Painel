#!/usr/bin/env bash
# One-time root bootstrap. Preserve existing production policy and services.
set -Eeuo pipefail
umask 077
[[ $EUID -eq 0 && $# -eq 1 ]] || { echo "Uso: sudo bash install-panel-web-adapter-vps.sh <diretório-do-repositório>"; exit 2; }
src="$(realpath "$1")"
[[ -f "$src/operations/web.py" && -f "$src/operations/driver.py" && -f "$src/.github/workflows/deploy-panel-web.yml" ]] || {
  echo "Origem sem arquivos esperados"; exit 2;
}
[[ -f /etc/vps-operations/policy.json && -f /usr/local/lib/vps-operations/driver.py &&
   -f /usr/local/lib/vps-operations/receiver.py ]] || { echo "Broker existente não encontrado"; exit 2; }
command -v python3 >/dev/null
command -v docker >/dev/null
python3 -m py_compile "$src/operations/web.py" "$src/operations/driver.py"
# Do not re-install SSH identity, change root permissions, restart API or touch other projects.
python3 - "$src" <<'PY'
import json,os,pathlib,sys,tempfile
src=pathlib.Path(sys.argv[1])
policy_path=pathlib.Path('/etc/vps-operations/policy.json')
policy=json.loads(policy_path.read_text())
repo=policy['repositories']['1433232532']
if repo.get('name')!='Softdown-prog/Painel' or 'deploy' not in repo['operations']:
    raise SystemExit('Repositório autorizado não confere: implantação abortada')
if policy['projects']['panel']['adapter']!='panel':
    raise SystemExit('Política do Painel divergente: implantação abortada')
expected={
  'repository':'Softdown-prog/Painel',
  'adapter':'web',
  'containers':{'web':'softload-panel-web'},
  'images':{'web':'ghcr.io/softdown-prog/painel-web'},
  'releases':'/opt/vps-panel/oci-web-releases'
}
if 'panel-web' in policy['projects'] and policy['projects']['panel-web']!=expected:
    raise SystemExit('Política existente para panel-web diverge; nenhuma alteração')
policy['projects']['panel-web']=expected
for field,value in [('projects','panel-web'),('workflows','deploy-panel-web.yml')]:
    if value not in repo[field]:repo[field].append(value)
dst=pathlib.Path('/usr/local/lib/vps-operations')
with tempfile.TemporaryDirectory(dir='/etc/vps-operations',prefix='.web-install-') as td:
    t=pathlib.Path(td)
    for name in ('driver.py','web.py'):
        (t/name).write_bytes((src/'operations'/name).read_bytes())
    (t/'policy.json').write_text(json.dumps(policy,indent=2)+'\n')
    for item in t.iterdir():os.chmod(item,0o600)
    # Atomic replacements. All three are known files/paths; do not overwrite receiver.
    import shutil
    old_driver=(dst/'driver.py').read_bytes()
    old_web=(dst/'web.py').read_bytes() if (dst/'web.py').exists() else None
    old_policy=policy_path.read_bytes()
    try:
        os.replace(t/'web.py',dst/'web.py')
        os.chmod(dst/'web.py',0o644)
        os.replace(t/'driver.py',dst/'driver.py')
        os.chmod(dst/'driver.py',0o644)
        os.replace(t/'policy.json',policy_path)
        os.chmod(policy_path,0o600)
    except BaseException:
        (dst/'driver.py').write_bytes(old_driver)
        if old_web is None:(dst/'web.py').unlink(missing_ok=True)
        else:(dst/'web.py').write_bytes(old_web)
        policy_path.write_bytes(old_policy)
        raise
PY
echo "Autorização do painel-web instalada. Nenhum container foi reiniciado."
echo "Agora inicie Actions > Deploy Panel web staging to VPS (GHCR), após conferir a branch main."
