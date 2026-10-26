# Status dos deploys: GitHub × Docker × arquivo de ambiente

A tela **Publicações** agora diferencia os resultados do GitHub das imagens realmente em execução na VPS. Não basta um workflow terminar nem a variável `SOFTLOAD_IMAGE_TAG` ter o mesmo SHA para concluir que a imagem foi ativada.

## Como os estados são decididos

- **Em execução no GitHub / Na fila:** o workflow ainda não terminou.
- **Falhou / Cancelado:** GitHub informou erro ou cancelamento, mesmo que o SHA coincida com uma imagem existente.
- **Imagem ativa na VPS:** workflow terminou com sucesso **e** o Docker confirmou que o container principal `softload-vps-app-1` está rodando uma imagem com tag `softload-app:<SHA>` igual àquele commit.
- **Concluído · outra versão ativa:** workflow terminou, mas o container principal está executando um outro SHA confirmado pelo Docker. Pode ser uma revisão mais recente, rollback ou discrepância do deploy; não significa, por si só, que aquele workflow falhou.
- **Concluído · ativação não confirmada:** o Docker não confirmou a imagem da aplicação (API/executor indisponível, container ausente/parado ou tag não reconhecida). O painel **não transforma o SHA de um arquivo de ambiente em prova** de ativação.

Em **Publicações**, a tabela de serviços identifica separadamente os SHAs do App, Agent, Sandbox e Embeddings. O workflow da Softload V4 reconstrói alguns serviços apenas quando há alterações; por isso o Agent ou o Sandbox podem legitimamente estar em SHAs mais antigos sem que isso indique erro na publicação da aplicação.

O valor de `SOFTLOAD_IMAGE_TAG` em `/host/softload.env` continua visível como **referência configurada**. Caso divirja da tag da imagem em execução, isso é indicado na interface.

## Fonte e limitações técnicas

O endpoint autenticado `GET /deploys` agora inclui `runtime` com o resultado de chamadas **somente leitura** ao executor Docker, usando `GET /containers/<nome>/json` para os quatro serviços. A API não tem acesso direto ao Docker socket. Não são enviados para o navegador `Config.Env`, mounts, tokens ou configurações privadas: somente estado, nome da imagem e SHA extraído da tag.

A análise verifica a **imagem do container em execução**, não a funcionalidade do site pelo endereço público. O deploy do próprio repositório Softloadv4 realiza uma verificação externa separada em `https://softload.analysepro.com/health`. Para confirmar também o HTTP/HTTPS externamente pelo Painel, adicionar uma checagem específica sem confundí-la com a verificação do Docker.

**Compatibilidade:** se o frontend estiver atualizado, mas a API na VPS ainda for antiga e não retornar `runtime`, os workflows concluídos aparecerão como **Ativação não confirmada**, nunca erroneamente como "Imagem ativa na VPS". É necessário instalar o backend atualizado para mostrar os SHAs reais.

## Instalação na VPS

A nova funcionalidade exige atualizar **somente a imagem da API do Painel** com o código e o novo módulo `server/deploy-verification.mjs`; o executor existente já permite leitura de containers gerenciados e dos quatro serviços Softload. Não é necessário mudar Caddy, DNS, Softload V4, credenciais ou permissões SSH.

Verifique o Compose em uso, crie backup antes de atualizar e execute o preflight read-only. Depois de atualizar a API e confirmar sua saúde, abra a aba **Publicações**, confira os quatro serviços, compare a revisão ativa do app com a versão configurada e compare os estados ao histórico do GitHub.

Nenhum deploy foi disparado na VPS nem houve alteração de containers de produção ao implementar essa correção.
