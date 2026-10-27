#!/usr/bin/env bash
# Isolated VPS smoke test. Requires the existing panel executor and apps network.
# Creates only two uniquely named temporary containers and removes them on exit.
set -euo pipefail

app=softload-app-codex-wake-test
gateway=panel-wake-codex-smoke
image=softload-panel-app-wake:codex-smoke
node_image=softload-panel-api:inventory-720971c
network=softload_panel_apps
socket_volume=softload_panel_executor_socket

for name in "$app" "$gateway"; do
  if docker container inspect "$name" >/dev/null 2>&1; then
    echo "Refusing to reuse an existing container: $name" >&2
    exit 2
  fi
done
docker network inspect "$network" >/dev/null
docker volume inspect "$socket_volume" >/dev/null
docker image inspect "$node_image" >/dev/null

workdir="$(mktemp -d /tmp/panel-wake-smoke.XXXXXX)"
cleanup() {
  docker container rm -f "$gateway" "$app" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
  rm -f -- "$workdir/routes.json"
  rmdir -- "$workdir" 2>/dev/null || true
}
trap cleanup EXIT
printf '%s\n' '[{"slug":"codex-wake-test","host":"codex-wake-test.apps.analysepro.com","port":3000}]' > "$workdir/routes.json"

docker build --quiet -f app-wake.Dockerfile -t "$image" . >/dev/null
docker container create --name "$app" --network "$network" \
  --label com.softload.panel.managed=true \
  --label com.softload.panel.slug=codex-wake-test \
  --memory 64m --cpus 0.25 --pids-limit 64 --read-only \
  --security-opt no-new-privileges --cap-drop ALL --user 65534:65534 \
  --health-cmd 'wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1' \
  --health-interval 1s --health-timeout 2s --health-retries 20 \
  "$node_image" node -e 'require("http").createServer((_req,res)=>res.end("wake-ok")).listen(3000)' >/dev/null

docker container run -d --name "$gateway" --network "$network" \
  --mount "type=bind,source=$workdir/routes.json,target=/config/panel/domain-routes.json,readonly" \
  --mount "type=volume,source=$socket_volume,target=/run/panel-executor,readonly" \
  --memory 96m --cpus 0.25 --pids-limit 64 --read-only \
  --security-opt no-new-privileges --cap-drop ALL \
  --health-cmd "node -e \"require('http').get('http://127.0.0.1:8082/__wake_health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\"" \
  --health-interval 1s --health-timeout 2s --health-retries 20 \
  "$image" >/dev/null

for _ in $(seq 1 30); do
  if [[ "$(docker inspect -f '{{.State.Health.Status}}' "$gateway")" == healthy ]]; then break; fi
  sleep 1
done
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$gateway")" == healthy ]]
[[ "$(docker inspect -f '{{.State.Running}}' "$app")" == false ]]

docker container run --rm --network "$network" --memory 64m --cpus 0.25 \
  "$node_image" node -e '
    require("http").get({host:"panel-wake-codex-smoke",port:8082,path:"/",
      headers:{host:"codex-wake-test.apps.analysepro.com"}},response=>{
        let body="";response.on("data",part=>body+=part);
        response.on("end",()=>{
          if(response.statusCode!==200||body!=="wake-ok")process.exit(1);
          console.log("PASS: first request woke the app and returned HTTP 200");
        });
      }).on("error",error=>{console.error(error.message);process.exit(1)});
  '
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$app")" == healthy ]]
echo 'PASS: temporary app is healthy; cleanup follows automatically'
