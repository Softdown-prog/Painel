# Migração integral do painel para Angular — branch de desenvolvimento

**Branch exclusiva:** `feat/angular-complete-migration` (originada em `main`, SHA `467bcadcad2ab9f3811fdcbf03912aec93539311`).

## Regra de liberação (congelamento de produção)

- Trabalhar **somente nesta branch** até conclusão integral da migração. Não abrir PR, não fazer merge, não atualizar `main`, não acionar `workflow_dispatch` de deploy e não criar issues que ativem bridges VPS.
- Executar testes de Node, TypeScript, Angular, broker e Docker exclusivamente em GitHub runners efêmeros. O workflow `ci.yml` aceita pushes desta branch **somente para testes**; os deploys Cloudflare Pages, VPS e GHCR automáticos continuam limitados a `main`.
- Um único PR final, após todas as funcionalidades e fluxos migrarem, CI completo verde e revisão de segurança; merge somente mediante nova aprovação explícita do usuário.

## Inventário de paridade (não chamar de concluído até existir equivalência testada)

| Módulo | Atual | Faltam |
| --- | --- | --- |
| Visão geral, indicadores, autenticação | Angular parcial | Dados vivos, erro offline, sessão, testes mobile e estados |
| Containers e gerenciamento | Angular parcial | Inventário seguro somente leitura, serviços explicitamente autorizados com logs e ações confirmadas; paridade gerencial completa e UX mobile pendentes |
| Sites e apps | Angular parcial | Auditoria de criação, recursos, logs, domínios e publicação |
| GitHub e publicações | Angular parcial | Todas as ações e paridade de seleção/histórico/vínculos |
| Terminal VPS | Migrando nesta branch | Comparar com CLI de compatibilidade, SSH, confirmações, script longo, acessibilidade |
| Revisões e espaço | Migrando nesta branch | Limpeza manual/automática, inventário, histórico, atividades GitHub e status VPS |
| PostgreSQL | Angular em desenvolvimento | Inventário real e criação isolada com certificado; revisar estados, integração, validações e paridade mobile |
| Domínios e DNS | Angular em desenvolvimento | Reserva, publicação, remoção e confirmação HTTPS; revisar DNS, gateway, estados e paridade mobile |
| Tráfego e recursos | Angular em desenvolvimento | RX/TX, referência mensal, histórico de rede, gráfico de RAM/disco; validar dados reais e responsividade |
| Chaves e segredos | Angular em desenvolvimento | Inventário, criação/rotação e remoção confirmadas; auditar acessibilidade, reautenticação e limpeza de memória |
| Configurações e conta | Angular em desenvolvimento | Configuração inicial, alteração de senha com invalidação de sessão; auditar estados e preferências |
| Detalhes do site e serviços | Angular em desenvolvimento | Resumo por app, recursos, logs, vínculos GitHub, domínio e releases; validar paridade funcional, operações e fluxo mobile |
| Limpeza da interface antiga | Pendente | Remover JS/CSS clássico e fallback **somente após** paridade integral e testes |

## Critérios de saída

1. Inventário completo dos elementos `index.html` e `*-ui.ts` legados; cada rota e ação tem equivalência Angular funcional.
2. Sem links `?interface=classica` ou referência ao frontend antigo na navegação principal final.
3. Revisão de XSS, CSRF, auth, permissões por projeto e ausência de tokens no navegador; operações perigosas exigem confirmação.
4. Testes unitários + integração Node/API + Angular build + Docker smoke + mobile (320/360/390/768px) verdes, com estados reais e loading.
5. Estratégia de substituição e rollback preparada, sem afetar projetos/containers alheios.
6. Somente após validação final e **autorização do usuário**, preparar PR único para `main` e executar merge/deploy.

**Situação atual:** MIGRAÇÃO EM ANDAMENTO. Não há liberação de produção desta branch.

## Tipagem rigorosa no desenvolvimento (31/10/2026)

- `tsconfig.json` (Node/API e código TS legado) e `angular/tsconfig.json` agora habilitam `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride` e `noFallthroughCasesInSwitch`.
- Angular mantém `strictTemplates`, `strictInjectionParameters` e `strictInputAccessModifiers` no compilador Angular.
- Chamadas `fetch` só incluem propriedade `body` quando há payload. Índices de arrays, parâmetros de URL e rótulos dinâmicos precisam ser validados antes do uso; não usar `as any` ou desabilitar regras para corrigir erros.
- O comando `build:frontend` de compatibilidade ainda usa `--ignoreConfig`. Isto será removido quando todas as telas legadas forem migradas. Até lá `npm run typecheck` verifica os arquivos TS legados sob o `tsconfig.json` rigoroso.
- O CI valida os dois compilares separadamente: `npm run typecheck` na raiz e `ng build` por meio da imagem frontend Docker. O código nesta branch não deve entrar em produção antes da migração integral e da autorização para merge.

## Incremento PostgreSQL e Domínios em Angular (31/10/2026)

- `/angular/#database`: inventário, métricas, identidades e criação de banco isolado com confirmação digitada, somente se a API confirmar provisionamento por certificado (sem senha). Endpoints `GET /database/status` e `POST /database/projects` existentes.
- `/angular/#domains`: listagem de aplicações elegíveis na rede isolada, reserva, publicação DNS/HTTPS e remoção com confirmação digitada; estado `published` vem da última verificação da API, não é disponibilidade contínua. Endpoints `GET /domains`, `GET /apps`, `GET /domains/caddy`, `POST /domains`, `POST /domains/:slug/publish`, `DELETE /domains/:slug`.
- Rotas antigas `/#database`, `/#domains` migram para Angular. Modo clássico explícito preservado até paridade integral.
- Sem novos privilégios, SQL arbitrário, token no browser, PR, merge ou deploy. Pendências: auditoria final, testes em aparelhos reais e migração dos demais módulos.

## Incremento — Tráfego e recursos (31/10/2026)

- `/angular/#traffic` consulta os contadores reais `GET /traffic` e o histórico de memória/disco no `GET /overview`. Mostra RX/TX, ciclo de referência, alertas e gráfico de até 31 dias + 24h, com coleta automática de leitura a cada 60s enquanto a aba estiver visível.
- `POST /traffic` muda apenas a franquia de referência e o dia de renovação (1–28), com confirmação digitada `ATUALIZAR`; não altera contrato com o provedor. Não inventar medição de faturamento. Frontend não envia segredos.
- Os atalhos `/#traffic` apontam para o Angular, mantendo modo clássico explícito para comparação durante a migração. Sem deploy ou merge.

## Incremento — Chaves e conta administrativa (31/10/2026)

- `/angular/#secrets`: inventário não sensível, conexão GHCR/GitHub, inclusão/rotação por nome e exclusão. Requer confirmação digitada do identificador e senha administrativa no próprio fluxo, sem armazenar em localStorage, sessionStorage ou logs. Ao encerrar o componente ou concluir uma tentativa, sinais de segredo e senha são limpos. Reutiliza `GET/POST /secrets` e `DELETE /secrets/:name` sem novos privilégios.
- `/angular/#settings`: alteração de senha existente por `POST /password`; após sucesso o backend invalida todas as sessões e o Angular exige login novamente. Setup inicial por `POST /setup` disponível quando `GET /session` informa `setupRequired`, com confirmação explícita; token inicial não fica salvo. `/#secrets` e `/#settings` direcionam ao Angular.
- O modo clássico explícito é mantido para verificação de paridade enquanto existirem recursos não migrados. Sem PR, merge ou deploy até validação integral.

## Incremento — serviços autorizados na tela Containers (31/10/2026)

- O inventário multiprojetos `GET /containers` **permanece apenas leitura**: nunca incluir IDs Docker, montagens, portas, labels ou ações genéricas na resposta.
- A seção Angular `panel-legacy-services` usa somente `GET /services`, `GET /services/:id/logs` e `POST /services/:id/(start|stop|restart)` já existentes, e exclusivamente IDs `app` e `agent` após confirmação digitada. O backend/executor mantém a política de autorização. Serviço `caddy` possui logs em modo leitura, mas não oferece comandos.
- Esta seção atende o modo legado opcional; serviços de aplicações gerenciadas têm ações separadas na aba Apps. Não ampliar ações para containers externos de Terrânia, PostgreSQL ou outros projetos sem autorização específica.

## Incremento — Detalhes nativos por aplicação (31/10/2026)

- Link direto `/angular/#site?slug=<slug>` no cartão de cada app. Os links legados `/#site?slug=<slug>` passam ao Angular; identificadores fora do padrão retornam à listagem antes de qualquer chamada à API. Modo clássico explícito continua disponível apenas para comparação durante a migração.
- Leitura autorizada `GET /apps`, `GET /apps/:slug`, `GET /projects`, `GET /projects/:slug/releases`, `GET /domains`. Caso projetos ou domínios falhem, a tela mostra 'consulta indisponível', **nunca** 'não vinculado'. Domínio reservado não equivale a HTTPS confirmado.
- Comandos de container apenas sob `/apps/:slug/(start|stop|restart)`, opções válidas de RAM/CPU por `/resources`, ociosidade por `/idle` e leitura de logs por `/logs`. Identidade validada no inventário autenticado; exige digitação do identificador e revalidação da permissão no backend. Nunca administra containers externos da VPS.
- Os metadados e o status das releases não autorizam disparar deploys. Revisão mobile e testes de integração ponta a ponta com API real ainda são pendências da migração integral.

## Incremento — visão geral com falhas parciais (31/10/2026)

- `/overview` e `/containers` são consultados separadamente: falha de um não impede a leitura do outro. Os estados mostram dados antigos de forma explícita e nunca os apresentam como saúde atual.
- `overview-state.ts` valida horário, métricas numéricas e inventário somente leitura; atributos Docker inesperados não são repassados à interface. Respostas assíncronas de uma sessão encerrada são descartadas.
- Novos testes em `server/angular-overview.test.mjs`. **Código apenas nesta branch:** CI e teste autenticado/mobile devem ser verificados; não há publicação nem merge.

## Regras adicionais de qualidade (31/10/2026)

- Ambos os projetos TypeScript (raiz e Angular) usam `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns` e `noPropertyAccessFromIndexSignature` além das opções estritas anteriores. `angular/tsconfig.app.json` mantém as três verificações estritas de template/injeção/entrada.
- ESLint flat config aplica `typescript-eslint` recommended e as regras solicitadas ao código `angular/src/**/*.ts`; `npm run lint` delega ao workspace Angular e passa a rodar no CI isolado, com `no-explicit-any` e `no-unused-vars` como erros. Arquivos legados/backend seguem verificados pelo TypeScript 7 estrito, até existir parser ESLint oficialmente compatível.
- Compatibilidade: o analisador typescript-eslint 8.x declara suporte oficial a TypeScript menor que 6.1. Por isso a instalação de ESLint fica isolada no Angular (TypeScript 6) e não bloqueia a instalação do backend (TypeScript 7). A cobertura do ESLint no backend é uma pendência consciente; nenhum downgrade nem `--force`.
- Sem deploy ou alterações na VPS. CI e limpeza de avisos do novo lint serão avaliados nesta branch.

## Reprodutibilidade Angular

- `angular/package-lock.json` é gerado a partir da instalação real do workspace, versionado na branch e conferido com `npm ci` tanto no CI quanto no estágio Angular do Dockerfile. Sem instalar em produção.

## Incremento — RAM, alertas de capacidade e leitura automática (31/10/2026)

- A visão geral Angular exibe RAM real do `GET /overview` com a fonte (MemAvailable ou fallback identificado), sem confundir cache recuperável com consumo. Validação de totais inválidos bloqueia valores não confirmados.
- Alertas informativos de disco >= 85%, RAM >= 85% apenas com MemAvailable e carga média de 1 minuto >= quantidade de núcleos. Carga não é porcentagem instantânea de CPU, disco indica o volume monitorado; dados antigos/ausentes não recebem confirmação verde.
- Atualização a cada 60s somente na visão geral/inventário, com sessão autenticada e aba visível; também ao voltar para o navegador. O timer é limpo ao destruir o componente. Somente endpoints GET existentes, nenhum comando de container.
- Testes cobrindo porcentagens, fallback de RAM, dados ausentes, amostras antigas/futuras e restrições de atualização. **Código na branch apenas**; ainda exige revisão em navegador autenticado e dispositivos móveis. Sem deploy.

## Incremento — busca e filtros de containers (31/10/2026)

- Aba Angular `#containers` agora permite busca local por nome/imagem/projeto, filtro por estado e filtro por projeto. Opções de projetos vêm unicamente do inventário autorizado e são ordenadas; campos permanecem tipados e não requerem endpoints adicionais.
- A contagem filtrada sempre distingue resultados da última leitura válida do total conhecido; listas truncadas pela API não são apresentadas como varredura completa. Estado diferente de `running` é rotulado “Não em execução”, sem assumir que todos estejam parados.
- Filtros são descartados ao encerrar a sessão e jamais são persistidos no navegador. Inventário de containers externos permanece **somente leitura**, sem ações de ciclo de vida nem exposição de IDs Docker.
- Testes unitários de busca com acentos, filtragem por estado/projeto e nenhuma leitura confirmada adicionados a `server/angular-overview.test.mjs`. Pendente validação em navegador real no Android e revisão completa da paridade com o legado.

## Incremento — ciclo de vida de sessão Angular (31/10/2026)

- Tela Angular verifica o cookie administrativo com `GET /session` ao carregar, a cada 60s com aba visível em **todas** as páginas autenticadas, ao voltar à aba e após trocar de rota. A verificação é independente das métricas; não exige permissão adicional.
- Qualquer sessão rejeitada, resposta não verificável ou erro de conexão na checagem bloqueia imediatamente a interface, limpa leituras e formulários sensíveis e impede apresentar painéis como autenticados. `401` em consulta protegida também bloqueia, mas `401` em login e `403` por permissão não são interpretados como expiração.
- Um contador de geração impede que uma confirmação tardia restaure a interface após logout. Tentativas de login limpam a senha também em caso de falha.
- Logout bloqueia a interface imediatamente, mas não declara sucesso do servidor sem `{ok:true}`; em falha mantém o aviso e um botão explícito para repetir `POST /logout`. Configuração inicial e alteração de senha preservam suas confirmações.
- Testes unitários cobrem validação da sessão, erros 401/403 e vínculos do fluxo no Angular. Pendente teste autenticado em navegador e Android, com a VPS desligada e sessões expiradas. **Somente branch:** nenhum deploy.

## Correção — logout pendente não libera novo login (31/10/2026)

- Um logout em andamento usa estado próprio `logoutPending`; confirmação negativa ou erro mantém `logoutUnconfirmed` e bloqueia formulário e submissão direta de `login()`, incluindo configurações iniciais.
- Em vez de renderizar simultaneamente o formulário de entrada, o Angular mostra apenas a confirmação pendente ou a ação de tentar encerrar novamente. `GET /session` também fica bloqueado até obter confirmação de saída do backend.
- O predicado puro `maySubmitAdminLogin` tem testes para sessão desconhecida, usuário autenticado, setup, entrada em andamento, validação de sessão pendente, logout em andamento e logout não confirmado. No frontend, a senha continua limpa em qualquer tentativa de login.
- Somente a branch Angular; testes E2E com cookies reais e cenários de perda de rede ainda pendentes. Nenhuma alteração de API/VPS/produção.

## Incremento — terminal SSH: confirmação vinculada ao comando (31/10/2026)

- `/angular/#terminal`: confirmação fica vinculada ao texto exato revisado (inclusive espaços e quebras de linha). Alterar o campo ou selecionar um exemplo cancela a autorização; a chamada de execução revalida novamente, antes do `POST /terminal/ssh/exec`.
- Validação de comando (limite UTF-8 4 MB e caracteres proibidos) isolada em `angular/src/terminal-command.ts` e exercitada por testes unitários, incluindo texto alterado após a confirmação, estado SSH desabilitado, tentativas sem aprovação e scripts multilinha.
- Comando aprovado é descartado ao confirmar/cancelar/sair da tela. O componente não exibe resultados de consultas concluídas após sua destruição; não pressupõe que fechar a tela interrompa execução já enviada ao servidor.
- Sem mudança de permissão SSH, endpoint, token, Docker/VPS ou deploy. Resta testar o terminal em navegador autenticado com dispositivos móveis antes da liberação.

## Incremento — confirmação segura na tela de chaves (31/10/2026)

- `#secrets`: gravação e exclusão usam confirmação associada ao nome, presença/ausência no inventário e revisão do formulário. Alterar nome, descrição, finalidade ou valor invalida a aprovação anterior; recarregar o inventário também cancela a confirmação. A revisão é numérica: **o valor secreto não é duplicado** para checar a confirmação.
- Exclusão exige item existente no inventário autorizado, senha administrativa e confirmação digitada; troca de registro ou estado invalida a ação antes do envio. Os controles de edição são desabilitados durante a operação e os dados sensíveis são limpos ao fechar a tela.
- Consultas atrasadas não restauram o inventário após `OnDestroy`. Uma gravação já enviada não é cancelada pelo fechamento da tela; o servidor continua sendo a fonte de verdade, e a próxima abertura deve consultar o inventário.
- Testes de confirmação, revisão do formulário, cadastro/substituição/exclusão e limpeza após destruição em `server/angular-secrets-settings.test.mjs`. Ainda pendente validação em navegador real e celular, sem API/produção alteradas.

## Incremento Angular — importação GHCR e preparação de candidata (31/10/2026)

- A aba **Projetos GitHub → Builds e versões** mostra em cada execução aprovada os controles *Importar GHCR* e *Preparar candidata*. Esses controles existem somente para um projeto com workflow `panel-app-build.yml`, serviço principal único, revisão ativa identificada e em execução, nenhuma candidata ou backup pendente, publicação persistente não ativa e API de importação disponível.
- **Importar GHCR:** habilitado quando o build possui `id` e SHA válidos, `status=completed`, `conclusion=success` e ainda não há registro da mesma revisão importada. Exige digitar `IMPORTAR <slug>`, reconsulta os vínculos, builds, importação, releases e publicação, e somente então envia `POST /projects/:slug/images/import` com `{runId}`. Uma resposta HTTP 202 apenas indica **importação solicitada**; a conclusão ainda depende de reconsulta `GET` e validação de digest SHA-256.
- **Preparar candidata:** só habilitado se `GET /projects/:slug/images/import` informa SHA idêntico ao do build selecionado e digest `sha256:` válido. Exige digitar `PREPARAR <slug>` e revalidar todos os estados antes de `POST /projects/:slug/releases/stage` com `{runId}`. Resposta `staged:true` não implica HEALTHCHECK saudável nem publicação da nova versão.
- Fases desconhecidas de publicação ou importação e alterações concorrentes de projeto/build/revisão bloqueiam a operação. O backend mantém a autoridade final sobre permissão e propriedade.
- Os testes E2E em `angular/e2e/project-releases.spec.mjs` cobrem ausência de POST sem confirmação, envio do único `runId` correto, separação importação/preparação, divergência de imagem, build reprovado após abrir a confirmação e publicação persistente em andamento. Testes somente com API simulada, **sem conectar à VPS**.
- **Ainda pendentes:** promoção de candidata saudável, descarte de reserva, recuperação segura, vínculos e serviços gerenciados, comparação visual completa e homologação da API real. Não fazer PR, merge ou deploy antes de aprovação.

## Incremento Angular — inspeção de releases e controles confirmados (31/10/2026)

- Nova tela sob demanda `angular/src/project-release-panel.component.{ts,html,css}` dentro da aba Projetos GitHub. O Angular só consulta `GET /projects/:slug/releases`, `GET /projects/:slug/images/import`, `GET /projects/:slug/publication` e `GET /projects/:slug/runs` quando o operador expande um vínculo; estados de API indisponível aparecem como **não confirmados**, nunca como revisão saudável.
- **Solicitar build:** habilitado somente com `buildsEnabled=true`, vínculo de um serviço principal, branch válida e workflow `panel-app-build.yml`. Confirmação digitada do slug; antes de qualquer `POST /projects/:slug/build`, reconsulta `GET /projects` e confere identidade, workflow, serviços e habilitação. Exige resposta `accepted:true` com slug/repositório correspondentes. Isso apenas pede um workflow; não equivale a deploy na VPS.
- **Rollback:** só habilitado quando `GET /projects/:slug/releases` confirma revisão atual em execução, backup disponível, ausência de candidata, `enabled=true` e publicação persistente comprovadamente fora de fase ativa. Exige `RESTAURAR <slug>` digitado; antes de `POST /projects/:slug/releases/rollback`, revalida vínculo, revisão ativa, backup e estado da publicação. Fases desconhecidas bloqueiam o botão. O backend permanece a autoridade final e executa suas próprias verificações de propriedade e estado.
- Os controles não enviam nenhuma ação ao abrir ou consultar a tela. Testes de navegador com API simulada em `angular/e2e/project-releases.spec.mjs` exercitam confirmação, recusa em cenários inseguros, alterações concorrentes e mobile 320px. Nenhum desses testes se conecta à VPS real.
- **Ainda não migrados/validados integralmente:** associação e seleção de serviços gerenciados, importação manual GHCR, staging, promoção de candidata, descarte de slot, recuperação de estado seguro, trabalho persistente de publicação e integração autenticada com dados reais. Sem PR, merge, deploy nem limpeza do legado até paridade completa e autorização.

## Paridade da interface — Projetos GitHub, Terminal e Revisões (31/10/2026)

Esta etapa compara `projects-ui.ts`, `github-ui.ts`, `terminal-ui.ts` e `revisions-ui.ts` com as telas Angular, mantendo a VPS e as APIs intocadas.

- **Projetos GitHub (incremento concluído nesta branch):** a lista Angular passa a consultar `GET /projects` e mostrar vínculos de aplicações, repositórios, serviços e link validado para `/angular/#site?slug=...`. Essa consulta é somente leitura, independente da lista de repositórios, e distingue falha da API de ausência de vínculos. O histórico de execuções é protegido por identificador de requisição e limpeza em `ngOnDestroy`, impedindo que respostas atrasadas de outro repositório substituam a seleção atual ou encerrem o indicador de carregamento errado.
- **Terminal (já existente, com teste E2E acrescentado):** `GET /terminal/ssh/status` e `POST /terminal/ssh/exec` exigem confirmação revisada antes do envio. A CLI interpretativa local (ajuda, atalhos e fluxos assistidos) da interface clássica continua diferente do terminal Bash Angular. **Não afirmar paridade funcional completa** até inventariar os comandos legados que devem ou não virar ações seguras.
- **Revisões (incremento concluído nesta branch):** mostrar informações informadas pelo agendador Compose e repositórios com múltiplas versões locais, sem confundir a preferência de limpeza automática com a execução confirmada da rotina. O Angular continua oferecendo consulta, confirmação para mudança e remoção controlada por API existente. **Falta** comparação de versões com execuções GitHub + estados da publicação por revisão como no legado, além de paridade visual/mobile final.
- **Projetos gerenciados (pendência):** o frontend clássico também possui vínculo/desvínculo de aplicação, seleção de serviços, solicitação de build, importação GHCR, preparação, promoção, rollback, descarte e recuperação persistente. Algumas informações podem aparecer na área de detalhes do site, mas as ações não devem ser consideradas migradas sem auditoria e testes de autorização por projeto.
- **Cobertura:** `angular/e2e/operations-parity.spec.mjs` acrescenta testes de vínculos, falha parcial, respostas antigas ao trocar repositório, confirmação do Terminal, confirmação `LIMPAR` e responsividade de 320px, usando somente API simulada. Esses testes não autorizam deploy, merge nem limpeza da interface antiga.

## Testes E2E de navegador — Angular (31/10/2026)

- Suite Playwright isolada em `angular/e2e/` usa Chromium num GitHub runner efêmero, build Angular de produção e servidor local em `127.0.0.1:4175`. O servidor **não funciona como proxy para a VPS**: chamadas `/api` sem interceptação retornam 503; o teste intercepta chamadas com fixtures.
- Casos adicionados: login e métricas simuladas, revogação de sessão, logout não confirmado e nova tentativa, links legados `/#infrastructure`, navegação mobile por hash/Voltar, busca do inventário e ausência de rolagem horizontal em 320/360/390/768/1280 px. Não disparar operações de deploy, shell, provisionamento, Caddy ou Docker nesses testes.
- Novo job `frontend-e2e` do `ci.yml`, independente do job existente; nunca faz deploy. O runner instala `@playwright/test` em workspace de teste isolado com versão fixada e sem alterar as dependências de produção. Relatórios/traces somente em falha, com retenção curta.
- **Limite:** fixtures validam UX e comportamento do navegador, não atestam integração à API de produção. Testes autenticados na VPS, dispositivos Android físicos, paridade integral com o legado e revisão visual permanecem pendentes. Não realizar PR/merge/deploy sem aprovação posterior.

## Correção incremental — deep links da interface Angular (31/10/2026)

- O redirecionador da raiz `index.html` agora reconhece `/#infrastructure` e envia para `/angular/#infrastructure`, como já fazia o roteador do Angular. A consulta da tela continua autenticada e nenhuma capacidade MCP/cluster foi ativada por essa alteração.
- `server/angular-canonical-mobile.test.mjs` cobre o acesso ao módulo novo, a conversão de links `#site?slug=...`, a rejeição de identificadores inválidos e a preservação do modo clássico explícito para comparação de paridade.
- Alteração limitada a `index.html`, testes de interface e esta documentação, sem modificações no backend, executor, workflows ou produção. **Paridade completa, testes E2E em navegador real e homologação mobile seguem pendentes.**

## Nova frente — Servidores MCP e Clusters multiprojetos (31/10/2026)

**Escopo desta entrega: painel de cadastro de arquitetura, NÃO provisionamento.** A tela Angular `/angular/#infrastructure` oferece criação, edição, listagem e exclusão confirmada dos **planos** MCP e cluster. Um plano não é um processo, nó ou servidor funcionando; nenhuma métrica/estado é inventado. O backend retorna `runtime: not-provisioned` e capacidades `provisioning=false, healthMonitoring=false, lifecycle=false`.

- Nova API administrativa `GET /infrastructure`, `POST /infrastructure`, `PUT /infrastructure/:id`, `DELETE /infrastructure/:id`. Ela fica **depois da checagem de edge key e sessão do Painel** em `server/api.mjs`. A interface usa cookie same-origin, sem chave no navegador.
- Configurações persistidas como `infrastructure-plans.json` em `PANEL_DATA_DIR`, com gravação atômica e modo 0600, serialização de alterações, leitura restritiva e proteção contra sobrescrever arquivo corrompido.
- Cada configuração pertence a um projeto existente em `projects.json`; identificador determinístico `projeto.tipo.nome`. Cadastros órfãos ficam identificados e podem ser removidos, mas não editados até reconectar o projeto. Cada operação valida identidade do projeto; nenhuma configuração faz referências a containers ou redes de outros projetos.
- Limites conservadores: 32 planos no total, 8 por projeto e até 8 réplicas **apenas planejadas** por cluster. MCP: transporte privado `streamable-http`, uma instância. Cluster: topologia de nó único ou regional (somente cadastro). Sem parâmetros de shell, URL arbitrária, segredos, portas, imagens não confiáveis, Docker socket ou exposição pública.
- Formulário Angular com revisão e confirmação digitada do ID completo; edição altera apenas capacidade/topologia planejada. Tela informa explicitamente que não provisionou serviços nem reservou CPU/RAM. Layout responsivo, erros e estados vazios.
- Testes: `server/infrastructure.test.mjs` verifica persistência, isolamento, concorrência, limites, adulterações, cadastros órfãos, confirmação e corrupção de dados; `server/angular-infrastructure.test.mjs` valida payload e navegação.

### Próximas etapas obrigatórias (sem autorização de deploy nesta branch)

1. **Executor seguro de MCP**: escolher runtime/transportes e empacotamento, registrar ferramentas permitidas por projeto; políticas de autenticação e comunicação MCP, mTLS/RBAC, isolamento por rede, sem execução de comandos livres.
2. **Clusters reais**: definir nó/worker, limites físicos, colocação (VPS única vs. múltiplos hosts), gerenciamento da fila e estado desejado vs. observado; só então ativar provisionamento idempotente.
3. **Manutenção e observabilidade**: inspeção de saúde, logs sanitizados, restart/scale/upgrade/rollback com confirmação e políticas de autorização auditáveis; evitar alegar disponibilidade com base só no registro.
4. **Homologação**: mocks, testes reais multiusuário/multiprojeto, falhas e mobile, sem executar na VPS ou retirar interface clássica até a migração integral.

**Status:** plano persistido e gerenciável na branch, execução operacional não implementada. Nenhum PR/merge/deploy.

## Navegação MCP pelo GitHub Actions — código preparado (sem deploy)

- Operação `mcp_query` no broker `vpsops`: OIDC de `main`, workflow `vps-command.yml`, ator e repositório fixos, projeto `infrastructure` e política root-owned.
- Via Issue administrativa com título exato `[VPS] mcp-query` e corpo JSON. Exemplo: `{"repo":"Painel","tool":"repo_find_files","query":"executor","limit":10}`. Também pode ser disparada manualmente pelo workflow depois de instalada na `main`.
- Só ferramentas de navegação: `repo_list`, `repo_stats`, `repo_find_files`, `repo_find_symbols`, `repo_search_text`, `repo_dependencies`. O resultado público é projetado somente em estatísticas, caminhos, símbolos e números de linhas; **nunca previews nem conteúdo de arquivo**.
- `repo_read_file`, `repo_reindex`, edição de arquivos, comando shell, mutações Git, Docker e deploy são bloqueados. O token MCP fica exclusivamente na VPS, e o broker usa `127.0.0.1:8789`.
- O workflow na branch roda CI, **não acessa a VPS e não altera produção**. A ponte real exige revisão e liberação posterior na `main` e atualização do receptor por execução root explicitamente autorizada.
- Script manual `operations/upgrade-vpsops-mcp-query.sh check|apply <checkout_verificado>` preserva as outras operações; não é executado em CI.
