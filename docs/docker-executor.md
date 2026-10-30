# Executor Docker isolado — implantação e segurança

Esta etapa substitui o acesso direto da API administrativa ao socket real do Docker por um serviço de execução independente. O executor implementa autorização positiva: tudo que não estiver na política é negado.

## Arquitetura

Cloudflare Pages → função de borda → API administrativa (autenticada) → socket Unix /run/panel-executor/docker.sock → serviço executor Docker → /var/run/docker.sock no host.

O socket Docker original é montado **somente** no serviço `executor` do `server/compose.yaml`. A API monta um volume Docker compartilhado em somente leitura para conectar ao socket Unix do executor; o `executor` não possui rede Docker/IP (`network_mode: none`). O Caddy existente e as redes dos serviços Softload não são modificados por essa alteração.

O executor usa `server/executor.mjs`, que carrega a política TypeScript `server/executor-policy.ts`. O processo registra no stdout método, endpoint truncado, permissão ou rejeição e horário, sem serializar credenciais ou corpo da requisição.

A autenticação da API não espera a prontidão do executor. Falha no socket não bloqueia login nem métricas da máquina; as operações Docker continuam recusadas ou indisponíveis até o executor se recuperar. API e túnel usam a rede administrativa própria `vps_panel_control`, sem depender de redes ou arquivos de projetos hospedados. Ver [arquitetura independente e atualização coordenada](PAINEL-GENERICO.md).

## Política de autorização

- Modo genérico padrão: nenhuma permissão implícita sobre containers de projetos existentes. O inventário de todos os containers é somente leitura e não concede ações de controle.
- Compatibilidade explicitamente habilitada na API e no executor: App/Agent antigos permitem leitura, início, parada e reinício; Caddy é somente leitura. Sandbox, Embeddings e Portainer não são reabilitados.
- Contêineres gerenciados: a política verifica `com.softload.panel.managed=true`, slug e nome do slot. O executor resolve e encaminha comandos ao Docker usando o ID imutável que acabou de inspecionar.
- Criação: apenas nomes gerenciados, imagens permitidas e payload igual ao perfil de recursos limitado; não aceita bind mounts, modo privileged, usuário root, extra hosts, modo host network, novas portas ou capacidades adicionais.
- Renomeação: somente entre slot principal, candidata e backup de uma mesma aplicação; nunca entre projetos.
- Atualização: somente limites autorizados de CPU e RAM. Exclusão: somente containers gerenciados parados, sem `force` e sem remoção de volumes.
- Consulta a containers: a resposta é filtrada para serviços conhecidos e aplicações identificadas por labels. `exec`, volumes, plugins, criação de redes, containers arbitrários e solicitações de prune são negados.
- Importação de imagens: somente repositórios GHCR sob o proprietário configurado (`PANEL_GHCR_ALLOWED_OWNER`) e por digest SHA-256. O cabeçalho privado de leitura GHCR é encaminhado somente à operação de pull.

Essas regras são uma fronteira de autorização entre a API e o Docker, mas o processo executor ainda possui poder administrativo sobre o host por ter o socket Docker. Uma vulnerabilidade no executor ou no Docker poderá comprometer o host; controle de acesso de usuários e auditoria externa continuam necessários antes de oferecer um painel multiusuário.

## Implantação na VPS (não executada nesta etapa)

Pré-requisitos: backup verificável do projeto e do volume `softload_panel_data`, Docker Compose atualizado, acesso administrativo e uma janela de manutenção. Confira a configuração efetiva e todos os overlays usados na VPS antes de recriar serviços.

Antes de qualquer alteração, execute o **pré-diagnóstico somente leitura** no diretório `server`:

    bash preflight-vps.sh

Se o Painel utiliza overlays, informe seus nomes como argumentos, por exemplo `bash preflight-vps.sh compose.apps.yaml compose.github.yaml`. O script verifica a configuração mesclada sem exibir segredos, o daemon, volumes e os containers conhecidos; não recria serviços. O proprietário do volume `/data` merece atenção: a API roda com UID 0, porém sem capacidades Linux; portanto, um volume pertencente a outro UID pode impedir gravações, mesmo que o processo seja root. **Não altere a propriedade de volumes existentes enquanto a API estiver ativa e sem backup.**

    cd /caminho/real/do/Painel/server
    docker compose -f compose.yaml config
    docker compose -f compose.yaml build executor api
    docker compose -f compose.yaml up -d --no-deps executor
    docker compose -f compose.yaml ps
    docker compose -f compose.yaml up -d --no-deps api

Esses comandos mostram apenas a base. Se o servidor já usa overlays GitHub, aplicações, projetos, releases, GHCR ou domínio, **inclua-os todos** nos comandos de configuração, build e up para preservar as variáveis, montagens e serviços existentes. Confira se o executor está saudável antes de reiniciar a API.

### Checagens após implantação

1. O comando `docker inspect softload-panel-api` não deve mostrar `/var/run/docker.sock` em `Mounts`.
2. O comando `docker inspect softload-panel-executor` deve mostrar o socket Docker montado apenas no executor.
3. Confirme que `softload-panel-executor` está saudável (`healthy`) e possui `NetworkMode=none`.
4. Faça login no Painel e valide as telas Serviços, Aplicações, Projetos e Domínios em leitura antes de habilitar operações destrutivas.
5. Examine os logs estruturados do executor e confira que uma requisição negada retorna 403 e não chega ao daemon Docker.
6. Verifique que os overlays opcionais continuam desligados até autorização explícita.

### Plano de contingência

Se o novo executor falhar, mantenha os serviços de produção intactos e diagnostique o socket interno, as permissões do volume e a saúde do serviço. Faça backup da configuração atual antes de qualquer reversão. O commit anterior à mudança de executor pode ser usado como ponto de referência para revertê-la, mas esse método restaura o acesso direto e não deve ser considerado solução definitiva.

## Testes

`server/executor-policy.test.mjs` cobre autorização de payloads, containers, GHCR, recursos e renomeação. `server/executor.integration.test.mjs` sobe um executor real em processo de teste e um daemon falso em sockets Unix temporários, exercitando chamadas permitidas e negadas sem acessar o Docker da VPS.

## Próximas melhorias

- Separar leitura e mutação em processos/identidades diferentes e emitir trilha de auditoria durável, com identidade do operador, request ID e retenção.
- Política por projeto/usuário e autorização no daemon (plugin de autorização Docker ou um controlador de escopo ainda menor).
- Confirmações, idempotência e journal transacional de releases; detecção de atualizações concorrentes entre instâncias.
- Prometheus/observabilidade, limites de taxa e alertas para operações negadas e repetidas.

## Verificação adicional em Docker real no GitHub

O workflow `.github/workflows/executor-smoke.yml` constrói a API e o executor em uma máquina efêmera hospedada no GitHub e inicia ambos com limites de CPU, RAM, filesystem somente leitura e capacidades removidas. O executor permanece sem rede; a API e um cliente de teste usam uma rede administrativa interna descartável, sem acesso externo. O cliente confirma DNS e HTTP pelo alias da API. Não usa o Docker daemon da VPS. O teste valida inicialização administrativa, autenticação, projetos, inventário, histórico e a manutenção das permissões sem nenhum serviço Softload instalado.

Esse teste revelou um problema real de permissão: a imagem original criava `/data` sob o UID `node`, enquanto o processo efetivo da API usava UID 0 sem `CAP_DAC_OVERRIDE`. Em volumes iniciais com UID 1000 e modo 0755, a API não conseguia criar `/data/setup-token`. O Dockerfile foi alinhado ao UID efetivo, e o smoke test agora inicializa e testa explicitamente o volume descartável com as capacidades removidas. Em instalações existentes, é necessário verificar a propriedade real do volume e corrigir somente após backup e inspeção autorizada.

## Limitação de acesso remoto

O repositório Painel não possui, nesta etapa, um workflow configurado para atualizar sua API diretamente na VPS. No repositório Softloadv4, o runner `softloadrunner` é deliberadamente sem Docker e sem `sudo`; a ação de deploy desse projeto usa SSH com comandos restritos próprios. Essas permissões não devem ser ampliadas ou contornadas para atualizar outro serviço. A implantação definitiva do Painel depende de um mecanismo **específico e aprovado para o painel**, executado por um administrador da VPS, com auditoria e rollback.
