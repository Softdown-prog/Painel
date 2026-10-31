### 2026-10-30: ícones corrigidos nas linhas das revisões (PR)
Corrigida a localização: a seção separada do topo foi removida. A **tabela existente de últimas revisões** em Revisões e espaço agora intercala execuções do GitHub, inclusive builds ainda na fila, com imagens já importadas. As células de cada revisão exibem rodinha CSS enquanto CI/CD ou publicação estiverem ativos, verde para CI bem-sucedido e verde **Ativa na VPS** somente com mesmo SHA e container running; falhas vermelhas, divergências amarelas, situação desconhecida neutra. A coluna de proteção/limpeza é separada para impedir confusão entre imagem armazenada e deploy ativo. Consulta apenas endpoints já existentes; frontend Pages requer novo CI e publicação, backend não foi modificado. Não declarar sessão real da VPS validada sem login e prova.

### 2026-10-30: revisões com indicadores GitHub → VPS (PR em revisão)
Nova seção somente leitura em **Revisões e espaço**: mostra três workflows recentes por repositório conectado, indicadores animados durante a fila/build/publicação, verde de CI aprovado e verde *Ativa na VPS* apenas após `GET /projects/{slug}/releases` confirmar SHA + container running. Histórico `/publications` sinaliza progresso intermediário e falha, mas não prova ativação. Atualiza a cada 20 s durante atividade ou 90 s em repouso, somente com aba visível. O acesso HTTPS público permanece não verificado. **Não publicado nem validado na VPS**; checar CI no PR, publicação Pages após merge, e resposta da API da VPS.

### 2026-10-30: impedir terminal antigo em cache no Pages
A publicação da interface do PR #24 foi bem-sucedida, mas o erro exato "Comando muito longo." pertence apenas ao JavaScript anterior. A publicação Pages agora carimba as URLs de JS/CSS com o SHA do commit e envia _headers de revalidação para HTML/terminal. A API da VPS permanece um deploy separado; **não declarar terminal de 4 MB operacional na VPS até substituição e verificação da API**. Verificar status do deploy Pages/CI e o navegador, sem pressupor atualização do container de produção.

# Tarefas para o Codex — Painel da VPS Softload

> **Leia primeiro:** este documento registra o que falta fazer ou validar. Não marque itens como concluídos sem testes e provas no GitHub. O objetivo é transformar o painel em um gerenciador de hospedagem **rápido, amigável e seguro**, que comece em uma VPS pequena e possa crescer até vários servidores, sites e clientes.
>
> **Estado de referência:** GitHub `Softdown-prog/Painel`, branch `main`, interface Cloudflare Pages, backend Node 24/TypeScript e Docker Compose na pasta `server/`.

### Terminal VPS — correção de comandos longos (proposta)
Substituído input por textarea, removido bloqueio de 600/605 caracteres, aceitos scripts multiline de até 4 MB, incluindo API SSH com JSON maior. Os demais endpoints preservam 64 KiB de corpo, shell mantém 18s e 24 KiB de saída. Scripts grandes não entram no histórico. CI e publicação precisam de confirmação; *merge não atualiza sozinho a API da VPS*.

**Limite atual de capacidade:** são permitidas até **8 aplicações gerenciadas** por instalação. Esse teto é uma proteção temporária do protótipo, não o desenho final de hospedagem de clientes. Aumentar o limite exige controle por servidor, cotas, separação de clientes e observabilidade (tarefa C07).

### Ativação PostgreSQL — preflight e proteção das redes (nova etapa)
Correção de segurança de deploy: o overlay de PostgreSQL mantém explicitamente as redes de administração (proxy) e banco privado. O CI verifica que a API continua acessível pelo túnel e o executor continua sem rede. Foi criado o diagnóstico somente leitura `server/postgres-preflight-vps.sh`. **Ainda não foi aplicado em produção.** Próximo passo: identificar a instalação/overlays efetivos e programar atualização isolada da API, sem interromper o acesso do painel nem outros projetos. Não afirmar status conectado antes de verificar a API da VPS.

### Banco de Dados — PR de integração real somente leitura
A instância PostgreSQL 18 foi confirmada pelo operador na VPS, com container vps-postgres e teste de criação/remoção de banco. Esta branch introduz integração opt-in de status e listagem pelo overlay server/compose.postgres.yaml. Sem habilitar a flag, nenhuma conexão será feita. Código proposto no PR #22 (branch feat/postgres-live-readonly-panel); Console CI aprovado na revisão eb994e7 (run 41151858886), Docker integration smoke aprovado (run 41151858841). Frontend/API não publicados nem validados na VPS. A versão com teste extra do overlay ainda exige novo CI. Ver docs/BANCO-DE-DADOS.md. Operações de escrita e isolamento entre projetos continuam pendentes; a instância atual usa trust sem senha.

### Banco de Dados (histórico: interface preparada sem PostgreSQL)
**Código proposto em branch/PR dedicado:** seção Sistema → Banco de Dados, com abas de visão geral, projetos, acessos, tabelas/consulta, recuperação e monitoramento; indicadores indisponíveis quando não consultados, botões mutáveis desligados, status autenticado `GET /database/status`, negação explícita das demais rotas e testes. Documentação de implantação futura: [BANCO-DE-DADOS.md](BANCO-DE-DADOS.md).

**PostgreSQL instalado:** não. **pgAdmin/Adminer instalado:** não. **VPS, containers, DNS, Caddy, volumes, rede e credenciais alterados:** não. **Banco e contas reais:** nenhum cadastrado por esta mudança. **CI:** aprovado na revisão `131048dadeb12b00bd17e050122456f7e23df55d`, [Console CI](https://github.com/Softdown-prog/Painel/actions/runs/41135121146) e [Docker executor integration smoke](https://github.com/Softdown-prog/Painel/actions/runs/41135121102). **PR:** [#20](https://github.com/Softdown-prog/Painel/pull/20), preparado para revisão, sem merge. **Frontend publicado e VPS validada:** não; instalação não autorizada nesta etapa. Não chamar o módulo de operacional até o adaptador e a instalação serem autorizados e testados.

### Recuperação real da API e instalação do painel genérico

**Código implementado:** PR #18, revisão `5fdcc96a167b17ccf3c422d51ec9e522b0de66bb`,
integrado com autorização no merge `e09a22c1be1a5ec124b1b39bc1169d464926edd7`.
**CI aprovado:** 143 testes Linux e Docker real do PR; Console CI, Docker e Pages
do merge aprovados. **Frontend publicado:** confirmado no Pages pelo SHA do merge,
no domínio principal e alternativo. **Backend instalado:** API/executor versionados
pela revisão do PR, mantendo os 12 overlays; API e túnel em `vps_panel_control`,
executor sem rede, `PANEL_SOFTLOAD_LEGACY=0` e nenhuma montagem de projeto hospedado.

**Causa comprovada do incidente:** API em estado `Created`, sem execução, com o
túnel registrando ausência do nome de destino. Iniciar somente a API restaurou
HTTP 200/JSON de sessão, com a conta existente, sem trocar segredos nem DNS/Access.
Durante a instalação coordenada foram tratados a criação explícita da rede antes
de ligar o túnel e a leitura do token pelo UID/GID não root do cloudflared; o token
foi preservado, não exposto. A conta manteve seu hash e os outros projetos não foram
reiniciados. **Produção validada até aqui:** sessão pública nos dois domínios,
negativa 401 sem login, probes internos, API/executor saudáveis e túnel conectado.
Login administrativo e demais operações reais são registrados separadamente no
[relatório de recuperação](RECUPERACAO-PRODUCAO.md), com versões, reversão e limites.
Não confundir os resultados históricos abaixo com o estado final instalado.
**Verificações internas adicionais:** inventário real do executor com dez
containers e consulta `uptime` pelo módulo SSH da API aprovada (exit code 0).
Navegador real desktop e login mobile/touch sem erros JS ou overflow. A sessão
autenticada do navegador permanece pendente de confirmação; não foi simulado login.

### Painel independente dos projetos hospedados (30/10/2026, código implementado)

**Contexto confirmado:** o usuário tem apenas o terminal do próprio painel, sem console direto da provedora. Esse terminal depende da API; não pode ser usado como canal de recuperação quando ela está inacessível. O PR #17 foi integrado e o Pages publicou os novos arquivos, mas a consulta pública da sessão ainda retornou HTTP 502.

**Vínculos encontrados no código:** rede externa `softload_proxy` e arquivo `/opt/softload-infra/softload/.env` no Compose base; verificações periódicas e histórico global fixos na Softload; navegação e indicadores centrados nesse projeto. A origem do HTTP 502 ainda não foi comprovada no servidor. Não confundir esses vínculos com prova da falha em produção.

**Código [`f3387b0`](https://github.com/Softdown-prog/Painel/commit/f3387b02d15e9428ac68addf2649acee2f04517b), branch `fix/generic-vps-control-plane`, a partir de `9a5d91e`:** rede administrativa própria, nenhum arquivo de projeto obrigatório, compatibilidade Softload explícita e opcional, consultas e apresentação genéricas por projeto. A API não espera o executor ficar saudável para iniciar; login e métricas sobrevivem à sua indisponibilidade. Foram preservados volumes, credenciais, labels e dados existentes. O proxy frontal para publicação exige configuração da instalação, e a origem privada HTTPS da API pode ser configurada por binding confiável do Pages. Ver [arquitetura e implantação](PAINEL-GENERICO.md).

**Validação local:** TypeScript, build, JS/shell, sintaxe YAML e diff aprovados. Suíte completa: **143 testes, 142 aprovados, uma falha de ambiente no socket Unix (`listen EPERM`), zero ignorados**, mantendo o teste ativo no CI. A integração real em Node validou inicialização/login sem Softload e sem executor, histórico, negação de controles legados e preservação de conta/registros após reiniciar e habilitar compatibilidade. Chromium isolado: cinco cenários em desktop e os mesmos cinco em mobile/touch, zero erros JS, incluindo inventário geral, histórico por projeto, terminal somente leitura, API anterior e compatibilidade opcional após reconexão.

**CI aprovado no [PR #18](https://github.com/Softdown-prog/Painel/pull/18), revisão `eb85b89`:** [Console CI](https://github.com/Softdown-prog/Painel/actions/runs/41039782593) com **143 testes aprovados, zero falhas e zero ignorados**, incluindo socket Unix, TypeScript, build e Compose; [Docker real](https://github.com/Softdown-prog/Painel/actions/runs/41039782717) com API/executor sem Softload, rede administrativa interna e cliente separado confirmando DNS/HTTP. A validação também confirma rede independente, dados preservados e conexão do túnel à rede do painel. **Frontend desta etapa publicado:** não. **Recuperação real da VPS:** pendente; nova consulta pública ainda retornou HTTP 502 sem contrato da sessão. Não foi feita implantação nem alteração em redes, DNS ou serviços de produção. A busca de integração administrativa Cloudflare/SSH não encontrou plugin disponível nesta sessão. Não há mecanismo direto conectado para reiniciar ou reconfigurar o host. O terminal do painel não substitui esse canal quando a API está indisponível.

### Recuperação da conexão painel → API (30/10/2026, código implementado)

**Diagnóstico confirmado:** consultas anônimas a `/api/session` no domínio do painel e no endereço Pages retornaram HTTP 502, sem o contrato de sessão da API. Isso não identifica, isoladamente, se a causa na VPS está na API, rede Docker, túnel ou autorização privada. O terminal também escondia a falha atrás de “formato inesperado”, e outras telas aceitavam JSON inválido como resposta vazia.

**Código: [`4283d3e`](https://github.com/Softdown-prog/Painel/commit/4283d3e78fa3acf458934d3d889ea8b4056c6bf9), branch `fix/panel-api-connection`, baseada em `f14ec46`:** a ponte Pages normaliza falhas sem divulgar credenciais; todas as telas compartilham o transporte; **Testar conexão** recupera o acesso sem recarregar a página. O healthcheck passa a validar o contrato HTTP da API, e há um diagnóstico somente leitura para o operador. Não há repetição automática de operações administrativas após erro de transporte nem alteração de DNS, regras de acesso, serviços ou dados da VPS. Ver [diagnóstico e próximos passos](CONEXAO-API.md).

**Validação local:** TypeScript, build, sintaxe JS/shell e diff aprovados. Suíte completa: **136 testes, 135 aprovados, uma falha, zero ignorados**. A falha é a mesma da linha de base: `listen EPERM` no teste do socket Unix do executor neste ambiente; o teste permanece ativo no CI Linux. Os **30 testes novos** passaram. Chromium isolado, com a página real e a Function ligada a uma API simulada: seis cenários em desktop 1440×1000 e os mesmos seis em mobile/touch 390×844, zero erros de JavaScript, uma única escrita mesmo após falha e recuperação manual confirmada.

**CI aprovado no [PR #17](https://github.com/Softdown-prog/Painel/pull/17), revisão `0d63ca6`:** [Console CI](https://github.com/Softdown-prog/Painel/actions/runs/41031454389) com **136 testes aprovados, zero falhas e zero ignorados**, incluindo o socket Unix, TypeScript, build/sintaxe e os cinco conjuntos de overlays Compose; [Docker executor integration smoke](https://github.com/Softdown-prog/Painel/actions/runs/41031454434) com API/executor reais isolados e o novo verificador HTTP aprovados. **Frontend publicado:** sim, após integração `9a5d91e` e [deploy Pages aprovado](https://github.com/Softdown-prog/Painel/actions/runs/41032714115); HTML e JS novos responderam HTTP 200, sem a mensagem antiga do terminal. **VPS validada:** não; a consulta pública ainda retornou HTTP 502 sem contrato de sessão. O CI e a publicação da interface não substituem a recuperação da API/túnel.

### P0 · Migração multiprojetos iniciada (27/10/2026)

**Etapa 1, commit `008b046`:** o registro de projetos aceita vários serviços com posse exclusiva; cadastros antigos continuam legíveis; a interface permite ajustar os vínculos sem apagar containers. Os publicadores existentes continuam limitados a um serviço principal e recusam projetos com vários serviços. O CI Linux do PR #3 passou. A API foi instalada na VPS após backup verificável do código e do volume; a imagem `sha256:68fd9d55de65...` ficou saudável e leu o cadastro atual. Ver [diagnóstico e etapas restantes](MIGRACAO-MULTIPROJETOS.md).

**Publicação da etapa 1:** PR #3 integrado na main `e640db4`; workflow Pages `40592074991` aprovado. `https://panel.analysepro.com` e `projects-ui.js` responderam HTTP 200 com os novos controles. A API na VPS permanece saudável.

**Etapa 2, commit `d1686ab`, PR #4 integrado:** os identificadores legados de App, Agent e Caddy foram isolados em `server/legacy-softload-profile.ts`. O perfil pode ser desabilitado em instalações sem Softload V4; a VPS atual mantém o padrão habilitado. CI Linux e Pages passaram. API e executor já receberam o perfil na VPS; após atualizar o executor, seu health check e o smoke isolado de despertar passaram.

**Etapa 3, commit `720971c`, PR #5 integrado:** inventário autenticado `/hosted-projects` e cartões na Visão geral para Softload V4 e aplicações independentes. CI Linux e Pages passaram. A API foi instalada na VPS com backup local verificável do código e volume; a imagem `sha256:03b5ae8ddd46...` ficou saudável. O inventário é somente leitura e não altera deploy ou scale-to-zero. O acesso autenticado ao endpoint ainda precisa de teste de interface na VPS.

**Etapa 4, PR #6 integrado e instalado:** gateway interno de despertar para aplicações gerenciadas com domínio, sem Docker socket direto e com verificação de posse antes de iniciar. Testes focados, CI Linux e smoke isolado de sono/despertar na VPS passaram; API e gateway ficaram saudáveis. Nenhuma rota pública foi alterada porque não há domínio gerenciado cadastrado. Homologação com domínio HTTPS e SSE ainda pendente. Ver [backup, imagens e reversão](MIGRACAO-MULTIPROJETOS.md).

### Inventário de todos os containers da VPS (nova etapa, código sob validação)

**Problema:** o endpoint legado `/services` só mostrava App, Agent e Caddy, e `/apps` só listava serviços com labels do painel. Um container externo, como `terrania-origins-multiplayer-1`, não era exibido embora rodasse no mesmo Docker.

**Implementação:** nova consulta administrativa `GET /containers`, inventário mínimo filtrado pelo executor e aba **Containers da VPS**, com prévia na Visão geral. O painel mostra novos containers automaticamente, sem editar cadastros; os externos continuam **somente leitura**, sem expandir direitos de logs, restart, stop, remove, inspeção detalhada nem acesso ao Docker socket. Testes de política, proxy Unix, projeção de dados e interface cobrem o caso do Terrania.

**Estado:** implementação de código proposta para GitHub; **implantação de API e executor na VPS ainda não confirmada**. O deploy de Cloudflare Pages sozinho não basta. Após CI, validar `/containers` autenticado, o nome real do container multiplayer, containers desligados e a preservação de permissões e recursos na VPS, com rollback isolado de API e executor.

## Regra principal de experiência

O usuário quer ações simples: **Criar site**, **Conectar GitHub**, **Escolher domínio**, **Publicar**, **Ver se está funcionando**, **Reiniciar**, **Fazer backup** e **Excluir**. Nunca mostrar comandos, identificadores internos ou configurações do Caddy na tela principal. Explicar limitações em português do Brasil, sem fingir que algo está pronto.

### Situação real no código

| Área | Estado confirmado no repositório | O que falta |
| --- | --- | --- |
| Visão geral | Listagem e métricas de serviços autenticados | Saúde por aplicação, atualização em tempo real, alertas |
| Sites e apps | Criar/iniciar/parar containers permitidos, recursos, logs e parada por inatividade | Wizard de hospedagem, redes/portas, arquivos persistentes, escala além de 8 |
| Projetos GitHub | Conexão de repositório, builds, pull opt-in por digest, releases com backup | Publicar do GitHub com validação final e rollback guiado, sem passos manuais |
| Endereços | Reserva de `slug.apps.zona` na rede dedicada e arquivo Caddy gerado | Aplicação pública automática e verificada, domínios próprios de clientes, TLS |
| Executor Docker | Isolado em outro container, socket Unix, testes simulados e Docker real no CI | Implantação real autorizada, auditoria durável, política por cliente |
| Clientes e múltiplas VPS | **Não implementado** | Contas/organizações, cobrança, servidores, cotas e migração |
| Deploy da API no host | **Não implantado por esta automação** | Acesso administrativo restrito específico para o Painel, backup e rollback |
| CI | Testes de código, Compose, smoke com Docker real em runner temporário | E2E do usuário no navegador e smoke seguro na VPS |

### Ajuste do painel após retirar Sandbox/Embeddings (27/10/2026)

**Código proposto na branch `fix/core-services-after-retirement` (não equivale a deploy na VPS):** somente App e Agent ficam habilitados para iniciar/parar/reiniciar; Caddy continua apenas leitura. As antigas imagens/containers Sandbox, Embeddings e Portainer saem da lista autorizada no executor; histórico de publicações passa a consultar só os dois containers centrais. A tela Gerenciar concentra ações, bloqueia clique duplicado, permite atualizar logs e evita botão Iniciar para container inexistente. Testes de regressão de Docker e UI foram ampliados.

**Aceite:** CI TypeScript/Node/Docker e frontend aprovado; confirmar que interface Cloudflare e API/executor da VPS foram atualizados **juntos** antes de marcar publicado; validar logs/autorização e endpoints `/services`/`/deploys` com acesso autenticado. Não alterar Compose da Softload, credenciais ou imagens antigas de rollback por esta mudança. Imagens Docker recuperáveis não são consideradas descartáveis automaticamente.

### Correção de diagnóstico · Publicações da Softload V4 (26/10/2026)

**Implementado no repositório:** `server/deploy-verification.mjs` consulta apenas dados dos dois containers principais Softload pelo executor Docker, identifica a revisão real da imagem em execução e separa workflow concluído, imagem ativa, outra versão em execução e revisão não confirmada. A aba Publicações deixa de classificar como “NÃO ATIVO” apenas porque o SHA do GitHub difere de `SOFTLOAD_IMAGE_TAG`. Um `.env` isolado nunca confirma ativação. Docker API sem acesso direto pela API do Painel; o executor permanece isolado.

**Monitoramento de tráfego por deploy (2026-10-26):** o coletor de cinco minutos observa os runs do workflow de deploy e salva os contadores RX/TX da interface externa no começo e no fim de cada run. A tabela Publicações mostra a estimativa do intervalo; valores não são atribuídos quando o run terminou antes de ser observado ou se o contador reiniciar. A estimativa pode incluir tráfego simultâneo da VPS e não equivale à franquia faturada pela LocaCloud.

**Evolução no código:** o endpoint `/deploys` agora compara a imagem Docker com o SHA entregue pelo `/health` público, exibindo confirmação independente ou divergência sem atribuir sucesso fictício. Testes unitários e smoke Docker isolado foram acrescentados; o resultado público não garante o bundle React inteiro. Há cache de 25 segundos e consulta HTTPS limitada.

**Ainda pendente:** atualizar a API na VPS real e conferir imagens/SHAs atuais após backup e preflight, sem reiniciar serviços Softload; validar a comparação Docker versus `/health` público em produção; criar diagnóstico adicional de revisão por digest caso o ambiente passe a usar referências sem tags Git SHA. O frontend anterior pode estar publicado enquanto o backend ainda retorna apenas `currentSha`; nesse caso deve mostrar “ativação não confirmada”. Ver [guia de status](STATUS-DEPLOYS.md).

## P0 — Resolver antes de vender hospedagem

### C01 · Implantação controlada do backend na VPS

**Por que:** a interface Cloudflare Pages pode ter código mais novo do que a API instalada na VPS.

**Onde olhar:** `server/compose.yaml`, `server/Dockerfile`, `server/executor.Dockerfile`, `server/preflight-vps.sh`, `docs/docker-executor.md`.

**Implementar/validar:**
- Inspecionar, sem imprimir segredos, os serviços existentes, overlays Compose realmente em uso, backups, UID do volume `softload_panel_data`, redes, processos e healthchecks.
- Executar o preflight **somente leitura**. Fazer backup verificável antes de qualquer mudança.
- Configurar um mecanismo de publicação **específico do Painel**, auditado, com credenciais mínimas, um deployment por vez e rollback. **Não** ampliar permissões do `softloadrunner` do projeto Softloadv4 ou reutilizar seus comandos SSH restritos.
- Subir o executor e depois a API apenas com plano de contingência. Verificar os containers atuais e páginas autenticadas. Não reiniciar a Softload V4 sem necessidade.
- Registrar data, revisão, checagens e resultado. Se não houver privilégio autorizado, **registrar bloqueio e deixar instruções para o operador**, sem burlar o acesso.

**Aceite:** executor saudável, API funcionando pela URL do painel, serviços Softload intactos, API sem bind do Docker socket real, plano de rollback testável. Não declarar sucesso só porque o GitHub Actions passou.

### C02 · Domínio de verdade com um clique (após C01)

**Por que:** hoje o painel só reserva o endereço e gera um arquivo. **Não publica o site**.

**Onde olhar:** `server/domains.ts`, `domains-ui.ts`, `server/router/Caddyfile`, `server/compose.routing.yaml`, `docs/domain-routing.md`.

**Implementar:**
- Wizard `Aplicação → Endereço → Publicar` com resumo antes de confirmar. Suportar **domínio próprio do cliente** (`cliente.com`, `www.cliente.com`) além de subdomínio do painel, somente após prova de controle do domínio e prevenção de domínio já ocupado.
- Verificar DNS e criar/renovar HTTPS de forma segura, inclusive domínio raiz, com tratamento de falha; não presumir certificado wildcard automático.
- Adicionar gerenciamento de configuração do gateway com validação antes da troca, recarga segura e rollback, sem editar arquivos do Caddy principal sem autorização explícita.
- Exibir estados confiáveis: `Não configurado`, `Aguardando DNS`, `Certificado em andamento`, `Publicado`, `Erro — ver detalhes`; só usar **Publicado** após teste HTTPS externo com hostname correto.
- Permitir remover o domínio e despublicar sem excluir os arquivos do cliente; isolar redes e impedir roteamento para containers de outro cliente.

**Aceite:** site de teste responde corretamente por HTTPS com domínio verificado; troca de domínio e reversão são idempotentes, auditadas e têm testes. Não direcionar domínio de produção para um serviço que ainda não foi verificado.

**Implementado no código local, aguardando implantação/homologação (26/10/2026):** o endpoint de domínio passou a registrar o estado real de publicação e o botão **Publicar** só declara sucesso após teste HTTPS externo. O fluxo gera DNS A proxied somente para rota pertencente ao Painel, instala configuração Caddy limitada ao host, valida/recarrega o proxy pelo canal SSH já isolado e preserva o container/arquivos ao despublicar. Requer token Cloudflare mínimo guardado no cofre da VPS e os overlays de roteamento, chaves e SSH. Manual: [PUBLICACAO-DOMINIOS.md](PUBLICACAO-DOMINIOS.md). Ainda não foi instalado na VPS, não criou DNS e não alterou Caddy; a homologação deve começar por `c02-lab.apps.analysepro.com`.

### C03 · Publicar projeto GitHub em fluxo guiado

**Implementado no backend, opt-in (2026-10-25):** `server/publications.ts` gerencia jobs persistidos em `/data/publication-jobs.json` com verificação de importação GHCR, staging, HEALTHCHECK, promoção com SHA esperado, conferência de container ativo e backup preservado. `projects-ui.ts` passou a registrar e acompanhar o job pelo endpoint autenticado `/projects/:slug/publication`. A API retoma operações incompletas a partir do estado gravado após reinicialização. Testes `server/publications.test.mjs` e `server/publish-ui.test.mjs`. O recurso fica desligado até instalar e configurar `server/compose.publications.yaml` na VPS; `PANEL_GHCR_PULL_ENABLED=1` e `PANEL_RELEASES_ENABLED=1` também são necessários.

**Pendente para homologação/Codex:** instalar API atualizada e overlays sem interromper Softload V4, testar build+import+release em VPS de testes com imagem real, validar após reboot, e implementar lock/lease distribuído antes de habilitar múltiplas réplicas da API. Atualmente há **um worker por processo**, com apenas um job ativo e idempotência por app/run; não é seguro executar múltiplos workers no mesmo volume. A publicação começa de um **build previamente concluído**, não automatiza todo o caminho de commit até build e deployment. Consultar [guia de publicação persistente](PUBLICACAO-EM-SEGUNDO-PLANO.md) antes de ativar na produção.

**Por que:** conectar repositório, gerar imagem, importar e promover ainda exige várias etapas manuais.

**Onde olhar:** `github-ui.ts`, `projects-ui.ts`, `server/github.ts`, `server/projects.ts`, `server/image-import.ts`, `server/releases.ts`, `templates/panel-app-build.yml`.

**Implementar:**
- Fluxo `Conectar GitHub → Selecionar repositório → Escolher RAM/CPU → Publicar`; mostrar etapa atual e necessidade de autenticação, sem exibir token.
- Revalidar permissão do repo, branch/workflow, origem/proveniência da imagem, digest, limites, healthcheck e aprovação humana antes da troca.
- Logs amigáveis e URL de cada tentativa; backup automático da versão anterior e botão **Voltar à versão anterior**, com auditoria e diagnóstico.
- Não presumir que todos os repositórios são Node.js, nem executar scripts fornecidos por clientes com o mesmo privilégio do painel.
- Preservar volumes e configurações conforme política explícita; impedir promoções simultâneas ou cruzadas.

**Aceite:** um site de demonstração pode ser publicado e atualizado do GitHub seguindo ações claras, com falha simulada e rollback verificado.

### C04 · Segurança para sites de clientes (bloqueador multiusuário)

**Por que:** um único operador e um socket Docker com poder de administrador **não** são suficientes para terceiros não confiáveis.

**Implementar:**
- Organizações/clientes, papéis (dono, operador, visualizador), autenticação reforçada, isolamento por projeto, quotas e trilha de auditoria com identidade e request ID.
- Separar completamente o plano de controle do código executado pelos clientes; negar acesso de cliente ao socket, rede interna, segredos da Softload e metadados do host.
- Políticas de imagens confiáveis, recursos, volumes, rede de saída, limites de número de containers; prevenção de abuso, rate limit e logs sem senhas.
- Simular ataques de container cruzado e recursos indevidos em testes automatizados.

**Aceite:** um cliente não consegue listar, reiniciar, acessar logs, segredos ou domínios de outro cliente. Revisão de segurança antes de exposição pública.

### C14 · Histórico de revisões e espaço da VPS

**Implementado no código:** aba **Revisões e espaço**, API `/maintenance/revisions`, opção de limpar somente imagens GHCR antigas e autorizadas, histórico de operações, botão para ligar/pausar a limpeza automática a cada 6 horas e comandos `revisoes` no Terminal VPS. Política inicial: manter 2 revisões por aplicação e tudo que foi importado há menos de 14 dias, preservar imagem em uso, candidata, backup e imagens compartilhadas. O executor confere todos os containers do host antes de permitir uma remoção individual sem `force`.

**Estado:** rotina instalada e ativada na VPS em 2026-10-26. O painel exibe se o Compose habilitou o recurso, o intervalo efetivo de seis horas e permite pausar/retomar a programação persistida sem expor o arquivo `.env`. A ativação inicial usa `PANEL_REVISIONS_CLEANUP_ENABLED=1` e `PANEL_REVISIONS_AUTOMATIC=1` no Compose.

**Melhoria adicional entregue:** o painel agora também consulta em modo somente leitura o inventário de imagens de toda a VPS, incluindo versões de containers da Softload V4, e destaca repositórios com múltiplas imagens locais. Não remove imagens desse inventário geral.

**Próximas melhorias:** consumo real de armazenamento com camadas compartilhadas, retenção de imagens da infraestrutura Softload V4, cache de build, alertas de disco, cron durável fora do processo web, comportamento consistente com jobs de importação/release e locks distribuídos entre réplicas da API. Testar limpeza com Docker real e cargas concorrentes **sem usar produção**.

**Aceite:** inventário e histórico mostram imagens preservadas e candidatas à limpeza; agendamento apaga apenas revisões antigas elegíveis após validação Docker, sem comprometer a versão atual ou rollback; porcentagem de espaço recuperado tem rótulo de estimativa; limpeza nunca executa prune global e não afeta sites de clientes.

## P1 — Hospedar clientes com praticidade

### C05 · Tela única “Meus sites”

**Parcialmente implementado no frontend (2026-10-25):** link **Painel completo** em cada aplicação e página `#site?slug=<nome>` com estado do container, limites, disco gravado, imagem, GitHub, endereço reservado, versão, backup, iniciar/parar/reiniciar, edição de RAM/CPU/ociosidade e registros Docker. Reutiliza APIs já existentes em vez de criar comandos SSH arbitrários. Testes `server/site-detail-ui.test.mjs` confirmam informações e validações básicas. O endereço é mostrado como reservado; não afirma publicação HTTPS.
**Ainda pendente:** CPU/RAM de uso real por aplicação em histórico, métricas de rede e armazenamento persistente, filtro/pesquisa para muitos sites, visualização automática de saúde HTTP externo e validação na VPS.

Mostrar nome, endereço, status **confirmado**, consumo, GitHub conectado, último deploy e ações `Abrir site`, `Atualizar`, `Reiniciar`, `Ver registros`, `Backup`. Ajustar `index.html`, `apps-ui.ts` e backend necessário. Fazer pesquisa e filtros para dezenas/centenas de sites; **não** carregar todos os logs de uma vez. Aceite: administrar um site frequente sem passar por várias telas.

### C06 · Arquivos, variáveis e bancos de dados
**Primeira parte implementada no código (26/10/2026):** nova aba **Chaves e acessos** (`#secrets`), API autenticada em `server/secrets.ts` e overlay opcional `server/compose.secrets.yaml`. O administrador pode cadastrar, substituir e excluir valores de credenciais guardados como arquivos de permissão 0600 na pasta privada da VPS, com revalidação de senha, listagem sem expor valores e logs somente de ação/nome. Há teste de armazenamento, proteção de pasta, traversal/symlink e autenticação. O módulo fica **desligado por padrão** e **ainda requer instalação e teste real na VPS**.

**Falta para ficar realmente prático:** selecionar um serviço ou uma aplicação e **conectar** a chave cadastrada à configuração desse serviço por mount somente leitura, recarregar apenas o serviço indicado e verificar funcionamento, com opção de rollback. Os arquivos criados no repositório não fazem esse vínculo automaticamente. Não alterar a conexão SSH/root que o Codex configurou sem conferir o estado atual. Consulte `docs/CHAVES-NA-VPS.md`.

**Restante de C06:** volumes persistentes com backup e restauração, quotas por aplicação, variáveis de ambiente, arquivos de configuração específicos, um cofre criptografado ou KMS para multiusuário, bancos de dados por projeto e rotinas de rotação. **Nunca** armazenar chaves em HTML/localStorage, commits, logs ou imagens Docker. Aceite: administrar configurações e reiniciar/atualizar um site sem perder dados ou expor credenciais de outro cliente.

### C07 · Escalar para mais clientes e mais VPS
Remover a suposição fixa de 8 apps por meio de capacidade configurável com teto por host; não retirar limites de segurança indiscriminadamente. Criar inventário de servidores, CPU/RAM/disco disponíveis, tags, agendamento de aplicação, migração segura, grupos/ambientes (dev/homologação/produção) e estratégia de distribuição, sem misturar serviços internos da Softload com hospedagem de clientes. Começar com uma VPS pequena, permitir outra VPS sem reescrever todo o painel. Aceite: acrescentar um segundo servidor em homologação e administrar duas aplicações em hosts diferentes sem exposição de credenciais.

### C08 · Backup, recuperação e histórico
Backups automáticos e testados (restauração periódica), snapshots apenas quando compatíveis, histórico de operações, jobs duráveis com estados e repetição segura de deploys interrompidos. Aceite: recuperação demonstrada após falha de um deploy e de uma aplicação persistente.

### C09 · Monitoramento e orçamento da VPS
**Implementado no código, aguardando validação na VPS (26/10/2026):** a aba **Tráfego de Rede** lê somente os contadores da interface externa configurada (padrão `eth0`) por bind mount de `/proc/net/dev` em modo leitura. A API grava deltas a cada cinco minutos no volume privado do Painel, exclui loopback, Docker, bridges e veths, separa RX/TX, trata reinício de contador sem inventar bytes e mantém até 370 dias. A referência inicial é 1 TB por ciclo, configurável com dia de renovação e alertas de 70%, 85% e 95%. Não substitui a medição faturada da LocaCloud; não havia histórico `vnstat` na VPS antes desta coleta.
Painel simples de consumo por aplicação (memória, CPU, armazenamento, tráfego), alertas de disco/RAM e de indisponibilidade, limites de custo por cliente e estimativas sem inventar cobrança exata. Métricas amostradas sem sobrecarregar VPS pequena. Aceite: alerta antecipado antes de esgotar disco/memória e visão agregada por host.

### C15 · Painel de controle do host (facilitar administração da VPS)

O Terminal SSH/root oferece operações manuais na VPS, mas a experiência principal deve oferecer botões e telas que **não exijam saber comandos Linux**. O Painel não deve executar comandos genéricos vindos de formulários de clientes.

**Prioridades que ainda faltam no frontend/backend:**
1. **Serviços do Linux (systemd):** listar estados, iniciar/reiniciar/parar somente serviços autorizados, ver falhas e logs.
2. **Arquivos e configuração:** navegador de arquivos dentro de pastas administrativas aprovadas (sem traversal), editor com prévia de diff, backup antes de salvar e restauração; nunca expor chaves por leitura genérica.
3. **Tarefas e agendamentos:** listar, criar e pausar tarefas agendadas aprovadas; acompanhar execução e erros.
4. **Armazenamento:** visão separada de partições, volumes Docker, diretórios grandes e espaço em disco com alerta prévio; volumes de sites com backup e restauração antes da exclusão.
5. **Rede e portas:** estado de portas publicadas, proxy reverso, TLS, DNS e regras de firewall com validações, sem liberar porta publicamente por engano.
6. **Saúde e manutenção:** atualizações de segurança do host, uso de CPU/RAM/disco/tráfego, histórico de incidentes, reinício controlado da VPS e recuperação após reboot.
7. **Bancos de dados:** criar usuário/banco por aplicação, limitar armazenamento, programar backup e restaurar, sem expor senhas em telas de histórico.
8. **Várias VPS:** inventário de hosts, operações por servidor e permissões isoladas, como C07.

**Critério de aceite:** cada operação tem estado real confirmado pela VPS, confirmação antes de ações destrutivas, histórico sem credenciais e comportamento testado numa VPS de homologação. Evitar falsa sensação de recurso pronto apenas por adicionar um botão.

## P2 — Operação de hospedagem

### C10 · Clientes, planos e cobrança
Cadastro, convite, isolamento por cliente, planos com limites e cobranças, suspensão reversível com avisos, política de retenção e backups antes de exclusão. Não permitir que atraso de pagamento exclua dados sem política clara.

### C11 · Templates e hospedagem simples
Modelos aprovados para sites estáticos, Node, Python e outros stacks com controles por tecnologia; deploy em 1–3 ações sem precisar conhecer Docker. Confirmar runtime detectado, build e configuração antes de publicar. Não aceitar Dockerfile arbitrário com privilégio elevado na VPS.

### C12 · Testes de usabilidade mobile e acessibilidade
Ensaiar os fluxos `Criar → GitHub → Endereço → Publicar` em Android e desktop, botões legíveis, mensagens de erro recuperáveis, labels acessíveis, tela vazia com próximo passo e skeletons. Testes E2E completos com Playwright somente em ambiente isolado (não alterar sites dos clientes).

## Como o Codex deve trabalhar

1. Ler `AGENTS.md`, este arquivo, `docs/GUIA-RAPIDO.md` e o estado atual da `main`. Verificar se alguma tarefa já foi resolvida por commits mais recentes.
2. Escolher a primeira tarefa P0 ainda não concluída e registrar escopo, riscos, dependências e testes antes de alterar.
3. Fazer implementação incremental, preferindo TypeScript no código novo, sem copiar as aplicações existentes para dentro do painel. Sincronizar JS compilado de frontend com os fontes `.ts`.
4. Executar `npm run typecheck`, `npm test`, `npm run check:js`, `npm run build:frontend` e os testes Docker/Compose relevantes.
5. **Nunca** publicar alterações administrativas na VPS sem caminho autorizado, backup e plano de rollback; não imprimir segredos e não contornar restrições do runner.
6. Atualizar este documento indicando **implementado no código**, **testado em CI**, **publicado no frontend** e **validado na VPS** como situações distintas. Incluir SHA, link do CI, prova e o que ficou pendente.
7. Informar o resultado em termos simples: `o que mudou`, `como usar`, `o que ainda falta`.

## Melhorias de linguagem obrigatórias

- Prefira `Criar aplicação` a `Docker create`; `Endereço` a `rota`; `Publicar` a `promover candidata`; `Ver registros` a `tail logs`.
- Se for inevitável mostrar `porta`, explicar que é o número de acesso **interno do programa**.
- Deixe `configuração Caddy`, `digest`, `GHCR` e `network` em área avançada.
- Nunca escrever `Publicado` ou `Tudo certo` se só houve cadastro de rota, build, pull de imagem ou sucesso em CI.
- Não criar “botão mágico” que executa ações destrutivas sem explicar efeitos e obter confirmação.

## Termos e arquivos de apoio

Guia de uso: [GUIA-RAPIDO.md](GUIA-RAPIDO.md). Domínios técnicos: [domain-routing.md](domain-routing.md). Segurança e instalação: [docker-executor.md](docker-executor.md). Importação GitHub: [ghcr-import-and-recovery.md](ghcr-import-and-recovery.md).

### C13 · Terminal Linux completo no painel (sem Codex)

**Problema resolvido em parte:** a aba `Terminal VPS` agora permite executar comandos de administração por meio de endpoints já existentes (`status`, `servicos`, `apps`, `logs`, `iniciar`, `reiniciar`, `dominio criar`, etc.). Isso elimina o Codex da rotina dessas operações.

**Implantado e validado na VPS em 25/10/2026:** execução real de um comando Linux por SSH com `linux <comando>`, desbloqueio de 10 minutos por senha administrativa, timeout, auditoria resumida e overlay `server/compose.ssh-terminal.yaml`. A API usa uma chave dedicada com permissões 0600 e verificação de host, conectando-se internamente à própria VPS como `root`; comandos administrativos e `sudo` funcionam. Foram validados pelo domínio público `linux whoami` e `linux sudo -n whoami`, ambos com saída `root`. O executor separado está saudável e a API não monta o socket Docker do host. **Não depende do Codex em cada comando.**

**Alteração publicada (28/10/2026, PR #13, merge `1902764`):** o terminal usa somente a sessão administrativa já autenticada do Painel, sem senha por comando e sem o desbloqueio adicional de dez minutos. A sessão geral de 12 horas, o limite por comando de 18 segundos/24 KB, a chave SSH privada no servidor e a auditoria resumida permanecem. Cada resposta tem botão **Copiar saída**. Dez testes focados, TypeScript, compilação do frontend, CI Linux `40777926766`, smoke Docker `40777926634` e Pages `40777926677` passaram. A API da VPS usa a imagem `sha256:983f031025f733ba85c52265f56b3df9153480f1a96ca3f5ea817114a0d5dfb5` e ficou saudável; backup verificável em `/opt/softload-infra/backups/panel-terminal-20261028T221500Z`. HTML e JS públicos responderam HTTP 200 e a execução sem sessão respondeu 401. Um comando autenticado real ainda precisa de conferência na interface pelo administrador; o navegador local do Codex estava desabilitado nesta sessão.

**Onde olhar:** `terminal-ui.ts`, `terminal-ui.js`, `docs/TERMINAL-VPS.md`, `server/api.mjs`, `server/executor.mjs`, `functions/api/[[path]].ts`.

**Próximo complemento:** evoluir a execução SSH de comando único para uma sessão PTY/WebSocket com entrada/saída ao vivo, controle de sessões e auditoria durável. O serviço precisa funcionar sem chamadas ao Codex/GitHub durante o uso. Não abrir SSH público adicional nem disponibilizar esse modo a contas de clientes.

**Aceite parcial validado:** administrador entra no painel, executa um comando Linux real na própria VPS, recebe a saída e repete sem Codex. A sessão PTY/WebSocket ainda não existe; o acesso atual é um comando por vez, com limite de tempo e tamanho de saída.


### Monitoramento compreensível da VPS · proposta em revisão (27/10/2026)

**Implementado no código da branch de revisão, ainda não publicado nem validado na VPS:** tela de saúde com hora da coleta, atualização manual e alertas claros para serviços parados, disco >= 85%, RAM >= 85% (somente com MemAvailable) e carga média por núcleo >= 1. Os indicadores começam em "sem dados"; resposta antiga ou falha é sinalizada como "dados anteriores". A antiga carga de CPU apresentada como percentual foi substituída pela média de 1 minuto dividida pelo total de núcleos, identificada como métrica de carga, não de uso instantâneo. O backend tenta MemAvailable do Linux para descontar cache recuperável e sinaliza fallback para a API antiga. A tela não declara site público nem deployment concluído.

**Validação de código:** commit de implementação `a2c096a`, Console CI [execução 40616802327](https://github.com/Softdown-prog/Painel/actions/runs/40616802327) **aprovada** em 27/10/2026 (Node/TypeScript, testes, verificação de JS, build de frontend e validações Compose). **Frontend publicado:** não. **API/executor atualizados e VPS validada:** não. Ainda faltam visual mobile, navegador autenticado e homologação das leituras com os serviços reais. Sem alterações de Docker/Caddy/Cloudflare, comandos de VPS ou deploy de produção por esta etapa.


### C09 · Evolução dos recursos nas últimas 24h (branch de revisão, 28/10/2026)

**Implementado no código, sem publicação na VPS:** o módulo de histórico coleta a cada 5 minutos somente RAM ocupada (por MemAvailable) e percentual de espaço do sistema de arquivos usado pelo volume do Painel, gravando no volume privado /data um JSON limitado a 288 pontos e 24h com gravação atômica e permissões 0600. Quando o arquivo está inválido, o painel mostra indisponível e não o apaga. O endpoint autenticado /overview entrega o histórico sem novos comandos administrativos. O frontend mostra dois gráficos adaptáveis ao celular, com lacunas em interrupções, horários e ausência honesta de dados. O histórico começa após instalar a nova API e depende de ela permanecer em execução; **não cria medições retroativas nem identifica qual aplicação consumiu disco ou RAM**.

**Código proposto:** PR #12, commit `d7e6e56` (correção de deduplicação), testes unitários de retenção, erros, limites e Docker smoke. **CI de código aprovado:** [Console CI #40664693398](https://github.com/Softdown-prog/Painel/actions/runs/40664693398) (TypeScript, testes, JS e build). **Docker real isolado aprovado:** [smoke #40664693362](https://github.com/Softdown-prog/Painel/actions/runs/40664693362). **Frontend publicado:** não. **API instalada / VPS real validada:** não. Antes de instalar a API na VPS, executar preflight e backup verificável de /data; conferir que o novo arquivo aparece no volume, sem leitura de segredos ou alterações em Caddy/DNS/containers da Softload. Confirmar frontend e API separadamente; até a instalação da API, a tela informa “Histórico não confirmado”.
