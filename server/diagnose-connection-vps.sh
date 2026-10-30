#!/usr/bin/env bash
# Read-only. No restart, rebuild, configuration write, password or token output.
set -uo pipefail
connection_dir="$(cd "$(dirname "$0")" && pwd)"
command -v docker >/dev/null || { echo 'FAIL: Docker não está disponível neste console.'; exit 2; }
command -v python3 >/dev/null || { echo 'FAIL: Python 3 não está disponível neste console.'; exit 2; }
docker info >/dev/null 2>&1 || { echo 'FAIL: Este console não tem acesso ao Docker da VPS.'; exit 2; }
connection_failed=0
for name in softload-panel-api softload-panel-executor softload-panel-tunnel; do
  if ! docker inspect --format '{{.Name}}: {{.State.Status}}{{if .State.Health}} / {{.State.Health.Status}}{{end}}' "$name" 2>/dev/null; then
    echo "FAIL: Container $name não encontrado."; connection_failed=1
  fi
done
echo '1. Consulta HTTP dentro da API, com a chave privada mantida no servidor:'
docker exec -i softload-panel-api node --input-type=module - --check-panel-connection < "$connection_dir/check-api-connection.mjs" || connection_failed=1
echo '2. Consulta pelo nome usado no canal interno:'
docker exec -i softload-panel-api node --input-type=module - --check-panel-connection --network < "$connection_dir/check-api-connection.mjs" || connection_failed=1
echo '3. Rede compartilhada entre API e túnel:'
docker inspect --format '{{json .NetworkSettings.Networks}}' softload-panel-api softload-panel-tunnel 2>/dev/null | python3 -c '
import json,sys
try:
    networks=[json.loads(line) for line in sys.stdin if line.strip()]
    assert len(networks)==2
    shared=set(networks[0]) & set(networks[1])
    if not shared: raise ValueError()
    print("PASS: API e túnel compartilham rede Docker.")
except Exception:
    print("FAIL: Não foi confirmada uma rede compartilhada entre API e túnel.")
    sys.exit(1)
' || connection_failed=1
echo '4. Consulta pública do painel, sem senha nem sessão administrativa:'
python3 -c '
import json,sys,urllib.request,urllib.error
try:
    req=urllib.request.Request("https://panel.analysepro.com/api/session",headers={"Accept":"application/json"})
    with urllib.request.urlopen(req,timeout=12) as response:
        data=json.loads(response.read(16385))
        assert response.status==200 and isinstance(data.get("authenticated"),bool) and isinstance(data.get("setupRequired"),bool)
    print("PASS: O endereço público alcançou a API e confirmou o formato da sessão.")
except urllib.error.HTTPError as error:
    print("FAIL: O endereço público respondeu HTTP "+str(error.code)+". Confira o túnel e a autorização privada no Cloudflare.")
    sys.exit(1)
except Exception:
    print("FAIL: A consulta pública não confirmou a conexão com a API.")
    sys.exit(1)
' || connection_failed=1
echo 'Diagnóstico concluído. Nenhum serviço foi alterado e nenhuma credencial foi exibida.'
exit "$connection_failed"
