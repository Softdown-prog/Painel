# Operações do Codex pelo Painel

Código em desenvolvimento na branch `feat/agents-operations-approval-20261107`.
Não confundir implementação/testes com ativação das operações na VPS.

O Codex não recebe SSH, sudo, Docker socket ou token GitHub. O app-server usa
quatro ferramentas dinâmicas da versão 0.167.0, atendidas por uma fila privada
no bridge. A API já autenticada consulta essa fila; não há callback novo exposto
à internet ou dependência de outro serviço de IA.

## Onde usar

Em **Agentes Codex**, escolha:

- **Conversa geral**: consultas de containers, recursos e repositórios cadastrados.
- **Administração da VPS**: mesmas consultas, mais propostas de comandos no
  terminal administrativo. A pasta desse modo é vazia e somente leitura.
- **Projeto**: edição da cópia autorizada e proposta de publicação em GitHub.
  Conecte o projeto a um repositório previamente cadastrado em Projetos GitHub.

## Comandos na VPS

O modelo propõe um comando e uma justificativa. A API confere o destino real e
o bridge o incorpora ao fingerprint imutável da proposta. Confira comando,
usuário e host antes de clicar **Aprovar uma vez**. O comando só então usa o
mesmo gerenciador SSH do Terminal VPS, compartilhando seus limites e trava.

A ferramenta devolve imediatamente um recibo de proposta **não executada**.
A espera humana não fica presa ao RPC nem ao turno do modelo: a proposta segue
disponível mesmo depois que o Codex termina sua resposta. Ao compartilhar a saída,
o bridge inicia uma continuação somente para interpretar os dados, com filesystem
somente leitura e novas ferramentas operacionais bloqueadas. Isso não repete o
comando. A UI acompanha operações pendentes mesmo com a conversa em repouso.

A saída tem redação auxiliar de credenciais, mas comandos livres podem produzir
dados sensíveis. Por isso a saída só retorna ao modelo depois de você revisá-la
e clicar **Enviar saída ao Codex**. Também é possível copiar ou não compartilhar.

Cada aprovação corresponde àquela proposta e destino; mudar o texto, destino
ou vínculo invalida a aprovação anterior. Recusar ou deixar expirar uma proposta
pendente não executa nada. Interromper uma tarefa solicita cancelamento, sem
prometer que processos remotos desvinculados terminaram.

Com o terminal em memória, reiniciar a API pode perder o acompanhamento de uma
tarefa. O agente recebe estado não confirmado e não repete o comando. O modo
persistente só é usado se já estiver habilitado; esta entrega não instala outro
supervisor nem muda o broker. O administrador deve conferir o Terminal VPS
antes de reenviar qualquer ação incerta.

## Publicações no GitHub

O bridge obtém o diff e os arquivos reais da cópia, sem executar hooks,
fsmonitor ou textconv do repositório. Bloqueia escapes por symlink, caminhos
privados, binários e padrões de segredo. O limite inicial é 30 arquivos e
128 KiB de conteúdo UTF-8 e 192 KiB de snapshot serializado. Uma operação com
efeito aguarda decisão por vez. Arquivos novos, alterações e exclusões aparecem na
revisão; a proposta mantém aquele snapshot, mesmo que a cópia mude depois.

A API define o destino pelo vínculo protegido em `/data/agent-projects.json`,
nunca por uma URL ou nome fornecido pelo modelo. O repositório também precisa
estar em `/data/github-repositories.json`, com proprietário e branch autorizados.
Depois da confirmação, cria um commit, uma branch `codex/panel-<id>` e um PR
**em rascunho**. Não faz merge nem escreve na main. Os workflows normais seguem
responsáveis por testes, revisão e publicação após o merge.

Falhas parciais não causam repetição automática de mutações GitHub. Se a API
reiniciar durante a publicação, confira branches/PRs antes de tentar novamente.
Cada proposta cria um PR separado; atualização automática de PR anterior e
sincronização de clones privados não fazem parte desta etapa.

## Instalação e reversão

`PANEL_CODEX_OPERATIONS_ENABLED=0` é o padrão, tanto no bridge como na API.
Prepare imagens e valide o Compose efetivo antes de habilitar em ambos. Preserve
os overlays locais, redes, volumes e chaves existentes. O Codex utiliza a mesma
identidade 61110 e os perfis AppArmor/seccomp já autorizados; o modo administrativo
não ganha acesso direto ao host.

A ativação exige atualizar o Codex e a API de forma compatível. Para reverter,
desabilite a flag em ambos, restaure as imagens anteriores e preserve todos os
volumes. Não reinicie outros projetos. Propostas pendentes não são reautorizadas
após reinício do bridge. As decisões guardam ID, fingerprint, conversa, projeto,
destino, horário e origem da aprovação no estado privado do bridge.

## Validações

- `agents/operations.test.mjs`: snapshots Git reais, symlinks, segredo, escopo,
  expiração, destino imutável, uso único e recuperação sem reexecução.
- `agents/bridge.test.mjs`: protocolo `item/tool/call` real no contrato simulado,
  incluindo IDs string e ausência de resposta antes da decisão.
- `server/agent-operations.test.mjs`: consulta, comando aprovado, revisão da saída,
  rejeição de outro projeto/destino, estado incerto e GitHub sem push na main.
- `agents/sandbox-smoke.mjs`: app-server/bubblewrap reais, incluindo os três modos,
  ferramentas dinâmicas e isolamento de arquivos/rede, sem inferência.
- `angular/e2e/agents-operations.spec.mjs`: aprovação, fingerprint atualizado,
  saída retida e conteúdo de diff inerte no Chromium, com API simulada.

Testes de laboratório não provam instalação. Os resultados de CI, ativação da
API, resposta real do modelo e ações realizadas na VPS/GitHub devem ser
registrados separadamente em `TAREFAS-CODEX.md` e no PR.
