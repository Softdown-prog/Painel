# Softload Console — Painel da VPS

Painel: https://softload-vps-panel.pages.dev

Cada push na `main` executa `.github/workflows/deploy-pages.yml`: testes, build do frontend e publicação no projeto Cloudflare Pages `softload-vps-panel`. O workflow usa um token exclusivo `Pages Write` armazenado em `CLOUDFLARE_API_TOKEN` nos segredos GitHub. `CLOUDFLARE_ACCOUNT_ID` está no mesmo local. As credenciais da API privada da VPS permanecem nos segredos do Cloudflare Pages.

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

- Os seis serviços originais permanecem identificados por nome fixo. A aba Aplicações já permite criar e controlar containers gerenciados separadamente; ainda faltam portas, domínios, variáveis, volumes persistentes, publicação de revisões e rollback.
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


## Aplicações Docker (primeira etapa)

A nova aba **Aplicações** administra containers **criados pelo próprio painel**, independentemente dos seis serviços preexistentes. Todos os endpoints continuam exigindo a sessão administrativa e a proteção da Cloudflare. As operações permanecem **desabilitadas por padrão**.

| Método | Rota | Função |
|---|---|---|
| GET | /apps | Listar aplicações próprias e imagens permitidas |
| POST | /apps | Criar um container parado a partir de imagem já instalada |
| GET | /apps/:slug | Consultar imagem e estado |
| POST | /apps/:slug/start | Iniciar |
| POST | /apps/:slug/stop | Parar |
| POST | /apps/:slug/restart | Reiniciar |
| GET | /apps/:slug/logs | Consultar últimas 100 linhas |
| DELETE | /apps/:slug | Remover apenas container parado |

O Docker nomeia containers com o prefixo softload-app- e labels de propriedade. O painel valida **nome e labels** antes de executar comandos, impedindo operações acidentais nos containers da Softload. Nomes de aplicação só aceitam letras minúsculas, números e hífens, de 2 a 40 caracteres.

Limites iniciais, fixos no backend: máximo de **8 aplicações**, **256 MiB de RAM**, **0,5 CPU** e **64 processos** por aplicação. Containers são criados sob UID/GID 65534, sem capacidades Linux, com no-new-privileges, sistema de arquivos somente leitura e /tmp temporário limitado a 16 MiB. Não são permitidas montagens de volumes, modo privileged ou publicação de portas. A rede é a bridge padrão. **Não há domínio público, deploy de GitHub para essas aplicações, persistência nem rollback nesta etapa.** Algumas imagens não conseguem executar com essas restrições; escolha imagens compatíveis.

### Habilitar experimentalmente

O overlay opt-in está em server/compose.apps.yaml. Na VPS, a partir da pasta server:

    docker image ls
    export PANEL_APPS_ENABLED=1
    export PANEL_APPS_ALLOWED_IMAGES='imagem-existente:versao'
    docker compose -f compose.yaml -f compose.apps.yaml up -d --build api

Substitua imagem-existente:versao por uma tag **real já instalada**, revisada e compatível com execução como usuário não privilegiado. **Não execute esse passo sem conferir a imagem e sua origem.** Se também usar GitHub, inclua compose.github.yaml no mesmo comando. Para desabilitar novamente, use PANEL_APPS_ENABLED=0 e recrie somente o serviço api. Desabilitar novas operações não apaga containers que já foram criados.

As APIs dessa etapa estão em server/apps.ts, com testes em server/apps.test.mjs. A nova tela usa apps-ui.ts e o correspondente apps-ui.js servido pelo Cloudflare Pages.

### Aviso sobre o Docker socket

Um processo com acesso ao Docker socket possui poderes administrativos efetivos sobre o host, **mesmo quando o socket é montado com :ro**. As validações acima protegem as rotas publicadas, mas não protegem contra comprometimento do próprio processo da API. **Não exponha esta interface a usuários não confiáveis.** Para uma versão multiusuário será necessário um agente isolado ou um proxy de API Docker com permissões estritas e auditoria antes de permitir provisionamento de aplicações.

Próximos passos: integrar builds e imagens produzidas pelo GitHub Actions, organizar o catálogo de projetos, configuração segura de domínios/portas/variáveis e rollback, e concluir a migração de server/api.mjs e script.js para TypeScript.

## Projetos: GitHub + aplicações Docker (segunda etapa)

A aba **Projetos** reúne a conexão GitHub (aba Deploys) com uma aplicação já criada na aba Aplicações. Os dados do vínculo são armazenados no volume protegido da API em `projects.json`, sem credenciais.

### Fluxo disponível

1. Conecte o repositório pela aba Deploys. Configure seu workflow como `panel-app-build.yml`.
2. No repositório da aplicação, copie o conteúdo de `templates/panel-app-build.yml` para `.github/workflows/panel-app-build.yml`. O repositório da aplicação precisa ter um `Dockerfile` válido e habilitar gravação de pacotes no GitHub Actions.
3. Crie uma aplicação na aba Aplicações usando uma imagem local permitida (com a funcionalidade de aplicações habilitada).
4. Na aba Projetos, associe essa aplicação ao repositório GitHub. A vinculação exige que a API confirme que o container foi criado pelo painel, verificando o nome e as labels de propriedade.
5. Consulte os builds ou execute manualmente o workflow após habilitar `PANEL_PROJECT_BUILDS_ENABLED=1`.

O workflow de exemplo compila e publica uma imagem com tag vinculada ao SHA do commit, em `ghcr.io/owner/repository:sha-<commit>`. **Ele não faz deploy, pull ou troca de containers na VPS.** A publicação na VPS e o rollback continuam pendentes da implantação de um agente restrito e de um mecanismo de troca controlada.

### API

| Método | Endpoint | Descrição |
| --- | --- | --- |
| GET | /projects | Listar vínculos, branch, workflow e permissão de build |
| POST | /projects | Associar `slug` de app existente e `repository` já conectado |
| DELETE | /projects/:slug | Desvincular sem apagar aplicação |
| GET | /projects/:slug/runs | Histórico do workflow de build |
| POST | /projects/:slug/build | Solicitar `workflow_dispatch` do workflow dedicado de build |

Somente o arquivo com nome exato `panel-app-build.yml` pode ser acionado pela rota de build, para impedir que um botão dessa área dispare o deploy principal da Softload V4. O comando de build é desligado por padrão.

Para habilitar explicitamente na VPS, inclua o overlay `server/compose.projects.yaml` junto aos overlays de GitHub e Aplicações:

    export PANEL_PROJECT_BUILDS_ENABLED=1
    docker compose -f compose.yaml -f compose.github.yaml -f compose.apps.yaml -f compose.projects.yaml up -d --build api

Esse comando requer que as variáveis e o arquivo do token GitHub já tenham sido configurados conforme os passos acima. Use `PANEL_PROJECT_BUILDS_ENABLED=0` para desligar novamente. Uma execução aceita pelo GitHub não significa que o build finalizou ou que o container foi atualizado.

### Pendências antes do deploy automático completo

- Validar a origem e o digest imutável da imagem publicada no GHCR, com credenciais de leitura restritas ao pacote.
- Fazer `pull` em uma zona restrita, verificar saúde, trocar o container gerenciado e reter a imagem anterior para rollback.
- Permitir configuração segura e auditável de domínio, porta, variáveis e volumes, sem permitir acesso a containers de produção não gerenciados.
- Migrar o código legado de `server/api.mjs` e `script.js` para TypeScript; nessa etapa o módulo `server/projects.ts` e a interface `projects-ui.ts` já foram escritos em TypeScript.
