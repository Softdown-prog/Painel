# Recuperação do Painel VPS e instalação independente

## Causa e evidências

O domínio principal e o alternativo retornavam HTTP 502 em `/api/session`.
A API estava `Created`, com `StartedAt` zerado, PID 0, sem OOM e sem reinícios.
O executor estava saudável e o túnel conectado. Os logs do túnel mostravam
`lookup softload-panel-api ... no such host`: não havia API em execução para
resolver pelo nome na rede Docker. Não há evidência suficiente para afirmar
quem deixou o container criado sem iniciá-lo.

O comando limitado a `docker start softload-panel-api` restabeleceu HTTP 200
nos dois endereços, com `authenticated: false` e `setupRequired: false`.
Nenhuma mudança de DNS, Access ou credencial foi necessária. A publicação do
PR #17 já existia no Pages; ela não tinha iniciado a API no host.

## Versões instaladas

| Componente | Identificação |
| --- | --- |
| Código do backend | PR #18, `5fdcc96a167b17ccf3c422d51ec9e522b0de66bb` |
| Merge / frontend e Function | `e09a22c1be1a5ec124b1b39bc1169d464926edd7` |
| Imagem da API | `vps-panel-api:5fdcc96a167b17ccf3c422d51ec9e522b0de66bb` |
| ID Docker da API | `sha256:22e1228aeb7a30cf2d2f17f0982937bad18f23f027eeadc314014940e93019c6` |
| Imagem do executor | `vps-panel-executor:5fdcc96a167b17ccf3c422d51ec9e522b0de66bb` |
| ID Docker do executor | `sha256:b0ae18bd2bdb5ad85ee193508c226eb04c2e5d728af5496920ba087842ff89d3` |
| Túnel, imagem preservada | `sha256:faa8e0a1475f137c910be6025f43c8e4092fdd35461b31e19fd1390657a1ff39` |
| Diretório de execução | `/opt/vps-panel/current` |
| Registro privado dos argumentos Compose | `/etc/softload-panel/compose-production-files.json` |
| Variáveis operacionais preservadas | `/etc/softload-panel/runtime.env` |

O diretório de execução aponta para `releases/<SHA>/server`. Os arquivos vieram
do GitHub por revisão fixa, sem `.env`, tokens ou dados dentro do contexto de
build. As imagens foram preparadas antes da troca; não houve limpeza de imagens
nem backup volumoso. Os IDs anteriores permaneceram disponíveis para reversão.

### Overlays preservados

Base `compose.yaml`, aplicações, GHCR, GHCR privado, GitHub, projetos, releases,
revisões, SSH, publicações, segredos e roteamento: os mesmos 12 arquivos efetivos
da instalação anterior, mais `compose.install.yaml` para imagens versionadas e
labels de revisão. O túnel mantém seu projeto Compose separado.

API e túnel compartilham **somente `vps_panel_control`**. O executor está em
`network_mode: none`, com o socket Docker restrito a ele. A API monta apenas o
socket Unix filtrado e não publica portas. `PANEL_SOFTLOAD_LEGACY=0` na API e no
executor; não há montagem de arquivos de projetos hospedados. Recursos, conta,
volumes `softload_panel_data`/`softload_panel_executor_socket`, chaves e labels
existentes foram preservados.

### Condições tratadas durante a troca

A primeira tentativa foi revertida automaticamente: `up executor --no-deps`
não criou a rede da API, então a conexão do túnel à rede inexistente falhou.
O executor foi restaurado e a API recuperada permaneceu disponível. A segunda
tentativa preparou a rede explicitamente e ativou os componentes corretamente.

O túnel precisou ser recriado para persistir a rede nova. Isso revelou o token
`root:root/0600`, inacessível ao usuário não root da imagem. A permissão foi
ajustada para `root:65532/0440`, preservando o conteúdo, e o túnel foi reiniciado.
O Compose agora explicita essa identidade. Não foi ampliada a leitura para outros
usuários, nem alterada a proteção Access.

## Cloudflare preservada

- Projeto Pages `softload-vps-panel`, domínio `panel.analysepro.com` e alternativo
  `softload-vps-panel.pages.dev`.
- Origem privada `panel-api.analysepro.com`, DNS CNAME proxied para o túnel existente.
- Túnel encaminha para `http://softload-panel-api:8080`, com verificação Access
  exigida; sem localhost nem IP transitório de container.
- Política Service Auth (`non_identity`) com o token de serviço existente, válido.
- Os três bindings secretos de produção estavam presentes e não foram trocados.
  As respostas HTTP públicas válidas comprovaram a combinação funcional; os valores
  secretos não foram lidos do Pages nem publicados. `PANEL_API_ORIGIN` não é necessário
  nesta instalação, que usa a origem privada padrão.
- Origem privada anônima continua HTTP 403. Consultas administrativas sem sessão
  pelo Pages continuam HTTP 401. Isso é proteção, não indisponibilidade.

## Validações de código e infraestrutura

- PR #18: [143 testes Linux e gates aprovados](https://github.com/Softdown-prog/Painel/actions/runs/41040217286),
  [Docker real isolado aprovado](https://github.com/Softdown-prog/Painel/actions/runs/41040217261).
- Merge: [Console CI](https://github.com/Softdown-prog/Painel/actions/runs/41104565927),
  [Docker real](https://github.com/Softdown-prog/Painel/actions/runs/41104566131) e
  [publicação Pages](https://github.com/Softdown-prog/Painel/actions/runs/41104566462)
  aprovados. A configuração do Pages confirmou o SHA publicado.
- `npm install --no-audit --no-fund`, typecheck, build frontend e `check:js`
  executados no computador. A suíte completa no Windows encontrou limitações de
  sockets Unix, permissões/symlinks POSIX e caminho `file:` do teste isolado;
  nenhum teste foi desativado. O CI Linux passou integralmente.
- Dez testes desses componentes passaram também em container Linux descartável,
  com filesystem somente leitura, limites, sem rede externa, sem socket Docker
  e sem volumes de produção. Incluíram login/persistência sem Softload e sem
  executor, política Unix, inventário e armazenamento privado de chaves.
- Compose completo validado: mesma lista de overlays e volumes, sem dependência
  de saúde do executor para login, sem montagem da Softload e sem portas públicas.
- Probe HTTP interno e pelo DNS Docker responderam com o contrato real da sessão.
- API/executor saudáveis; túnel ativo, sem novos reinícios após corrigir a leitura
  do token. Os projetos hospedados e Caddy mantiveram IDs/imagens/horários de início
  durante a migração. Conta administrativa conferida por hash antes/depois.

### Validação administrativa pelo navegador

A conexão anônima, o formulário real e a ausência de erros JavaScript foram
confirmados no Microsoft Edge. A sessão autenticada e os testes de inventário,
indicadores, registros e terminal serão registrados abaixo somente após o login
na janela de validação, sem obter ou gravar a senha.

## Reversão restrita ao Painel

Referências anteriores preservadas:

- API `softload-panel-api:1`, ID
  `sha256:01646d1af0835e6eebf3e60e48028c2aaee7b26c990fa53315b2320cc720209d`.
- Executor `softload-panel-executor:1`, ID
  `sha256:7b619789a67043f67e356149c202ef516e2e8614f511bec708f9da3ccf8f8267`.
- Compose anterior em `/opt/softload-infra/panel`, com os 12 overlays registrados.

Se for preciso reverter, o administrador usa essa composição completa para
recriar **apenas API e executor**, preserva os volumes e coordena o túnel com a rede
antiga. Não executar `down -v`, prune, reset de conta nem comandos nos projetos.
Conferir os IDs das tags antes: tags mutáveis não substituem os IDs registrados.
Não reverter apenas a rede da API ou apenas a do túnel. O retorno à interface
anterior usa rollback do deployment Pages existente, sem alterar seus secrets.

As rotinas do painel continuam sujeitas às políticas existentes: inventariar um
container externo não dá permissão automática para administrá-lo. A migração
não cadastrou aplicações novas, não apagou projetos e não executou publicações.
