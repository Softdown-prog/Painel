## 2026-11-07 — Erro de login: HTML na resposta da API

A tela Android exibiu `Unexpected token '<', '<!DOCTYPE' ... is not valid JSON` ao chamar
`/api/session`. O contrato exige JSON de sessão (`authenticated` e
`setupRequired` como booleanos). Uma página HTML não é erro de senha nem
prova de que o usuário esteja autenticado. Pode ser fallback de site,
challenge/rejeição do Access, falha de rede/túnel ou intermitência.

O frontend Angular agora exige resposta `application/json`, valida o formato
e exibe orientação sem mostrar a página HTML ou detalhes internos. A sessão
continua bloqueada quando a conexão não pode ser confirmada. O helper não
altera credenciais nem sessão.

**Diagnóstico real:** o workflow de produção da main `42370692925` reportou
sucesso na verificação de `/api/session` em 07/11, mas isso não garante
disponibilidade contínua nem o domínio exato da captura. Para novo incidente,
um probe externo sem autenticação do usuário consulta os dois domínios
documentados, registrando somente HTTP status, tipo da resposta e confirmação
dos dois campos de sessão. Não registra body nem cookies. Resultado público
pode ser transitório.

**SAC:** `sac-panel-angular.yml` faz checkout do SAC na revisão
`98ca6986b79fa81f6a1595fb8a6d4950c757fe86`, enumera fontes Angular
do Painel, executa os analisadores reais SAC-PRE001 a PRE005, e compila o
Angular por etapa oficial separada. O SAC estático não observa a API real,
Chrome/Android nem runtime. Falhas concretas de arquitetura, link ou parser
barram o job; achados `unverified` não são confundidos com aprovação
integral. Nenhuma API da VPS, credencial, runner self-hosted, Docker daemon,
merge ou deploy é acionado por esses checks.

O diagnóstico host-only existente em `server/diagnose-connection-vps.sh`
continua sendo o próximo passo se a conexão persistir indisponível.
Não relaxar Cloudflare Access ou abrir a API publicamente para corrigir HTML.

