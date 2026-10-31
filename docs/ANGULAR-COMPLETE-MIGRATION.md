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
