# Rollout do Codex na VPS — um serviço, um fluxo

**Objetivo:** atualizar apenas `vps-panel-codex` para que o chat Angular receba modelos,
histórico e uso real de 5h/7 dias. **Não** reinstalar API, executor, PostgreSQL,
Cloudflare, túnel, nem projetos hospedados. Um container saudável pode servir uma revisão antiga.

## Como a publicação funciona

A fonte é `agents/`, com CLI **fixo em 0.167.0**, e a **única** CI do Codex é
`.github/workflows/stage-codex-bridge.yml`. Ela roda os testes reais do bridge
e do sandbox AppArmor/seccomp sem conta/credenciais, publica a imagem em
`ghcr.io/softdown-prog/painel-codex@sha256:...` e registra o digest imutável.

A atualização do host é um **segundo job no mesmo workflow**, desabilitado por
padrão. Não se deve misturar este job com o deploy regular da API. Para ativá-lo:

- Na primeira utilização, um operador root da VPS deve instalar **somente a capacidade
  Codex** no broker vpsops existente, a partir de um checkout confiável da `main`,
  usando `sudo bash operations/upgrade-vpsops-codex.sh /caminho/para/Painel`.
  O script confere política, arquivos e identidade esperados, sem executar Docker
  `up`, sem modificar `/srv/panel-codex`, SSH/sudoers, segredos ou containers.
- No GitHub Actions, configurar o ambiente protegido `vps-maintenance` com
  aprovadores obrigatórios. Executar **Test, stage and optionally deploy pinned Codex bridge**
  via `workflow_dispatch` na `main` e marcar `activate=true`.
  Alternativamente, após a primeira instalação bem-sucedida, habilitar a variável
  `PANEL_CODEX_DEPLOY_ENABLED=true` para realizar rollouts em commits de
  `agents/**`. Sem essa variável, pushes apenas criam imagens, não atualizam a VPS.
- O job usa somente a identidade OIDC e o executor privado já existente; ele
  rejeita projeto não registrado, branch diferente de main, imagem não imutável,
  SHA não autenticado e binário Codex diferente do fixado.

O workflow não abre SSH de shell arbitrário. A operação `deploy` está
restrita ao projeto `panel-codex` e ao serviço `codex-agents`.

## Verificação prévia e isolamento

O adaptador `operations/codex.py` usa **os Compose efetivos do container
`softload-panel-api`** (não inventa caminhos nem procura um Docker alternativo).
Antes de alterar qualquer configuração, exige:

1. API e Codex saudáveis, no projeto Compose `softload-panel` e com os nomes
   de serviços registrados; imagens atuais alinhadas à configuração instalada.
2. Um único `compose.install.yaml` root-owned, com `compose.agents.yaml`
   e todos os overlays apontando para o checkout canônico atual.
3. UID/GID 61110; raiz read-only; `cap_drop: ALL`; sem portas públicas,
   privilégios, recursos extras nem Docker socket; limites 1 GiB, 1,5 vCPU,
   128 PIDs; AppArmor `panel-codex` e seccomp fixo.
4. Os **quatro** mounts previstos e nenhum outro bind:
   `/srv/panel-codex/workspace`, `home`, `state` e a chave
   `/etc/softload-panel/agent-key` **somente leitura**.
5. A imagem nova em digest `sha256:` com labels de origem e revisão do
   commit autenticado, aprovada pelo teste de admissão **sem credenciais**.

Somente então o adaptador grava atomicamente a referência nova no overlay
administrativo e faz `docker compose up -d --no-deps --no-build --pull never codex-agents`.
Isso não usa `down`, `prune`, `remove-orphans`, `restart` dos outros
serviços ou alteração dos volumes persistentes. O overlay aprovado será copiado
pelos próximos deploys regulares da API, evitando regressão para a imagem antiga.

O instalador exige coincidência de IDs dos demais containers antes e depois.
Se o serviço não iniciar, a imagem ou a saúde não corresponderem, restaura
o overlay anterior e executa rollback **somente do Codex** usando a imagem
já existente localmente. Caso a configuração real divirja, para sem improvisar.

## Como confirmar o resultado

Confira o recibo do workflow (`vps-result.json`) e um inventário novo
(`[VPS] inventory`). É necessário ver `vps-panel-codex` running/healthy
com o **SHA novo** e outros containers com os mesmos IDs.

No Painel, em `Agentes`, verificar `features.quotaWindows: true` em
`/api/agents/status`, histórico e seleção de modelo. A conta autenticada
deve fornecer `/api/agents/models` e `/api/agents/usage`, janelas de 5h/7 dias
e timestamps reais. Não inventar franquia, percentuais, créditos ou datas
de renovação. A CI é sintética; ela **não comprova** os limites verdadeiros
da conta ou operações autenticadas em projetos.

O estado em `/srv/panel-codex/home`, `/srv/panel-codex/state` e
`/srv/panel-codex/workspace` não deve ser apagado. O Codex pode executar
tarefas e ter turnos em andamento; escolher uma janela de atualização
que não interrompa o trabalho.

## Se o rollout for bloqueado

Uma falha de admissão deixa a produção inalterada. Se o Codex antigo estiver
vinculado a um arquivo Compose diferente do canônico ou tiver outro perfil de
segurança, o operador deve reconciliar **antes** de atualizar, sem desabilitar
AppArmor/seccomp e sem conceder um terminal genérico à CI.

## Fontes locais

- `agents/SECURITY.md` — política do sandbox.
- `docs/CODEX-AGENTS-MONITORING.md` — modelos e limites.
- `operations/test_codex.py` — isolamento, OIDC, rollback e proibição de alteração de outros serviços.
- `.github/workflows/stage-codex-bridge.yml` — testes, imagem e deploy opcional.
