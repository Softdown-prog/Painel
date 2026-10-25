# Softload Console — Painel da VPS

Painel: https://panel.analysepro.com (alternativo: https://softload-vps-panel.pages.dev)

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

- Os seis serviços originais continuam identificados por nome fixo. A aba Aplicações já permite criar containers separadamente; o fluxo experimental de releases, importação GHCR por digest e rollback manual está implementado. Faltam portas, domínios, volumes persistentes, alta disponibilidade e isolamento do Docker socket.
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
| POST | /apps/:slug/resources | Ajustar RAM e CPU do container próprio |
| POST | /apps/:slug/idle | Ativar ou desativar parada por ociosidade |
| GET | /apps/:slug/logs | Consultar últimas 100 linhas |
| DELETE | /apps/:slug | Remover apenas container parado |

O Docker nomeia containers com o prefixo softload-app- e labels de propriedade. O painel valida **nome e labels** antes de executar comandos, impedindo operações acidentais nos containers da Softload. Nomes de aplicação só aceitam letras minúsculas, números e hífens, de 2 a 40 caracteres.

São permitidas até **8 aplicações**. Cada uma pode usar 128, 256, 512, 768 ou 1024 MiB de RAM e 0,25, 0,5, 1 ou 2 vCPU; o padrão é 256 MiB e 0,5 vCPU. Os limites são aplicados pelo Docker na criação ou ao clicar em Salvar limites. Os 64 processos, UID/GID 65534, ausência de capacidades Linux, no-new-privileges, sistema de arquivos somente leitura e /tmp temporário de 16 MiB permanecem fixos. A tela mostra o espaço total/usado/livre do filesystem da VPS e os bytes gravados na camada de cada container gerenciado. Esses bytes não incluem volumes externos. Não há cota portátil de disco por container neste servidor.

A parada por ociosidade é opcional por aplicação, com 15 a 240 minutos. O monitor observa tráfego de rede e uso de CPU a cada minuto; após o tempo escolhido sem atividade, para somente o container gerenciado selecionado. **O reinício é manual pelo botão Iniciar**: ainda não há rota pública por aplicação capaz de acordá-la na próxima requisição. Serviços centrais da Softload, Caddy, Portainer e o painel não entram nesse monitor. A configuração fica no volume privado `softload_panel_data`. Sem `PANEL_APPS_ENABLED=1`, o monitor e os controles de aplicação permanecem desativados.

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

## Publicação de revisões e rollback (terceira etapa)

A aba **Projetos** agora tem preparação de versão, promoção para o nome principal, restauração e descarte de container reserva. O código está em `server/releases.ts` e os testes simulados em `server/releases.test.mjs`. São gerenciados **exclusivamente** containers criados pelo Painel, com labels do proprietário e slug. A publicação **não** altera os seis containers fixos da Softload.

### Requisitos para preparar uma release

- O projeto precisa estar vinculado a um repositório cadastrado com `panel-app-build.yml`.
- O build informado precisa ter **conclusão bem-sucedida**, ter sido executado na branch autorizada, no repositório correto e no workflow dedicado.
- A imagem precisa ser importada pelo fluxo GHCR por digest, com registro da revisão aprovada e digest SHA-256. A preparação recusa imagens sem esse registro (veja a seção seguinte).
- O Docker inspeciona a imagem local, confere o ID imutável `sha256`, a tag, as labels OCI `org.opencontainers.image.source` e `org.opencontainers.image.revision`, além de exigir um `HEALTHCHECK` declarado na imagem.
- É necessário que o container principal esteja em execução. A candidata é criada com as mesmas restrições de CPU, RAM, capacidades e filesystem da aba Aplicações, sem montar volumes ou expor portas.

### Controles e API

| Método | Endpoint | Ação |
|---|---|---|
| GET | `/projects/:slug/releases` | Consultar ativa, candidata e backup; modo habilitado |
| POST | `/projects/:slug/releases/stage` | Recebe JSON `{ "runId": 123 }`, verifica origem e inicia candidata |
| POST | `/projects/:slug/releases/promote` | Exige candidata saudável; para o container atual e o renomeia como backup, promovendo a candidata |
| POST | `/projects/:slug/releases/rollback` | Para a nova versão, restaura e inicia o backup anterior |
| POST | `/projects/:slug/releases/finalize` | Recebe `{ "confirm": "DELETE_BACKUP" }`, descarta explicitamente backup ou candidata parada |

O nome da candidata é `softload-candidate-<slug>` e o backup recebe `softload-backup-<slug>`. Não é possível iniciar outro ciclo de publicação enquanto existir um backup ou uma candidata pendente. A versão anterior permanece preservada até a finalização explícita. Depois de rollback, a versão rejeitada permanece parada para diagnóstico até ser descartada.

### Habilitação experimental

**O recurso está desabilitado por padrão.** Configure as credenciais do GitHub e os overlays de Aplicações e Projetos conforme as seções anteriores. Adicione `server/compose.releases.yaml` e habilite a variável no processo autorizado da VPS:

```sh
export PANEL_RELEASES_ENABLED=1
docker compose -f compose.yaml -f compose.github.yaml -f compose.apps.yaml -f compose.projects.yaml -f compose.releases.yaml up -d --build api
```

Esse comando é **orientação de instalação**, não foi executado nesta alteração. Não rode sem revisar as variáveis dos outros overlays e sem ter certeza de que a API e o Docker estão protegidos.

A importação agora é feita na aba Projetos pelo GHCR por digest, sem Docker CLI manual, após habilitar a função experimental. Para pacotes privados, monte credenciais de leitura somente no servidor. Nunca publique tokens no frontend, repositório ou URLs.

### Limites que permanecem

- Esse é um mecanismo inicial de **troca com pequena interrupção**, não um balanceamento sem downtime. Não há roteamento por domínio, migração de volumes nem distribuição de tráfego.
- A candidata precisa reportar `healthy` pelo Docker. Imagens sem `HEALTHCHECK` explícito não são aceitas.
- O painel oferece pull autenticado opcional por digest, mas **não verifica assinaturas/attestations nem substitui automaticamente containers após o build**. Labels OCI e metadados do GitHub ajudam a conferir consistência, não provam autoria criptograficamente.
- Se o processo da API ou o Docker cair durante renomeações, pode ser necessária intervenção administrativa para reparar nomes e estados. Os dados do container antigo não são apagados automaticamente.
- O `docker.sock` dá poderes administrativos ao processo mesmo montado `:ro`; mantenha acesso estritamente administrativo e evolua para um agente restrito antes de oferecer a terceiros.

**Próxima etapa:** roteamento por domínio, observabilidade pós-deploy, journal transacional para recuperação e isolamento do Docker socket.

## Quarta etapa: importação GHCR e recuperação

Foi acrescentada a importação opt-in de imagens GHCR por digest SHA-256, com consulta do status da operação, persistência da revisão/digest, preparação condicionada ao registro validado e recuperação explícita de estados interrompidos. Consulte o [manual operacional](docs/ghcr-import-and-recovery.md) para APIs, configuração segura de credenciais e limites de segurança.
