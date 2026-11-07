# Codex CLI e aba Agentes no Painel

**Estado: código experimental na branch, NÃO instalado na VPS.** Sem autenticação real no host, deploy autorizado e testes de integração, o status no painel continua indisponível.

## Fluxo

O Angular (/#agents) chama somente /api/agents/* com a sessão administrativa atual. A API encaminha rotas explícitas a um bridge privado via chave de 32 bytes. O bridge mantém um processo `codex app-server --listen stdio://` e conversa pelo protocolo JSON-RPC. Assim, nenhum terminal livre ou socket Docker fica acessível pelo navegador.

O agente só monta cópias dos projetos autorizados em `/srv/panel-codex/workspace/`. A versão inicial só suporta chat, lista de conversas, tarefas e cancelamento. Não há botão de deploy, merge, shell host nem aprovação de privilégios. O agente pode alterar arquivos **dessas cópias de trabalho**; revise o Git diff antes de transportar mudanças para outros serviços. A comunicação com os modelos requer internet. A política interna tenta bloquear rede para comandos de ferramentas, mas valide a aplicação real do sandbox no Docker.

## Pré-requisitos no Ubuntu host (operador autorizado)

- Docker Compose e espaço suficiente no host; API do Painel existente.
- Conta ChatGPT com acesso ao Codex, login por código habilitado nas configurações de segurança.
- Acesso SSH administrativo à VPS, sem colar credenciais em issue, prompt ou GitHub Actions.
- Não montar diretórios de produção, .env, tokens, chave do Painel, host /root ou docker.sock no workspace.

### 1. Preparar diretórios e segredo

Execute conscientemente pelo SSH do host:

```bash
sudo install -d -o 1000 -g 1000 -m 0700 /srv/panel-codex/workspace
sudo install -d -o 1000 -g 1000 -m 0700 /srv/panel-codex/home
sudo install -d -o 1000 -g 1000 -m 0700 /srv/panel-codex/state
sudo sh -c 'umask 027; openssl rand -hex 32 > /etc/softload-panel/agent-key'
sudo chown root:1000 /etc/softload-panel/agent-key
sudo chmod 0440 /etc/softload-panel/agent-key
```

O valor do segredo **nunca** deve ser mostrado no log ou na interface. O overlay assume UID/GID 1000 para o processo Codex; confirme se há conflito com outros volumes ou usuários no seu host antes de aplicar.

### 2. Preparar projeto separado

```bash
sudo -u '#1000' git clone https://github.com/Softdown-prog/Painel.git /srv/panel-codex/workspace/Painel
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

**Nota:** a imagem de desenvolvimento instala `@openai/codex@latest`. Para produção, fixe uma versão que tenha passado nos testes antes de construir e valide a saída de `codex --version`. Se o login por código não for aceito, confira as configurações da conta e a documentação oficial.

### 4. Ativação (separada da instalação/login)

O overlay `server/compose.agents.yaml` também altera redes e mounts da API e, se aplicado, pode recriar o container da API. **Não** execute `up` em produção por conta deste documento. Homologue a configuração, a conectividade privada, a segurança e o login; depois ative em janela aprovada. Verifique sessões, `/api/agents/status`, criação de conversa, streaming por polling, interrupção, isolamento de projetos e limites de RAM.

## Limitações e manutenção

- Uma única tarefa ativa por vez. Não há conexão com docker.sock, ambiente real de produção, MCP de host ou vpsops.
- Até 100 conversas persistidas; histórico local limitado a 40 mensagens por conversa. O Codex também pode manter histórico próprio no CODEX_HOME.
- Se houver reinício durante uma tarefa, confira arquivos do workspace e `git diff` antes de tentar novamente; não assuma rollback.
- Não envie tokens/senhas via chat. Autenticação de Codex é feita fora do painel.
- O app-server utiliza o protocolo definido pela versão instalada; atualizações exigem testes de compatibilidade e revisão da imagem.
- Os diretórios com arquivos e credenciais devem ser acessíveis somente a operadores autorizados. Para reforçar o isolamento, o processo não recebe recursos de Docker host nem privilégios root.

## Verificação de estado

| Marco | Estado |
| --- | --- |
| Código Angular / API / bridge | Proposto na branch |
| Testes unitários e CI | A conferir no PR |
| Deploy do frontend e da API | Pendente |
| Instalação e login Codex na VPS | Pendente |
| Chat com o serviço real | Pendente |

Documentação da OpenAI: https://developers.openai.com/codex/app-server e https://developers.openai.com/codex/auth.
