#!/usr/bin/env bash
# Safe, read-only diagnostics for staging the VPS-hosted panel frontend.
set -euo pipefail
command -v docker >/dev/null || { echo "ERRO: docker indisponível"; exit 2; }
echo "PAINEL VPS — verificação de migração (somente leitura)"
echo "Rede administrativa:"
if docker network inspect vps_panel_control >/dev/null 2>&1; then
  echo "  vps_panel_control: presente"
else
  echo "  vps_panel_control: ausente"
fi
echo "Serviços de administração:"
for name in softload-panel-api softload-panel-executor softload-panel-tunnel softload-panel-web; do
  if ! docker container inspect "$name" >/dev/null 2>&1; then
    echo "  $name: não instalado"
    continue
  fi
  state="$(docker inspect -f '{{.State.Status}}' "$name")"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}sem healthcheck{{end}}' "$name")"
  echo "  $name: $state ($health)"
done

if docker container inspect softload-panel-web >/dev/null 2>&1; then
  echo "Frontend privado:"
  docker inspect -f '  imagem: {{.Config.Image}}' softload-panel-web
  docker inspect -f '  rede(s): {{range $n,$v := .NetworkSettings.Networks}}{{$n}} {{end}}' softload-panel-web
  docker inspect -f '  porta(s) publicadas: {{if .HostConfig.PortBindings}}{{json .HostConfig.PortBindings}}{{else}}nenhuma{{end}}' softload-panel-web
  if [[ "$(docker inspect -f '{{.State.Running}}' softload-panel-web)" == true ]]; then
    if docker exec softload-panel-web node -e '
      (async()=>{
        const base="http://127.0.0.1:8081";
        const [h,r]=await Promise.all([fetch(base+"/__panel_web_health"),fetch(base+"/api/session")]);
        const health=await h.json(), session=await r.json();
        if(!h.ok||!r.ok||!health.ok||typeof session.authenticated!=="boolean")
          throw Error("Frontend/API sem resposta válida");
        console.log("  frontend: OK; API /session: OK; revisão:",health.revision);
      })().catch(()=>process.exit(1))
    '; then :; else
      echo "  frontend/API interna: falha ou indisponível"
    fi
  fi
fi

echo "Proxies Caddy ativos e suas redes (sem alterar configuração):"
while IFS= read -r container; do
  [[ -n "$container" ]] || continue
  image="$(docker inspect -f '{{.Config.Image}}' "$container")"
  if [[ "$container" == *caddy* || "$image" == *caddy* ]]; then
    networks="$(docker inspect -f '{{range $n,$v := .NetworkSettings.Networks}}{{$n}} {{end}}' "$container")"
    echo "  $container: $networks"
  fi
done < <(docker ps --format '{{.Names}}')
echo "Próximo passo: conferir o acesso HTTPS e um caminho de reversão independente antes de trocar o domínio."
