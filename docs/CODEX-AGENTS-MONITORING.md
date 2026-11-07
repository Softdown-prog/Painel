# Modelos, raciocínio, histórico, quotas e GitHub no chat Codex

## Implementação

A integração existente é **Codex CLI 0.167.0 + app-server sobre stdio**, e não
o SDK Node/TypeScript. O serviço fica no container Codex, sem publicar portas;
o navegador chama apenas /api/agents/* após autenticação no Painel.

### Configurações de modelo

- GET /api/agents/models encaminha model/list e config/read ao processo já
  autenticado, mas filtra para somente id/nome do modelo, esforços disponíveis,
  esforço padrão e configurações de modelo do servidor. Não envia providers,
  configurações completas, autenticação, credenciais nem caminhos.
- POST /api/agents/threads aceita model + effort **somente** quando o par existe
  no catálogo anunciado. A seleção é salva junto da conversa e enviada em
  turn/start de cada mensagem. POST /threads/<id>/settings altera apenas as
  mensagens futuras; só permite níveis anunciados para aquele modelo.
- Com modo automático, o servidor escolhe seu próprio modelo. O Painel informa
  a configuração efetiva de config/read apenas se estiver disponível.
  model/list NÃO é prova de que a conta tem acesso a todos os modelos: uma
  inferência concluída confirma acesso naquele turno.
- Modelos, esforços e defaults não são hardcoded no frontend. Se model/list
  falhar no CLI fixado, o chat continua no modo automático e as opções de
  seleção são desabilitadas, sem inventar catálogo.

### Uso e limites

- GET /api/agents/usage consulta account/rateLimits/read e
  account/usage/read; expõe só janelas, percentual consumido, timestamps de
  renovação e atividade de tokens/dias, se conhecidos.
- A interface só chama uma janela de **7 dias** quando o serviço retorna
  windowDurationMins = 10080. Janela ausente vira "não informado" — nunca
  assumir 0% nem 100%. Cache 60 s no bridge e botão de atualização.
- Dados da conta Codex podem incluir uso por outras interfaces. O evento
  thread/tokenUsage/updated fornece contagem separada quando disponível.
- Tokens **não representam cobrança em reais**. Nenhum cálculo de dinheiro
  ou tarifa foi adicionado. Se uma RPC não existir nesta versão, a interface
  mostra não disponível e o chat continua funcionando.

### Histórico

- As conversas armazenadas no volume privado existente permanecem presentes.
  A lista mostra título, projeto, atualização e filtro textual. O título inicial
  é preenchido com a primeira mensagem e pode ser renomeado explicitamente.
- A implementação prévia retém no bridge até 100 conversas e as últimas
  40 mensagens por conversa; esta alteração preserva o mesmo volume e limites,
  sem apagar histórico nem importar conversas externas automaticamente.
- Os históricos anteriores mantêm datas não informadas quando não havia
  registro, para evitar datar conversas antigas como se fossem novas.
- A recuperação de mensagens anteriores às 40 retidas não é garantida nesta
  entrega. O app-server guarda também rollouts próprios em CODEX_HOME, mas
  importá-los exigiria migração com paginação e controle de autorização,
  não leitura arbitrária do volume por HTTP.

### GitHub e trabalho em projetos

- GET /api/agents/projects/check (administrador autenticado, operações
  habilitadas) confirma via API GitHub /user se o token vigente é autenticado
  e, por repositório cadastrado, se a leitura é possível e se a API informa
  permissão de push. Consulta também o cadastro dos projetos da API e a
  disponibilidade do diretório do projeto pelo bridge.
- Verificar conexão não executa comandos no host, não faz commit, push, PR
  ou alteração em arquivos. É diagnóstico read-only, não prova que o Codex
  produziu um PR ou compilou o projeto. Ações de publicação continuam usando
  aprovação explícita e a API protegida.
- Se não houver token GitHub montado na API, ou não houver operações habilitadas,
  informar o status como não confirmado. O chat ainda pode examinar os clones
  de código autorizados na sandbox; não recebe diretamente credenciais GitHub.

## Validar antes de publicar

- Console CI: testes Node e TypeScript, build Angular, testes Chromium.
- Codex agents: testes do parser e bridge, sandbox smoke real da CLI fixa
  0.167.0 em Docker, sem token e sem inferência.
- GitHub API: teste unitário com respostas sintéticas. O usuário poderá
  executar o diagnóstico autenticado na interface depois do deploy.
- Para verificar quais modelos, esforço e limites efetivos a conta oferece,
  precisa executar essas RPCs **no Codex autenticado da VPS**. CI offline não
  representa acesso à conta real nem garante compatibilidade de RPCs novas.
- Não subir a versão do Codex sem validar as políticas de permissão e o
  sandbox AppArmor/seccomp. Não substituir esse chat pelo Agents SDK ou pela
  API pública só para apresentar controles.

Documentação oficial:
https://developers.openai.com/codex/app-server
https://developers.openai.com/codex/config-reference
