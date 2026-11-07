# Codex CLI e aba Agentes no Painel

**Estado em 07/11/2026: instalação em andamento.** CLI 0.167.0 construído na VPS,
login por navegador concluído e nove testes reais de isolamento aprovados. A
ativação do serviço, integração pública e CI desta revisão precisam ser conferidas
separadamente; os resultados de laboratório não provam que o chat esteja publicado.

## Fluxo

O Angular (/#agents) chama somente /api/agents/* com a sessão administrativa atual. A API encaminha rotas explícitas a um bridge privado via chave de 32 bytes. O bridge mantém um processo `codex app-server --listen stdio://` e conversa pelo protocolo JSON-RPC. Assim, nenhum terminal livre ou socket Docker fica acessível pelo navegador.

Além das conversas por projeto, a aba permite **Conversa geral (sem projeto)**.
O bridge cria o diretório dedicado `/workspace/Geral` e configura os turnos nesse modo
com política `readOnly`: a conversa geral não tem permissão de alterar repositórios,
executar publicações ou escrever nos arquivos do workspace. O Codex continua sendo
um agente voltado a programação, não uma réplica integral do ChatGPT (sem memória,
arquivos de outras conversas ou ferramentas da interface ChatGPT).

O agente só monta cópias dos projetos autorizados em `/srv/panel-codex/workspace/`. A versão inicial só suporta chat, lista de conversas, tarefas e cancelamento. Não há botão de deploy, merge, shell host nem aprovação de privilégios. O agente pode alterar arquivos **dessas cópias de trabalho**; revise o Git diff antes de transportar mudanças para outros serviços. A comunicação com os modelos requer internet. A política interna tenta bloquear rede para comandos de ferramentas, mas valide a aplicação real do sandbox no Docker.

## Pré-requisitos no Ubuntu host (operador autorizado)

- Docker Compose e espaço suficiente no host; API do Painel existente.
- Conta ChatGPT com acesso ao Codex, login por código habilitado nas configurações de segurança.
- Acesso SSH administrativo à VPS, sem colar credenciais em issue, prompt ou GitHub Actions.
- Não montar diretórios de produção, .env, tokens, chave do Painel, host /root ou docker.sock no workspace.

### 1. Preparar diretórios e segredo

Execute conscientemente pelo SSH do host:

```bash
sudo install -d -o 61110 -g 61110 -m 0700 /srv/panel-codex/workspace
sudo install -d -o 61110 -g 61110 -m 0700 /srv/panel-codex/home
sudo install -d -o 61110 -g 61110 -m 0700 /srv/panel-codex/state
sudo sh -c 'umask 027; openssl rand -hex 32 > /etc/softload-panel/agent-key'
sudo chown root:61110 /etc/softload-panel/agent-key
sudo chmod 0440 /etc/softload-panel/agent-key
```

O valor do segredo **nunca** deve ser mostrado no log ou na interface. O overlay reserva UID/GID 61110 exclusivamente para panelcodex (sem shell de login ou sudo; o UID 1000 desta VPS pertence a vpsops). Ele usa UID/GID 61110 para o processo Codex; confirme se há conflito com outros volumes ou usuários no seu host antes de aplicar.

### 2. Preparar projeto separado

```bash
sudo -u '#61110' git clone https://github.com/Softdown-prog/Painel.git /srv/panel-codex/workspace/Painel
```

Adicione outros projetos apenas como subdiretórios diretos e autorizados; mantenha um clone de desenvolvimento separado por projeto e usuário. O agente pode escrever nessas cópias. Para repos privados, faça clonagem com credencial temporária e remova-a do diretório de trabalho.

### 3. Construir o serviço e autenticar

A partir da raiz do checkout do Painel **com a branch de implantação autorizada**, confira o overlay:

```bash
docker compose -f server/compose.yaml -f server/compose.agents.yaml config --quiet
docker compose -f server/compose.yaml -f server/compose.agents.yaml build codex-agents
docker compose -f server/compose.yaml -f server/compose.agents.yaml run --rm --no-deps --entrypoint codex codex-agents login --device-auth
```

Abra no navegador do celular o endereço que a CLI mostrar e insira o código. Esse fluxo guarda as credenciais no volume privado `/srv/panel-codex/home`; não envie os códigos de autorização a terceiros. Não confundir Codex com a ferramenta `openai` CLI voltada à API REST.

**Versão:** o Dockerfile e overlay fixam 0.167.0; `PANEL_CODEX_VERSION` só deve ser alterada após validar o protocolo e sandbox. A imagem de produção é versionada por `PANEL_CODEX_AGENT_IMAGE`. Antes de iniciar, instale os perfis descritos em [SECURITY.md](../agents/SECURITY.md), após autorização administrativa. O API usa sua rede privada existente; nenhuma terceira rede é adicionada ao contrato de deploy.

### 4. Ativação (separada da instalação/login)

O overlay `server/compose.agents.yaml` também altera redes e mounts da API e, se aplicado, pode recriar o container da API. **Não** execute `up` em produção por conta deste documento. Homologue a configuração, a conectividade privada, a segurança e o login; depois ative em janela aprovada. Verifique sessões, `/api/agents/status`, criação de conversa, streaming por polling, interrupção, isolamento de projetos e limites de RAM.

## Limitações e manutenção

### Conta Google e login no servidor

Quem usa **Continuar com Google** mantém esse mesmo método na página oficial da
OpenAI. Não é necessário criar uma senha separada do ChatGPT. Nunca coloque a
senha do Google no Painel, no terminal ou em arquivos da VPS.

O fluxo beta por código não concluiu nesta instalação. A alternativa oficial por
navegador funcionou, com callback de localhost encaminhado por túnel SSH privado.
A senha foi digitada somente pelo usuário no provedor; os tokens ficam no
CODEX_HOME privado da VPS, UID 61110 e arquivos 0600. Nenhum token foi copiado
para o repositório, para o navegador do painel ou para os resultados de teste.

O `app-server` usa perfis nomeados de permissões da versão fixada; os campos
legados `readOnlyAccess`/`access` não garantem isolamento nessa versão. O teste
`agents/sandbox-smoke.mjs` verifica o protocolo real, leitura/escrita por projeto,
bloqueio de credenciais/estado e rede das ferramentas, sem chamar modelos.
O teste também abre conversas reais de protocolo, sem inferência. Conversa geral
usa `/workspace-general`, diretório vazio e somente leitura fora da árvore
privada dos projetos. Isso evita a falha da versão fixada ao reabrir um filho
read-only de um diretório negado, preservando a proteção de `/workspace`.

- Uma única tarefa ativa por vez. Não há conexão com docker.sock, ambiente real de produção, MCP de host ou vpsops.
- Até 100 conversas persistidas; histórico local limitado a 40 mensagens por conversa. O Codex também pode manter histórico próprio no CODEX_HOME.
- Se houver reinício durante uma tarefa, confira arquivos do workspace e `git diff` antes de tentar novamente; não assuma rollback.
- Não envie tokens/senhas via chat. Autenticação de Codex é feita fora do painel.
- O app-server utiliza o protocolo definido pela versão instalada; atualizações exigem testes de compatibilidade e revisão da imagem.
- Os diretórios com arquivos e credenciais devem ser acessíveis somente a operadores autorizados. Para reforçar o isolamento, o processo não recebe recursos de Docker host nem privilégios root.

## Verificação de estado

| Marco | Estado |
| --- | --- |
| Código Angular / API / bridge | PR #83 integrado, main `47932caf` |
| Testes unitários e CI | Oito testes do bridge + onze verificações reais de sandbox; sete checks verdes em `5a9e14df` |
| Deploy do frontend e da API | Pages publicado; API/executor `47932caf` instalados e saudáveis, confirmado por Docker e auditoria do host |
| Instalação e login Codex na VPS | CLI 0.167.0, imagem de código `5a9e14df`, login Google persistido com UID 61110 e modo 0600 |
| Chat com o serviço real | Resposta e escrita sintéticas aprovadas; login existente e resposta pela aba pública confirmados |

Em 07/11/2026, o navegador recebeu a resposta real “O chat do Codex no painel
está funcionando.” A tarefa isolada criou `CodexLab/smoke.txt` com
`CODEX-ARQUIVO-OK`. Outros projetos, Caddy, túnel e PostgreSQL foram preservados.
O serviço privado consumia cerca de 82 MiB ocioso, limitado a 1 GiB e 1,5 CPU.
O clone autorizado de desenvolvimento `Painel` está separado da produção.

A primeira publicação backend instalou a revisão e registrou recibo com
`exitCode: 0`, mas o Actions perdeu a conexão SSH antes de receber esse recibo.
Reexecutar o job inteiro gerou outra identidade e revelou `SameFileError` na
cópia de overlay da mesma revisão. Não foi alterado o broker root para contornar
isso. A correção do cliente recupera o recibo usando exatamente a mesma
solicitação autenticada; teste e publicação dessa correção têm status próprio.

Documentação da OpenAI: https://developers.openai.com/codex/app-server e https://developers.openai.com/codex/auth.
