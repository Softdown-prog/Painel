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
         "$source_dir/operations/codex.py" "$source_dir/operations/install_codex.py" \
         "$source_dir/operations/admission.py" "$source_dir/operations/policy.example.json" \
         /usr/local/libexec/vps-operations /etc/sudoers.d/vps-operations; do
  [[ -f "$f" ]] || { echo "Arquivo esperado ausente: $f" >&2; exit 2; }
  [[ ! -L "$f" ]] || { echo "Caminho simbólico não autorizado: $f" >&2; exit 2; }
done
grep -Fq 'admission = admit(project, sha, images)' "$installed/driver.py" || {
  echo "Barreira de admissão ausente; não é seguro instalar o novo adaptador." >&2; exit 2;
}
grep -Fq '/usr/local/libexec/vps-operations' /etc/sudoers.d/vps-operations || {
  echo "Executor vpsops divergente; nada foi modificado." >&2; exit 2;
}
python3 - "$source_dir" <<'PY'
import ast,pathlib,sys
folder=pathlib.Path(sys.argv[1])/'operations'
for name in ('codex.py','driver.py','admission.py'):
    ast.parse((folder/name).read_text(),filename=name)
PY
python3 "$source_dir/operations/install_codex.py" "$source_dir"
echo 'Política vpsops atualizada somente para panel-codex. Nenhum container foi reiniciado.'
echo 'Após conferir o Compose real, use o workflow stage-codex-bridge.yml (ativação explícita).'
