# SAC-008A — GitHub Actions → One Worker (somente leitura)

**Nenhuma API HTTP nova.** Reusa o `operations/client.py` do Painel: GitHub Actions em `main` obtém OIDC com audience existente, conecta por SSH com comando forçado `operations-v1`, e o broker root-owned valida assinatura, ator, repositório, branch, workflow e operação.

Em `.github/workflows/vps-command.yml`, apenas workflow_dispatch com `operation=sac_worker` / `sac_action=status|report` ou issues do proprietário com título literal `[VPS] sac-status` / `[VPS] sac-report` são encaminhados. O usuário consegue solicitar esses relatórios via GitHub MCP criando uma Issue com o título exato **depois que a integração for revisada, mesclada e instalada na VPS**.

O módulo `operations/sac_worker.py` lê **somente** o checkpoint do Worker Data Library no caminho fixo `/var/lib/data-library-worker/state` e o `summary.json` associado ao run_id validado. Projeta apenas contagens seguras, SHA da revisão e estado do ciclo; nunca retorna logs, stdout, código, arquivos livres, variáveis, credenciais ou segredos. `serviceRunning=unknown` é deliberado: checkpoint não prova que o serviço está online.

**Limites:**
- Esta entrega é o *primeiro microestágio* SAC-008A: **status e relatório**. Nenhum campo `command`, `run`, `project` ou path arbitrário é autorizado. Não dispara compilação de projetos externos; a fila multiprojetos e a ação explícita de solicitar validação são SAC-008B, ainda não implementadas.
- O serviço `scripts/vps_daemon.py` da Data Library permanece inalterado; não roda novos projetos, nem executa script recebido pelo Actions. SAC-007 continua provando apenas recibos offline.
- Código desta branch não é o mesmo que o broker instalado: um **upgrade manual de código e política root-owned** deve ser revisado separadamente antes de chamar a VPS. Não foi realizado upgrade, merge ou acesso à VPS.
- O workflow `SAC-008 Actions-to-Worker bridge` executa testes offline, sem segredos e sem contato com VPS.
- O status é limitado ao *Worker Data Library existente*, não ao conjunto de projetos Angular. Não tratar resultado de um catálogo como `browser_pass` ou autorização de deploy.

Próxima etapa segura: permitir ao One Worker receber somente jobs de projetos previamente registrados, por SHA fixo e sandbox próprio; depois expandir Actions a `request-validation` e `get-job-report`, sem abrir shell.


## SAC-008A: diagnóstico de instalação / broker (02/11/2026)

Duas chamadas somente leitura confirmaram a diferença entre **broker funcional**
e **operação SAC não instalada/autorizada**:

- [Issue #75 – sac-status](https://github.com/Softdown-prog/Painel/issues/75):
  OIDC/SSH chegam ao broker, porém retorna
  \`{"exitCode":1,"error":"ValueError: request rejected"}\`.
  A resposta é anterior ao módulo SAC e **não prova** que ele esteja ativo.
- [Issue #76 – inventory](https://github.com/Softdown-prog/Painel/issues/76):
  autenticação do mesmo ator, branch \`main\` e workflow funciona e retorna
  inventário real. Assim o problema está no **gate/versão instalada de
  \`sac_worker\`**, não no transporte SSH em geral. O caminho exato de
  rejeição no host não é recuperável pelo relatório público.

O workflow normal \`deploy-vps.yml\` **só publica contêineres**; não troca
o broker root-owned em \`/usr/local/lib/vps-operations\` nem a política privada
\`/etc/vps-operations/policy.json\`. Por isso GitHub Actions verde **não
significa** que o upgrade foi instalado.

### Microetapa: atualização manual e controlada (sem execução automática)

O procedimento \`operations/upgrade-vpsops-sac-worker.sh\` aceita \`check\` ou
\`apply\` e uma checkout local previamente revisada com **SHA completo
fixo**. Os comandos abaixo são destinados exclusivamente a operador
administrativo na VPS, após aprovação específica:

\`\`\`bash
sudo bash operations/upgrade-vpsops-sac-worker.sh check /checkout/Painel <SHA-REVISADO>
# Somente após revisão humana do resultado:
sudo bash operations/upgrade-vpsops-sac-worker.sh apply /checkout/Painel <SHA-REVISADO>
\`\`\`

- \`check\` apenas lê a instalação e gera um resumo seguro, sem alterar
  arquivos, contêineres, processos, credenciais ou permissões SSH.
- \`apply\` exige root, checkout limpo no commit aprovado, arquivos e política
  do broker com dono/modo verificados; atualiza somente
  \`receiver.py\`, \`sac_worker.py\` e a entrada limitada \`sac_worker\`
  da política. O handler é instalado **antes** da autorização.
- Preserva explicitamente outras operações, especialmente \`sac_submit\`
  (que continua desabilitada onde já estiver desabilitada), \`mcp_query\`,
  manutenção e acesso a contêineres. Recusa divergência de política ou
  caminho instalado desconhecido e tenta restaurar o estado anterior se
  ocorrer exceção.
- Nenhum workflow aciona o comando \`apply\` e **nenhum deploy, merge ou
  mudança na VPS foi realizado por esta entrega**.
- Depois da instalação aprovada, o teste de aceitação é repetir
  \`[VPS] sac-status\` e somente então consultar \`[VPS] sac-job\`.
  \`status\` baseado em checkpoint **não prova que o daemon esteja online**.

O instalador prepara a autorização somente leitura do broker, não inicia
o serviço Data Library, não corrige possíveis erros de configuração do
SAC Builder e não autoriza compilação nem deploy de terceiros.

### Revisão do preflight de leitura (02/11/2026)

O script `check` valida a sintaxe com `ast.parse` em memória, em vez de `py_compile`, que pode escrever arquivos `__pycache__`. A presença de `sac_submit` desativado na política instalada não exige que `sac_submit.py` esteja instalado; uma operação `sac_submit` ativa continua exigindo o handler correspondente. Essas duas situações têm testes de regressão e não ampliam as permissões do broker.

**Limitação operacional:** o broker SSH existente não tem uma operação autorizada para rodar `check` como root pela integração GitHub. O teste realizado via `[VPS] inventory` confirmou a conexão, mas não inspecionou a política root-owned nem instalou o SAC. Não é seguro usar a operação `inventory`, `mcp_query` ou comandos arbitrários como alternativa para executar `check`.

## Instalação real do broker — 02/11/2026

O registro abaixo atualiza o estado operacional descrito nas seções anteriores.
O acesso SSH administrativo independente do computador foi confirmado no host
`softloadeng`; nenhum runner ou operação restrita foi usado como atalho root.

### Causas comprovadas e correção

- Antes: módulo `sac_worker.py` ausente, operação fora da lista permitida do
  repositório 1433232532 e seção `sac_worker` ausente na política instalada.
  A rejeição ocorria antes do handler, apesar do Data Library Worker ativo.
- O upgrade preparado ainda tinha uma falha de CLI: o wrapper passava modo e
  checkout (dois argumentos), mas Python exigia três. A revisão
  `64f0b1973e0a0203a01446efdcd48bfdfebd09e6`, PR #78, corrige esse contrato e
  testa argumentos inválidos e recusa sem root.
- Check e apply reais foram executados em checkout limpo nesse SHA, sob as
  travas de infrastructure/panel/terrania/terrania-go-shadow, com cópia temporária
  privada de receiver/política para reversão. Não houve restart de containers.

### Instalação comprovada

Somente receiver e handler SAC foram substituídos. A comparação estrutural da
política confirmou apenas a adição de `sac_worker`; hashes dos outros módulos
foram preservados, inclusive driver, admission, shadow, maintenance e code_mcp.
`sac_submit` não foi autorizado. Nenhuma credencial, chave SSH ou regra de rede
foi modificada. Os três estados módulo/operação/habilitação agora são verdadeiros.

| Módulo instalado | SHA-256 |
| --- | --- |
| receiver.py | 123d593a54f520a32b81dd49fac21de3225a95afb59bd767875b7d9ae5247f1a |
| sac_worker.py | 40bfe6ec1e976a86afb648c6807aa14f0831b844d8a8af43e5f2b4bae04a9a08 |

### Evidências GitHub → VPS → GitHub

- [Status 41498651912](https://github.com/Softdown-prog/Painel/actions/runs/41498651912): exit 0, resumo real disponível.
- [Relatório 41498805547](https://github.com/Softdown-prog/Painel/actions/runs/41498805547): exit 0, 21 itens concluídos, 21 pass, 0 fail, 0 compile-only.
- [Issue #77, repetição bem-sucedida](https://github.com/Softdown-prog/Painel/issues/77#issuecomment-6584755258): o run anteriormente rejeitado passou na tentativa 2. O comentário com JSON real foi recuperado pelo conector GitHub deste chat.
- O workflow usa main `d849c43bae7e9ebc4da977aad0ab0c63d69eb696`; os módulos root estão no SHA de implementação acima. São revisões de camadas diferentes.
- O checkpoint consultado é da Data Library, revisão `b57624ecf4b9f6781ca66ff7750bef31dac38dde`, ciclo `1793628204-8965b33c2f7dbc2a`. Não representa teste de browser nem autorização de deploy de outros projetos.
- `systemctl is-active data-library-worker.service`: active, consultado separadamente. O contrato público mantém `serviceRunning=unknown`, pois o checkpoint sozinho não comprova saúde do processo.
- A chave SSH do terminal, usada a partir da API do Painel para `uptime`, retornou exit 0. Os 12 IDs de containers foram preservados; containers com healthcheck estavam healthy.

**Validações de código:** 78 testes Python no Ubuntu como nobody; Console CI
41498460199 com 114 testes Python e 273 Node aprovados (1 ignorado, 0 falhas),
mais E2E Angular, Rust, Docker admission, fila e bridge SAC aprovados. Typecheck,
build:frontend e check:js locais aprovados. Frontend não alterado; API/executor
Docker não foram atualizados para instalar o broker. O PR mantém o histórico e
o instalador auditável; não se deve confundir seu merge com instalação root.
