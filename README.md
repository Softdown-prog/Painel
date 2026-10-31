# Painel VPS — projetos, aplicações e monitoramento

Painel: https://panel.analysepro.com (alternativo: https://softload-vps-panel.pages.dev)

Cada push na `main` executa `.github/workflows/deploy-pages.yml`: testes, build do frontend e publicação no projeto Cloudflare Pages `softload-vps-panel`. O workflow usa um token exclusivo `Pages Write` armazenado em `CLOUDFLARE_API_TOKEN` nos segredos GitHub. `CLOUDFLARE_ACCOUNT_ID` está no mesmo local. As credenciais da API privada da VPS permanecem nos segredos do Cloudflare Pages.

O backend agora tem publicação independente: `.github/workflows/deploy-vps.yml` testa, constrói API/executor no GitHub, publica no GHCR por digest e usa executor SSH/OIDC exclusivo na VPS. Só confirma sucesso com SHA instalado, saúde e resposta HTTPS correspondentes, preservando overlays/dados e revertendo o projeto em falha. [Evidências reais e inventário](docs/VPS-DEPLOY-VALIDACAO.md). Diagnóstico pelo GitHub: workflow **VPS operations** ou ponte de issue administrativa somente leitura.

## Novo frontend Angular 22 na VPS (prévia incremental)

A prévia Angular também tem **Sites e apps**, usando os endpoints administrativos já existentes para listar aplicações gerenciadas, criar containers desligados, consultar logs, iniciar/parar/reiniciar, atualizar limites de CPU/RAM e inatividade e remover com confirmação. A API segue responsável por validar propriedade, imagem, quotas, isolamento e impedimentos de domínio. Containers de outros projetos não recebem controles. O consumo em tempo real não é inferido a partir dos limites definidos.


A prévia Angular também apresenta **Publicações** com dois estados independentes por revisão: CI/CD no GitHub e confirmação da revisão em execução na VPS por SHA real. Erros de consulta não são pintados como sucesso, e todas as ações destrutivas permanecem no backend/telas existentes. A aba é somente leitura e atualizada manualmente; nenhuma versão é declarada acessível por HTTPS apenas por executar no Docker.


A aplicação `angular/` usa Angular 22 e TypeScript 6 em um projeto separado, preservando TypeScript 7 do backend e do frontend legado. O Pages agora compila e publica a prévia em `/angular/`: login com sessão existente, indicadores reais da API e inventário de containers. As demais áreas continuam no frontend atual (`/`). Nenhum token da Cloudflare é colocado no Angular. **Angular está publicado no Pages e usa a API real da VPS.** O Dockerfile opcional `panel-web` também o compila, mas a migração pública do frontend para a VPS continua separada. Veja [Migração do frontend para VPS](docs/MIGRACAO-FRONTEND-VPS.md).

## Frontend na VPS (migração preparada, sem troca do domínio)

Há uma alternativa opcional ao Cloudflare Pages: `web/Dockerfile` + `web/server.mjs` + `server/compose.web.yaml` servem a interface diretamente no Docker da VPS e encaminham `/api/*` com a chave privada **somente no servidor**. O serviço `panel-web` fica na rede administrativa, sem porta publicada e sem Docker socket; não substitui API/executor, Caddy nem Tunnel. O workflow Pages **continua ativo** enquanto a nova rota não for instalada, protegida e validada. Procedimento, testes e rollback: [Migração do frontend para VPS](docs/MIGRACAO-FRONTEND-VPS.md).

## Comece aqui — sem conhecer Docker

O painel é genérico: nenhum projeto hospedado precisa existir para a API iniciar ou para o administrador entrar. A configuração base possui rede administrativa própria e não monta arquivos da Softload. Os dados e identificadores técnicos existentes foram preservados. Leia [Painel independente dos projetos](docs/PAINEL-GENERICO.md) para a arquitetura, compatibilidade opcional e implantação coordenada de API/túnel.

O painel foi pensado para criar e administrar sites rapidamente. Use [Guia rápido do painel](docs/GUIA-RAPIDO.md) para entender as telas: **Sites e apps**, **Projetos GitHub** e **Endereços**. Configurações internas do servidor ficam em **Avançado**.

**Para o Codex:** as limitações, problemas que ainda dependem de acesso à VPS, próximos serviços, hospedagem de clientes e expansão para várias VPS estão em [Tarefas do Codex](docs/TAREFAS-CODEX.md). As instruções para o agente estão em [AGENTS.md](AGENTS.md). O backlog distingue código pronto de funcionalidades já validadas na produção.

**Aviso importante:** neste protótipo o máximo atual é **8 aplicações gerenciadas**. O código já possui publicação guiada de DNS/HTTPS para aplicações do Painel, mas ela só fica disponível depois da configuração explícita e da validação na VPS; o painel nunca mostra um endereço como público sem teste HTTPS. A ampliação para clientes e muitas VPS é uma tarefa planejada, não algo concluído.

## Quando o painel não conecta à VPS

Abra **Configurações → API da VPS → Testar conexão**, ou use o mesmo botão no login. O painel diferencia sessão expirada de falhas na conexão e não repete comandos automaticamente. Para HTTP 502, autorização privada ou resposta inesperada, consulte [Diagnóstico da conexão](docs/CONEXAO-API.md). O procedimento no console da VPS é somente leitura e não mostra credenciais. Publicar no Pages não atualiza os containers na VPS.

## Inventário de todos os containers da VPS

Em **Containers da VPS**, o administrador vê todos os containers existentes no Docker, inclusive serviços criados fora do painel com Docker Compose, como `terrania-origins-multiplayer-1`. A tela **Visão geral** também mostra uma prévia, com quantidade de containers ativos e parados. A informação vem do Docker em tempo real, após o login; não é prova de saúde HTTP, prontidão do serviço ou disponibilidade do site.

A API privada oferece `GET /containers` somente para sessões autenticadas. O executor isola esse inventário: encaminha somente `GET /containers/json?all=1` ao Docker, elimina labels não aprovadas e outros dados internos e devolve apenas nome, imagem, status, projeto Compose e classificação. A lista é limitada a 500 itens, com aviso caso exceda. **Nenhuma ação de controle** foi concedida a containers de outros projetos. Softload V4 e aplicações gerenciadas preservam as políticas de acesso anteriores.

**Publicação:** como essa melhoria altera `server/api.mjs`, `server/executor.mjs` e a interface, a publicação do frontend no Cloudflare Pages **não atualiza sozinha** os containers da API/executor na VPS. Após validação e autorização, a atualização da VPS precisa reconstruir e recriar **somente** `api` e `executor` com os overlays Compose vigentes e teste de regressão. Não reiniciar a Softload, Caddy ou Terrania. Antes da atualização, a tela explicará que o inventário está indisponível.

## Arquitetura atual

Cloudflare Pages -> Function TypeScript -> Cloudflare Access -> Cloudflare Tunnel -> API privada da VPS -> Docker.

A API mantém senha administrativa com scrypt, sessão em cookie HttpOnly/Secure/SameSite=Strict e segredo de borda. A interface apresenta projetos, inventário de todos os containers, uso da máquina, imagens e registros. O histórico geral reúne as publicações por projeto, sem atribuir a saúde da VPS a uma aplicação específica. A aba **Revisões e espaço** preserva imagens utilizadas e as permissões existentes.

Os nomes antigos de App, Agent e Caddy pertencem ao perfil de compatibilidade em `server/legacy-softload-profile.ts`, desligado por padrão. O overlay `server/compose.legacy-softload.yaml` o habilita explicitamente na API e no executor. Apenas App/Agent recebem os controles antigos; Caddy é somente leitura, e os serviços retirados não são reabilitados. Aplicações gerenciadas e projetos GitHub são independentes desse perfil.

## Nova integração GitHub

Na aba **Deploys**, você pode conectar repositórios, escolher uma branch e um workflow YAML, acompanhar as últimas execuções, solicitar um deploy manual e desconectar o projeto sem apagar containers.

| Método | Endpoint | Descrição |
|---|---|---|
| GET | /repositories | Listar conexões (nunca retorna token) |
| POST | /repositories | Validar repositório, branch e workflow; conectar |
| DELETE | /repositories/:owner/:repo | Desconectar |
| GET | /repositories/:owner/:repo/runs | Consultar execuções |
| POST | /repositories/:owner/:repo/deploy | Disparar workflow_dispatch |

Instalações novas começam sem repositórios pré-cadastrados; conexões já salvas são preservadas. O painel **não cria automaticamente o workflow e não faz deploy de projetos genéricos sem pipeline previamente configurado**. Para publicar a cada commit, o workflow precisa também estar configurado para push na branch.

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

## Quinta etapa: domínios de aplicações

A aba **Domínios** prepara uma rota exclusiva para cada aplicação criada pelo Painel na rede Docker dedicada `softload_panel_apps`, com portas internas e zona DNS autorizadas. O código de roteamento está em `server/domains.ts`, o gateway de Caddy separado em `server/router/Caddyfile` e o overlay opcional em `server/compose.routing.yaml`.

**Nenhum domínio se torna público apenas por cadastrar a rota.** Depois de habilitada, a ação **Publicar** cria o DNS pertencente ao Painel, atualiza uma rota Caddy limitada ao endereço, valida/recarrega o proxy e confirma HTTPS externamente. Até a confirmação, o estado fica como certificado em andamento ou precisa de atenção. O gateway não publica portas externas, não tem acesso ao Docker socket e não participa da rede proxy de produção. A API administrativa principal ainda precisa ser isolada do Docker socket antes de atender usuários não confiáveis.

Veja [publicação guiada de domínios](docs/PUBLICACAO-DOMINIOS.md) para a configuração única, a credencial mínima e o teste C02. Ela ainda não foi habilitada na VPS por esta alteração.

Veja o [guia operacional de domínios](docs/domain-routing.md) para pré-requisitos e etapas de ativação. A implantação desse gateway na VPS não foi executada automaticamente.

## Sexta etapa: executor restrito para o Docker

A API administrativa deixou de montar diretamente `/var/run/docker.sock` no `server/compose.yaml`. Somente o novo executor independente tem o socket do Docker. A API comunica-se por socket Unix compartilhado em volume somente leitura, e o executor usa uma política de autorização explícita para containers conhecidos, imagens GHCR aprovadas, operações de recursos e releases. Operações desconhecidas são rejeitadas e auditadas sem registrar credenciais.

**Atenção:** o executor continua tendo acesso privilegiado ao Docker host. Ele reduz o alcance de uma falha na API, mas não representa isolamento completo contra comprometimento do executor. A implantação na VPS ainda deve ser validada manualmente e não foi realizada nesta etapa.

Veja o [manual de implantação do executor](docs/docker-executor.md) para pré-requisitos, checagens, testes e contingência.

### Pré-diagnóstico de implantação do executor

O executor foi testado também com **Docker real em um runner temporário do GitHub Actions**, usando a API e o socket Unix compartilhado. O workflow `.github/workflows/executor-smoke.yml` verifica autenticação, listagem dos serviços, consulta de aplicações e bloqueio das operações de criação desativadas. Esse workflow não implanta nada na VPS.

Antes de recriar serviços na VPS, um administrador com Docker autorizado deve executar o verificador **somente leitura** dentro de `server/`: `bash preflight-vps.sh` (acrescentando como argumentos os nomes dos overlays em uso). Ele valida o Compose efetivo e sinaliza incompatibilidades de UID no volume existente, sem alterar permissões. O runner da Softload V4 não tem privilégios Docker/sudo e não foi usado para mudar serviços. Consulte [o manual do executor](docs/docker-executor.md).

## Terminal da VPS: CLI sem Codex

A aba **Terminal VPS** está disponível no frontend. Consulte **`status`**, **`servicos`**, **`apps`**, **`logs app`**, **`reiniciar app`**, **`dominios`**, **`projetos`** e outros comandos listados com `ajuda`. Eles usam a API já autenticada do painel, sem acionar Codex ou GitHub Actions por comando.

**Linux real opcional:** o código da API suporta `linux uptime`, `linux ls -la /opt`, `linux docker ps` e outros comandos executados por SSH na VPS. O acesso usa a sessão administrativa autenticada do Painel, sem desbloqueio adicional de dez minutos, e é **desligado por padrão** em novas instalações. O administrador precisa provisionar uma vez uma conta SSH, chave privada protegida e known_hosts na VPS e acrescentar `server/compose.ssh-terminal.yaml` aos overlays em uso. Na VPS Softload, o recurso está ativado; em outras instalações depende de configuração. Com a configuração pronta, o usuário opera sem Codex.

O SSH atual executa um comando por vez e devolve sua saída, com limites de tempo e tamanho. Ainda não é uma sessão PTY interativa para editores como vim. Consulte [o manual do Terminal VPS](docs/TERMINAL-VPS.md), que também contém a instalação inicial e as limitações.

## Revisões e espaço — limpeza automática controlada

A nova aba **Revisões e espaço** mostra imagens de revisões importadas pelo Painel, identifica versões ativas, backups e imagens antigas elegíveis, estima espaço e apresenta histórico de limpezas. O administrador também pode ativar ou pausar a limpeza automática pelo próprio painel ou pelo Terminal VPS (`revisoes`, `revisoes limpar`, `revisoes auto ligar`).

A rotina usa retenção conservadora de 14 dias e 2 revisões por aplicação e não apaga containers ou volumes. Ela é **desabilitada no backend por padrão**: exige instalação autorizada da API e do executor atualizados e habilitação inicial via `server/compose.revisions.yaml`. A API agendará verificações a cada 6 horas após ativação; relatórios sem acesso ao Docker não são apresentados como dados reais. Consulte [guia da limpeza de revisões](docs/REVISOES-E-LIMPEZA.md) e [backlog de melhorias pendentes](docs/TAREFAS-CODEX.md).

## Primeira etapa Cloud Run: painel completo por aplicação e publicação guiada

Agora cada aplicação gerenciada tem um link **Painel completo** em `Sites e apps` com estado real do container, limites de memória/CPU, imagem, tamanho gravado, logs, GitHub, endereço reservado e revisão em uso, além de comandos Iniciar, Parar, Reiniciar e Salvar configurações. O atalho leva à rota `#site?slug=<nome>` e usa as APIs já autenticadas na VPS.

Em **Projetos GitHub** → **Consultar builds**, uma execução concluída com sucesso oferece **Publicar revisão** quando a importação GHCR e os releases estão habilitados. Um clique confirmado executa, em sequência: importar por digest se necessário → preparar candidata → aguardar HEALTHCHECK saudável → verificar novamente estado e SHA esperado → promover. O backup fica preservado para rollback. A API também aceita o campo opcional `expectedRevision` em `POST /projects/:slug/releases/promote`, conferido debaixo do lock de release, para impedir a promoção de outra revisão.

**Atualização:** o botão **Publicar revisão** agora enfileira um **job persistido no backend** (`server/publications.ts`) e só acompanha o progresso. O processo continua no servidor ao fechar o navegador e reconcilia o estado salvo após reinício da API. Exige a implantação autorizada de `server/compose.publications.yaml` com `PANEL_PUBLICATIONS_ENABLED=1`, além da importação GHCR e releases já habilitados. Um único worker ativo por instalação; não ativar múltiplas réplicas sem lock distribuído. Nenhuma aplicação foi publicada na VPS durante esta mudança. Manual: [Publicação que continua com o navegador fechado](docs/PUBLICACAO-EM-SEGUNDO-PLANO.md).

## Chaves e acessos — arquivos de credenciais na VPS

A aba **Chaves e acessos** (`#secrets`) permite ao administrador cadastrar, trocar e excluir arquivos de chaves de API pela interface, sem precisar editar manualmente arquivos dentro do servidor. O backend não revela valores salvos, exige senha administrativa para cada alteração e guarda os valores em arquivos privados com permissões `0600`, em uma pasta dedicada `0700`.

**Ativação opcional:** o código está pronto, mas o operador precisa criar a pasta `/etc/softload-panel/managed-secrets` na VPS, adicionar `server/compose.secrets.yaml` ao Compose atual e habilitar `PANEL_SECRETS_ENABLED=1` antes de usar com chaves reais. Esse overlay é inicialmente desligado e não interfere nos serviços atuais. Cadastrar uma chave **não configura nem reinicia automaticamente o serviço consumidor**; esse vínculo continua sendo uma próxima etapa. Veja o [guia de chaves](docs/CHAVES-NA-VPS.md) e o backlog de integração por serviço.

### Staging Angular da VPS via GHCR

O [guia de publicação da interface Angular](docs/PANEL-WEB-GHCR-VPS.md) documenta o workflow dedicado que compila a imagem no GitHub Actions, publica em GHCR por SHA/digest e instala somente `softload-panel-web` após a autorização root inicial do broker. Enquanto essa autorização não for instalada e o deploy não for confirmado com SHA/saúde reais, **Cloudflare Pages continua sendo o frontend público**, não o container VPS.

### Administração de VPS pelo executor já instalado

O workflow de [manutenção aprovada do `vpsops`](docs/VPSOPS-MANUTENCAO-APROVADA.md) usa o mesmo canal SSH/OIDC para host, saúde e reinício restrito de serviços registrados. Exige atualização inicial do broker root-owned e ambiente protegido no GitHub; não abre comandos Shell arbitrários.
