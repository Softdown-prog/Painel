# Migração incremental para hospedagem multiprojetos

## Diagnóstico de produção — 27/10/2026

Inspeção somente leitura na VPS antes da correção: `softload-vps-app-1` e
`softload-vps-agent-1` estavam parados por inatividade, `softload-wake` estava
saudável, mas `https://softload.analysepro.com/` retornava HTTP 502.

As falhas tinham causas distintas:

1. O gateway `/opt/softload-infra/scale-zero/gateway.mjs` ainda exigia Sandbox e
   Embeddings para acordar o grupo. Os dois containers já foram removidos. A
   correção limitou o grupo a Agent e App. Backup do arquivo anterior:
   `gateway.mjs.backup-20261027T214759Z` (SHA-256
   `9f9f1c1cf0cc3f9fc10a8e735baba587397952fb7d355e50ee3d99057a2b99bc`).
2. O Caddy de produção encaminhava diretamente para `softload-vps-app-1:8080`.
   O nome deixa de resolver quando o container dorme; o log do Caddy mostrou
   `lookup softload-vps-app-1 ... no such host`. O upstream foi alterado para
   `softload-wake:8080`, mantendo TLS e o rewrite do webhook. Backup do arquivo
   anterior: `softload-production.caddy.backup-20261027T214905Z` (SHA-256
   `0058adeb1ad93b13efac911608e738bbb7be4282a5e6451b94863af8e0c7907b`).
3. O receptor SSH instalado já aceita `contract:v2`; essa falha anterior não é
   a causa do deploy mais recente. O workflow `40562901405` falhou na
   transferência de uma imagem App de 386.858.773 bytes: `rsync` via SSH
   interrompeu repetidamente em torno de 6 MB, a 30–50 kB/s. Não há evidência
   nesse run de erro de checksum ou de ativação na VPS. O transporte precisa
   ser corrigido antes de repetir uploads grandes.

Após a correção, `caddy validate` passou, o Caddy recarregou, a primeira
requisição pública acordou Agent e App em aproximadamente 17 segundos e
respondeu HTTP 200. Ambos ficaram saudáveis. Portainer, DNS, volumes e
outros projetos não foram alterados.

### Reversão da correção operacional

Os dois backups estão ao lado dos arquivos originais na VPS. Se necessário,
restaurar o arquivo do gateway, reconstruir apenas `softload-wake`, restaurar o
arquivo Caddy, executar `caddy validate` e recarregar o Caddy. Essa reversão
reintroduz o 502 durante o sono e deve ser usada somente diante de uma falha
nova comprovada.

## Etapa 1 — Registro de projetos

`projects.json` agora aceita uma lista de serviços por projeto. Cadastros
antigos são lidos como um serviço principal sem regravar o arquivo. O endpoint
`PUT /projects/:slug/services` associa e desassocia containers já pertencentes
ao Painel; nunca para ou apaga containers. Ele verifica a posse de novas
associações, recusa um mesmo serviço em dois projetos e permite retirar um
serviço já removido sem exigir sua imagem antiga. A interface mostra os
serviços e permite ajustar a associação.

O mecanismo atual de build/importação/release/publicação permanece limitado ao
projeto de um único serviço principal. Projetos com vários serviços recebem
HTTP 409 para essas operações, em vez de executar um deploy parcial. A Softload
V4 não precisa existir para que o registro de outros projetos funcione.

## Próximas etapas antes de declarar a plataforma pronta

1. Extrair os nomes e imagens da Softload V4 do núcleo da API e do executor
   para um perfil legado versionado. Esta parte está implementada em uma
   segunda branch, ainda sem deploy na VPS. Falta migrar os domínios e o
   inventário de deploy sem trocar nomes ou volumes existentes.
2. Implementar manifesto desejado por projeto, registry com digest, lock por
   projeto e ativação com health check e rollback de todos os serviços do
   projeto. Verificar a revisão servida publicamente.
3. Dar ao gateway rotas e política de suspensão por projeto. Testar sono,
   despertar e SSE com dois projetos independentes; manter gateway e painel
   permanentemente disponíveis.
4. Substituir o upload SSH de tar grande por transporte de imagens verificável
   e medido. O workflow deve parar cedo se a conexão não sustentar a entrega,
   e não repetir horas de upload sem chance de sucesso.
5. Criar tela inicial de projetos e migrar Softload V4 para um projeto
   hospedado. Validar no CI Linux e depois homologar na VPS com backup de
   dados e rollback do Painel antes de atualizar sua API.

### Etapa 3 em branch: inventário unificado

`GET /hosted-projects` reúne, em modo somente leitura, os projetos GitHub,
aplicações ainda sem repositório e a Softload V4 quando os containers legados
existem. A tela inicial apresenta cada projeto e seu estado. Um serviço
retirado é mostrado como ausente; outro projeto não é afetado. Um container
parado aparece como parado, sem disparar build ou reinstalação. O Caddy é
infraestrutura compartilhada e não entra na lista de serviços da Softload V4.
Esse inventário ainda não executa deploy multiprojetos nem altera o gateway.

O CI Linux do PR #5 passou. A API do inventário foi ativada na VPS com a
imagem `sha256:03b5ae8ddd461b4f93a0b70bee62bd27f4fc1c7068b4cd91d84f04319a323ead`.
O backup do código e do volume fica em
`/opt/softload-infra/backups/panel-inventory-20261027T221850Z`;
as cópias têm SHA-256 registrado. A imagem anterior `multiproject-008b046`
continua disponível para rollback. O PR #5 foi integrado na main.

### Etapa 4 em branch: despertar de aplicações gerenciadas

O Caddy interno deixa de encaminhar diretamente a containers que podem estar
parados por inatividade e passa pelo serviço privado `app-wake`. Ele consulta
somente os domínios registrados, confirma labels e identidade do container
através do executor isolado, inicia apenas um container parado
intencionalmente, aguarda a saúde e então encaminha a requisição. Requisições
simultâneas do mesmo projeto compartilham a mesma operação. Falhas reais de
container não disparam rebuild nem reinstalação. Não há porta publicada, Docker
socket do host ou credencial de painel nesse gateway.

**Rollout ainda pendente:** fazer backup do Compose e dos snippets Caddy,
instalar o novo serviço, validar sua saúde, gerar novamente as rotas existentes
e recarregar apenas o Caddy interno. Testar uma aplicação em homologação
acordando após inatividade; confirmar SSE, HTTPS e que os demais projetos
continuam ativos. Se falhar, restaurar snippets e Compose anteriores e
recarregar o Caddy interno. A rede compartilhada `softload_panel_apps` ainda
não oferece isolamento suficiente para clientes não confiáveis; C04 continua
bloqueando hospedagem multiusuário.

O CI Linux do PR #3 passou. A nova API foi construída e ativada na VPS em
27/10/2026 com imagem `sha256:68fd9d55de6523fdee809bb2ae56649862be439de5418b988b18fb8919d733dc`.
O volume de dados e os cinco arquivos de fonte receberam backup local em
`/opt/softload-infra/backups/panel-multiproject-20261027T215916Z`.
Os arquivos também foram copiados para este computador, cifrados com AES-256-GCM;
a chave está protegida por DPAPI da conta Windows atual. A imagem anterior ficou
preservada como `softload-panel-api:rollback-20261027T215916Z`.
A API ficou saudável, leu o cadastro existente e a Softload pública continuou
respondendo HTTP 200. O frontend do PR #3 foi publicado.
