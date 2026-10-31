#!/usr/bin/env bash
# CI-only integration test: isolated fake API plus real panel-web image.
set -euo pipefail
command -v docker >/dev/null || exit 2
[[ -n "$GITHUB_SHA" ]] || { echo "Full commit SHA required"; exit 2; }
image_name=vps-panel-web:test
suffix="$(printf '%s' "$GITHUB_SHA" | cut -c1-12)"
net="panel-web-smoke-$suffix"
api="panel-web-fake-api-$suffix"
web="panel-web-proxy-$suffix"
secret="$(mktemp)"
cleanup() {
  docker rm -f "$web" "$api" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  sudo rm -f "$secret"
}
trap cleanup EXIT
printf '%s\n' 'github-smoke-test-secret-at-least-32-characters' >"$secret"
sudo chown root:root "$secret"
sudo chmod 600 "$secret"
docker network create "$net" >/dev/null
docker run -d --name "$api" --network "$net" --network-alias softload-panel-api \
  -e SMOKE_KEY='github-smoke-test-secret-at-least-32-characters' \
  node:24-alpine node -e '
    const http=require("node:http");
    http.createServer((req,res)=>{
      if(req.headers["x-panel-edge-key"]!==process.env.SMOKE_KEY){res.writeHead(404);return res.end();}
      res.setHeader("content-type","application/json");
      if(req.url==="/login"){
        res.setHeader("set-cookie","panel_session=smoketest; Path=/api; HttpOnly; Secure; SameSite=Strict");
        return res.end(JSON.stringify({ok:true}));
      }
      return res.end(JSON.stringify({authenticated:false,setupRequired:false}));
    }).listen(8080,"0.0.0.0");
  ' >/dev/null
docker run -d --name "$web" --network "$net" --read-only \
  --cap-drop ALL --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges \
  --mount "type=bind,src=$secret,dst=/run/secrets/panel-edge-key,readonly" \
  -e PANEL_PUBLIC_ORIGIN=https://panel-staging.example.test \
  -e PANEL_WEB_REVISION="$GITHUB_SHA" "$image_name" >/dev/null

docker exec "$web" node -e '
  (async()=>{
    let r;
    for(let i=0;i<25;i++){
      try {
        r=await fetch("http://127.0.0.1:8081/api/session");
        if(r.status===200)break;
      }catch{}
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    if(!r||r.status!==200)throw Error("Internal API was not reachable");
    const session=await r.json();
    if(typeof session.authenticated!=="boolean")throw Error("Session response invalid");
    const login=await fetch("http://127.0.0.1:8081/api/login",{
      method:"POST",headers:{origin:"https://panel-staging.example.test",
      "content-type":"application/json","x-panel-edge-key":"user-injected"},body:"{}"
    });
    if(login.status!==200 || !login.headers.get("set-cookie")?.startsWith("panel_session="))
      throw Error("Login proxy/cookie invalid");
    const forbidden=await fetch("http://127.0.0.1:8081/api/login",{
      method:"POST",headers:{origin:"https://attacker.test"},body:"{}"
    });
    if(forbidden.status!==403)throw Error("Origin verification failed");
    const health=await fetch("http://127.0.0.1:8081/__panel_web_health");
    if((await health.json()).revision!==process.env.PANEL_WEB_REVISION)
      throw Error("Pinned SHA mismatch");
    console.log("PASS: pinned web image, private API, session cookie and origin protection");
  })().catch(e=>{console.error(e);process.exit(1)})
'
