# Migração do frontend Cloudflare Pages para a VPS — estágio seguro

## Situação desta etapa

O repositório agora possui um **segundo caminho de publicação opcional** para o frontend. Ele não substitui o Pages nem o domínio atual automaticamente.

- Frontend: `web/Dockerfile` compila TypeScript em uma imagem estática Node 24.
- Entrada HTTP: `web/server.mjs` entrega somente `index.html`, `.js`, `.css`; atende `/api/*` pela rede Docker privada e injeta `x-panel-edge-key` lendo a **chave existente da API** em arquivo privado.
- Instalação isolada: `server/compose.web.yaml`, serviço `panel-web`, rede `vps_panel_control`, sem porta publicada, sem Docker socket e sem volumes de outros projetos. Um processo root lê o arquivo secreto e passa imediatamente ao usuário `node`, com capabilities estritamente necessárias para a queda de privilégios.
- O frontend usa sua API original, sem token de Cloudflare Pages, Functions ou nova senha de banco. Os demais containers e projetos não são alterados nesta etapa.

**Não há deploy automático da VPS.** O GitHub CI faz testes e build da imagem, mas não possui um agente autorizado para instalar ou reiniciar containers no host. A função Pages e o workflow `deploy-pages.yml` permanecem ativos até o corte de tráfego confirmado.

## Plano de migração

1. Conferir instalação real: rede `vps_panel_control`, `softload-panel-api` em execução, segredo `/etc/softload-panel/edge-key`, configuração vigente do Caddy compartilhado e mecanismos de acesso de emergência. Nada deve ser alterado se só existe acesso pelo próprio painel.
2. Validar CI do PR, gerar uma revisão SHA completa e **preparar somente `panel-web`**, sem trocar DNS, Tunnel, Caddy, containers existentes ou Pages.
3. Testar internamente a interface e `/api/session`, e testar um endereço externo **de staging** via HTTPS e controle de acesso antes de migrar o domínio. Configurar `PANEL_PUBLIC_ORIGIN` com a origem HTTPS efetiva, já que requisições mutáveis exigem `Origin` idêntica.
4. Revisar o Caddy de produção e sua rede (Caddy pode estar em `softload_proxy`, enquanto o painel está em `vps_panel_control`). **Não presumir** que o Caddy já resolve `softload-panel-web`; não dar acesso à rede administrativa a serviços de clientes.
5. Antes de expor a interface direta, colocar barreira equivalente de segurança no HTTPS (identidade/VPN/mTLS ou restrição forte de IP) além da senha administrativa. O Cloudflare Access fazia parte da proteção anterior: sua retirada não pode deixar terminal e Docker simplesmente acessíveis a qualquer visitante.
6. Validar todas as abas e ações, cookies `Secure; HttpOnly; SameSite=Strict; Path=/api`, logs, rollback de frontend, o Android, e as rotas de outras aplicações. Preparar troca reversível da rota, com rollback ao Pages.
7. **Só depois** apontar `panel.analysepro.com` para a entrada VPS e desativar `deploy-pages.yml`/Pages. Não remover o túnel privado `panel-api.analysepro.com` se outros fluxos ainda dependem dele. Não excluir segredos nem projeto Pages antes da comprovação.

## Preparar uma revisão sem afetar outros containers

Execute em um **canal administrativo independente**, com operador autorizado na VPS. O script não altera o Caddy, DNS, Pages nem API/executor. O SHA deve ser uma revisão publicada no GitHub com 40 caracteres hexadecimais.

```bash
PANEL_PUBLIC_ORIGIN=https://panel-staging.analysepro.com \
  bash web/deploy-staging-vps.sh <SHA40>
```

O hostname acima é **exemplo**, não implica DNS ou staging existente. O script baixa o commit fixo do GitHub no diretório `/opt/vps-panel/web-releases/<SHA40>`, compila a imagem, aplica `docker compose -f compose.yaml -f compose.web.yaml up -d --no-deps --no-build panel-web`, verifica container healthy e testa internamente `GET /` e `GET /api/session`. Não acessa shell dentro de outros containers, não altera volumes, não faz `prune` e não cria backups de dados.

O projeto Compose é `softload-panel`. O serviço usa a rede administrativa **já existente**; se ela estiver ausente, o script interrompe sem recriá-la. Configurações e segredos dos outros serviços permanecem sob os overlays de produção atuais. Para executar a partir de outro checkout, use o caminho correto para o script.

## Expor o staging e trocar o domínio depois

A entrada externa continua dependendo de uma configuração confiável de HTTPS. Se o Caddy existente compartilhar uma rede privada **explicitamente autorizada** com `panel-web`, a ideia da rota é:

```caddyfile
# Trecho conceitual — não copiar sem verificar o Caddy e suas rotas atuais
panel.analysepro.com {
    encode zstd gzip
    reverse_proxy softload-panel-web:8081
}
```

Antes de aplicar, verifique como TLS, DNS, portas 80/443, outros sites e redes existentes estão gerenciados; pode ser necessária outra topologia. A instância de Caddy de produção **não é modificada por este PR**.

### Como reverter

Enquanto o Pages for a rota principal, rollback consiste em deixar a rota/DNS existente intactos. Durante cutover, restaure a rota anterior testada para Pages e confirme o funcionamento público; a revisão anterior do `panel-web` pode ser reconstruída pelo SHA fixo. A configuração não mexe no banco, Docker executor nem nos containers dos outros projetos.

## Testes e evidências

`npm run typecheck`, `npm test`, `npm run build:frontend`, `npm run check:js`, `docker compose -f server/compose.yaml -f server/compose.web.yaml config --quiet` e `docker build -f web/Dockerfile --build-arg PANEL_WEB_REVISION=<SHA40> -t vps-panel-web:test .`.

Testes `web/server.test.mjs` cobrem estáticos, acesso a arquivos proibidos, privacidade do segredo, `Origin` de POST/DELETE, cookie da sessão, rota /api, rejeição de métodos e saúde local. O CI também verifica que não há portas publicadas nem montagem do socket Docker.

**Separar estados no relato:** código pronto; CI aprovado; imagem testada no CI; frontend instalado na VPS; rota HTTPS pública validada; Pages desligado. Os quatro últimos nunca são inferidos apenas de CI verde.
