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
