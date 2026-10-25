# Softload Console

Painel administrativo da VPS Softload: https://softload-vps-panel.pages.dev

## Arquitetura

- Interface estática e `functions/api/[[path]].js` no Cloudflare Pages.
- Cloudflare Access exige um service token exclusivo da Pages Function para `panel-api.analysepro.com`.
- Cloudflare Tunnel encaminha a chamada ao container `softload-panel-api` na rede Docker `softload_proxy`. O conector também valida o JWT do Access.
- A API exige um segundo segredo de borda e uma sessão de administrador. O navegador recebe apenas um cookie `HttpOnly`, `Secure`, `SameSite=Strict`.
- Nenhuma porta do painel ou do Docker é publicada na VPS. Caddy e a aplicação Softload não foram alterados para a integração.

## Controles disponíveis

- Estado dos seis containers, memória, carga, imagens Docker e revisão em execução.
- Logs dos containers.
- Iniciar, parar e reiniciar somente App, Agent, Sandbox e Embeddings, com confirmação no navegador. Caddy e Portainer são somente leitura.
- Consultar as execuções do workflow de deploy do repositório Softloadv4 e abrir o GitHub Actions.
- Trocar a senha administrativa; a troca encerra todas as sessões.

O acionamento de deploy pelo painel depende de uma credencial GitHub exclusiva e restrita ao workflow. Até ela existir, os deploys seguem pelo GitHub Actions já configurado. A API não oferece shell, edição livre de Docker Compose ou acesso a segredos.

## Código e segredos

`server/` contém a API e os Compose separados para API e Tunnel. O código está versionado; segredos e dados de login ficam fora do Git, em `/etc/softload-panel` e no volume `softload_panel_data` da VPS. `.secrets/`, caches e `dist/` são ignorados pelo Git. O service token do Access expira em um ano e deverá ser renovado antes disso.

## Desenvolvimento local

Abra `index.html` para visualizar a interface. Para testar a API sem Docker, execute `node --test server/api.test.mjs` com Node.js 22 ou posterior.
