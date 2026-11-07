# Publicação controlada do bridge Codex na VPS

**Objetivo:** concluir a atualização do serviço `vps-panel-codex` sem reiniciar API,
executor, PostgreSQL, túnel ou outros projetos. Não confundir o deploy da API do
Painel com o deploy separado do container Codex.

## Estado e imagem

A branch atual prepara uma imagem versionada do Codex CLI 0.167.0 e bridge
de monitoramento. O workflow
`.github/workflows/stage-codex-bridge.yml` testa código e isolamento em
GitHub Actions e, **somente após chegar à main**, publica a imagem imutável
`ghcr.io/softdown-prog/painel-codex@sha256:...`.
Esse workflow **não instala** a imagem nem modifica a VPS. Não chama o broker
administrativo, não usa chaves SSH e não altera o CODEX_HOME.

O deploy regular da API publica somente `api` e `executor`. Ele não atualiza
o serviço `codex-agents`. Um container saudável pode estar executando código
antigo; nunca confundir `healthy` com versão publicada.

## Requisitos antes do rollout

1. Confirmar todos os checks do PR, inclusive SAC Angular, Chromium E2E e
   `Codex agents (real isolated sandbox)`. Confirmar sucesso do workflow de
   staging na main e guardar o **digest exato** publicado no job.
2. Usar um terminal administrativo autorizado **na VPS** e conferir a
   configuração Compose realmente instalada: arquivos de configuração
   `com.docker.compose.project.config_files` do serviço `vps-panel-codex`,
   revisão atual, nome do projeto e lista de mounts/redes. Não confiar
   somente nos caminhos do checkout no GitHub.
3. Confirmar que o digest novo possui os labels
   `org.opencontainers.image.revision` da revisão em main e
   `org.opencontainers.image.source=https://github.com/Softdown-prog/Painel`.
   Não usar a tag `latest` nem reconstruir diretamente no host de produção.
4. Examinar `docker compose config` **antes** de aplicar. O serviço deverá
   manter UID/GID 61110, diretórios privados de CODEX_HOME, state e workspace,
   chave somente leitura, AppArmor `panel-codex`, seccomp fixo,
   `cap_drop: ALL`, sem `docker.sock`, sem portas publicadas, e limites
   de 1 GiB / 1,5 vCPU.
5. Subir **somente** `codex-agents` com `--no-deps --no-build --pull never`
   após a imagem por digest estar presente. Não utilizar `docker compose down`,
   `--remove-orphans`, `prune`, alteração de usuários ou recriação de volumes.
   Persistir a referência imutável nas configurações administrativas autorizadas
   para evitar que um próximo deploy da API restaure a imagem anterior.

**Este documento não executa o rollout.** A operação requer acesso aprovado
ao host e verificação das particularidades do Compose em produção. Não há
comando remoto arbitrário autorizado através do conector GitHub.

## Checagem pós-rollout

- O inventário OIDC da VPS deve confirmar `vps-panel-codex` running/healthy
  **e** digest/revisão esperados, sem alterações nos IDs dos outros containers.
- A aba `Agentes` deve receber `features.quotaWindows: true` de
  `/api/agents/status`. Se não receber, o frontend exibirá um aviso de bridge
  antigo; não declarar atualização concluída.
- Abrir `Uso e limites do Codex` na sessão administrativa e confirmar:
  `/api/agents/models` (modelos se a versão suportar), `/api/agents/usage`
  (janelas e timestamps), porcentagem restante e contagem regressiva.
- Testar um chat geral existente (sem alterar arquivos), depois uma tarefa
  de projeto autorizado e a retomada do histórico; não apagar
  `/srv/panel-codex/home`, `/state` ou `/workspace`.
- Conferir que a API pública não expõe o token da conta, IDs opacos de créditos,
  configuração privada, arquivos de projetos ou segredo do bridge.

Os dados de consumo são fornecidos pelo Codex autenticado. Não preencher
artificialmente janelas de 5h/7 dias ou horários de redefinição ausentes.
A interface só mostra `Créditos de redefinição disponíveis` se a conta
retornar uma quantidade numérica. Nenhum crédito é consumido pelo Painel.

## Reversão

Se a nova revisão não iniciar, usar **o digest anterior conhecido** do container
`vps-panel-codex` e retornar somente o serviço `codex-agents` à imagem
anterior. Os volumes existentes permanecem. Validar a restauração de saúde,
histórico e isolamento. Não assumir que um container que reinicia pode fazer
rollback de mudanças que já realizou em um clone; conferir `git diff` dos
workspaces autorizados.

## Evidência

- Histórico e monitoramento: `docs/CODEX-AGENTS-MONITORING.md`.
- Limites de segurança: `agents/SECURITY.md`.
- Build de staging: `.github/workflows/stage-codex-bridge.yml`.
- Teste real de sandbox: `.github/workflows/codex-agents.yml`.
