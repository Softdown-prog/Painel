# Operações do Codex pelo Painel

Implementação integrada pelos PRs #85/#86. Na VPS, `f3046f6` passou no teste
real de `uptime` (exit 0, saída liberada e interpretada pelo modelo) e criou
o draft PR #87 com um único arquivo de teste; ele foi fechado sem merge.
Atualizações posteriores de API, UI e sidecar têm validações separadas.

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

### Autorizar a conta uma vez

Em **Agentes Codex → Meus repositórios GitHub**, o administrador pode autorizar
todos os repositórios pertencentes à conta autenticada pela conexão existente.
A API confirma `/user`, salva ID/login e descobre os repositórios públicos e
privados que aquela credencial pode ler. Não amplia permissões do token/App,
nem altera permissões de deploy, Docker ou cadastros de outros módulos.
Trocar para outra identidade GitHub invalida essa autorização até reconfirmar.

Escolher **Abrir no Codex** prepara somente o repositório selecionado, em sua
branch padrão. Credenciais permanecem na API: o bridge recebe apenas o arquivo
da revisão GitHub fixada, por rede privada autenticada. Importação recusa
travessia de caminhos, links, arquivos especiais e `.git`; limita o arquivo
compactado a 32 MiB, a cópia a 128 MiB/8.000 entradas e mantém até 32 cópias.
Não instala dependências, não executa scripts do repositório e não sobrescreve
cópias existentes. Repositórios grandes ou com links exigem tratamento separado.

A cópia tem baseline Git local, sem importar todo o histórico remoto. A origem
real e seu SHA ficam no estado privado, fora do alcance do modelo; a publicação
usa esse SHA real e inclui alterações desde o baseline, inclusive commits locais.
O modelo continua vendo apenas seu projeto. Novos perfis são carregados reiniciando
somente o subprocesso app-server, sem encerrar outros containers nem apagar chats;
a preparação é recusada enquanto houver um turno do modelo em execução.

O botão autoriza a conta, mas não clona todos os repositórios. Descoberta é
paginada; pesquisas na interface filtram os repositórios já carregados. O cadastro
anterior por repositório continua compatível, assim como os PRs em rascunho e a
aprovação individual do diff. A origem de uma cópia importada não pode ser
substituída por outro vínculo.

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
