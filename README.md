# Softload Console — Painel da VPS

Painel: https://softload-vps-panel.pages.dev

## Arquitetura atual

Cloudflare Pages -> Function TypeScript -> Cloudflare Access -> Cloudflare Tunnel -> API privada da VPS -> Docker.

A API mantém senha administrativa com scrypt, sessão em cookie HttpOnly/Secure/SameSite=Strict e segredo de borda. A interface consulta seis containers existentes, uso da máquina, imagens e logs. Apenas App, Agent, Sandbox e Embeddings podem ser iniciados, parados ou reiniciados; Caddy e Portainer são somente leitura.

## Nova integração GitHub

Na aba **Deploys**, você pode conectar repositórios, escolher uma branch e um workflow YAML, acompanhar as últimas execuções, solicitar um deploy manual e desconectar o projeto sem apagar containers.

| Método | Endpoint | Descrição |
|---|---|---|
| GET | /repositories | Listar conexões (nunca retorna token) |
| POST | /repositories | Validar repositório, branch e workflow; conectar |
| DELETE | /repositories/:owner/:repo | Desconectar |
| GET | /repositories/:owner/:repo/runs | Consultar execuções |
| POST | /repositories/:owner/:repo/deploy | Disparar workflow_dispatch |

O repositório Softdown-prog/Softloadv4 já aparece como opção inicial; seu deploy.yml aceita push em main e workflow_dispatch. O painel **não cria automaticamente o workflow e não faz deploy de projetos genéricos sem pipeline previamente configurado**. Para publicar a cada commit, o workflow precisa também estar configurado para push na branch.

### Ativar na VPS

Crie um fine-grained personal access token no GitHub para os repositórios escolhidos, com Actions: Read and write, Contents: Read-only e Metadata: Read. Para uso por várias pessoas, no futuro usaremos uma GitHub App.

Execute os comandos abaixo com acesso administrativo à VPS:

    sudo install -d -m 700 /etc/softload-panel
    read -r -s -p 'Token GitHub: ' GITHUB_TOKEN; printf '\n'
    printf '%s' "$GITHUB_TOKEN" | sudo tee /etc/softload-panel/github-token >/dev/null
    unset GITHUB_TOKEN
    sudo chmod 600 /etc/softload-panel/github-token
    cd /caminho/real/do/Painel/server
    docker compose -f compose.yaml -f compose.github.yaml up -d --build api

Troque o caminho do repositório pelo caminho real da instalação. O arquivo do token é montado somente no container de API em /run/secrets/github-token; ele não é enviado ao navegador, à Cloudflare Pages ou ao GitHub. Não adicione o token a nenhum commit.

Por padrão, o único proprietário de repositórios aceito é Softdown-prog. Isso pode ser ajustado pela variável PANEL_GITHUB_ALLOWED_OWNER no Compose do servidor. Se não houver token instalado, o painel mantém leitura pública de workflows e desativa as ações de conexão e deploy.

## Migração TypeScript

A migração é incremental para preservar a operação da VPS:

- server/github.ts: novo backend GitHub com validação e tipos.
- functions/api/[[path]].ts: Cloudflare Pages Function migrada de JS para TS.
- github-ui.ts: implementação TypeScript dos novos controles; github-ui.js é o arquivo gerado e versionado para funcionar no deploy estático atual.
- server/api.mjs e script.js: legado existente, ainda pendente de migração em uma etapa futura.

Com Node 24 e npm, na raiz do repositório:

    npm install
    npm run typecheck
    npm test
    npm run check:js
    npm run build:frontend

A CI em .github/workflows/ci.yml verifica tipos, testes, sintaxe JavaScript e build. Para executar somente o teste do backend: cd server && npm test. O container de produção está em Node 24, que suporta a importação do módulo TypeScript com remoção de tipos em runtime.

## Segurança e limitações

- O painel ainda reconhece containers existentes por nome fixo; provisionamento de novos aplicativos, portas, domínios, variáveis, volumes e rollback ainda **não foram implementados**.
- Mesmo com o arquivo docker.sock montado como read-only, a API Docker permite operações de escrita. O código atual limita ações, mas antes de disponibilizar o painel a outros usuários é importante isolar o controle Docker atrás de um agente com permissões mínimas.
- Evite reutilizar credenciais SSH root ou chaves de produção entre repositórios; exija CI e proteção da branch para produção.
- A aceitação HTTP 204 do GitHub confirma somente que o pedido de execução foi recebido, **não** que o deploy terminou com sucesso.
- Os segredos e sessões persistidas ficam em /etc/softload-panel e no volume softload_panel_data, fora do Git.

## Próximas etapas

1. Migrar server/api.mjs e script.js para TypeScript com testes de regressão.
2. Criar catálogo de aplicações e um agente restrito para provisionar, atualizar, parar, remover e fazer rollback de containers sem oferecer shell livre.
3. Permitir configurar domínio, portas, variáveis, volumes, healthcheck e limites de recursos.
4. Instalar workflows por template e conectar GitHub por GitHub App em vez de token manual.

Fluxo de produto pretendido: **Conectar repositório -> Configurar aplicação -> Validar -> Deploy -> Logs e rollback**.
