# Status dos deploys: GitHub × Docker × arquivo de ambiente

A tela **Publicações** agora diferencia os resultados do GitHub das imagens realmente em execução na VPS. Não basta um workflow terminar nem a variável `SOFTLOAD_IMAGE_TAG` ter o mesmo SHA para concluir que a imagem foi ativada.

## Como os estados são decididos

- **Em execução no GitHub / Na fila:** o workflow ainda não terminou.
- **Falhou / Cancelado:** GitHub informou erro ou cancelamento, mesmo que o SHA coincida com uma imagem existente.
- **Imagem ativa na VPS:** workflow terminou com sucesso **e** o Docker confirmou que o container principal `softload-vps-app-1` está rodando uma imagem com tag `softload-app:<SHA>` igual àquele commit.
- **Concluído · outra versão ativa:** workflow terminou, mas o container principal está executando um outro SHA confirmado pelo Docker. Pode ser uma revisão mais recente, rollback ou discrepância do deploy; não significa, por si só, que aquele workflow falhou.
- **Concluído · ativação não confirmada:** o Docker não confirmou a imagem da aplicação (API/executor indisponível, container ausente/parado ou tag não reconhecida). O painel **não transforma o SHA de um arquivo de ambiente em prova** de ativação.

Em **Publicações**, a tabela de serviços identifica separadamente os SHAs do **App** e **Agent**. O workflow da Softload V4 pode reutilizar a imagem do Agent quando ela não muda; portanto, o Agent pode legitimamente aparecer com SHA anterior. Os antigos Sandbox e Embeddings não são mais consultados ou tratados como pendência.

O valor de `SOFTLOAD_IMAGE_TAG` em `/host/softload.env` continua visível como **referência configurada**. Caso divirja da tag da imagem em execução, isso é indicado na interface.

## Fonte e limitações técnicas

O endpoint autenticado `GET /deploys` agora inclui `runtime` com o resultado de chamadas **somente leitura** ao executor Docker, usando `GET /containers/<nome>/json` apenas para App e Agent. A API não tem acesso direto ao Docker socket. Não são enviados para o navegador `Config.Env`, mounts, tokens ou configurações privadas: somente estado, nome da imagem e SHA extraído da tag.

A verificação de imagem consulta os containers Docker. **Uma segunda verificação, independente, consulta o HTTPS público `https://softload.analysepro.com/health`**, lê apenas `deploy.gitSha` da resposta e compara com a revisão do container principal. O resultado público é incluído em `GET /deploys` sob o campo `publicHealth`. O endereço da consulta é fixo no código, não é escolhido pelo usuário, e as respostas são limitadas a 16 KB e timeout de 5 segundos. Os resultados são reutilizados por 25 segundos para não sobrecarregar o site.

Estados adicionais:
- **DOCKER + /HEALTH CONFERIDOS**: GitHub concluiu, Docker executa aquela revisão e o `/health` público apresenta o mesmo SHA.
- **IMAGEM ATIVA · SITE DIVERGENTE**: Docker executa a imagem daquela revisão, mas o `/health` público informa outro SHA. Exige investigar publicação/roteamento, sem marcar o workflow como falho automaticamente.
- **IMAGEM ATIVA · HTTPS NÃO CONFERIDO**: Docker confirmou a imagem, mas o `/health` não foi verificado. **Não significa que o site caiu**; a consulta pode estar indisponível.
- **Revisão pública observada**: caso o `/health` responda mas o Docker não possa ser confirmado, o SHA é mostrado sem afirmar que corresponde ao container.

**Limite do teste público:** conferir `/health` não garante que toda a interface React, os scripts, o login ou demais rotas estejam corretos. O workflow do Softloadv4 já faz uma checagem própria do bundle JavaScript após verificar o `/health`.

**Compatibilidade:** se o frontend estiver atualizado, mas a API na VPS ainda for antiga e não retornar `runtime`, os workflows concluídos aparecerão como **Ativação não confirmada**, nunca erroneamente como "Imagem ativa na VPS". É necessário instalar o backend atualizado para mostrar os SHAs reais.

## Instalação na VPS

A nova funcionalidade exige atualizar **somente a imagem da API do Painel** com os módulos `server/deploy-verification.mjs` e `server/deploy-public-health.mjs`; o executor precisa permitir leitura dos containers gerenciados e dos dois serviços centrais App e Agent. Não é necessário mudar Caddy, DNS, Softload V4, credenciais ou permissões SSH.

Verifique o Compose em uso, crie backup antes de atualizar e execute o preflight read-only. Depois de atualizar a API e confirmar sua saúde, abra a aba **Publicações**, confira App e Agent, compare a revisão ativa do app com a versão configurada e compare os estados ao histórico do GitHub.

O CI cobre comparação, divergência e indisponibilidade do HTTPS, e o teste isolado com Docker verifica a resposta autenticada da API mesmo quando não existe rede externa. **Nenhum deploy foi disparado na VPS nem houve alteração de containers de produção ao implementar essa correção.**

**Proteção de recuperação:** a mudança de inventário/UX não executa remoção de imagens Docker nem faz limpeza dos GB recuperáveis. Revisões antigas da Softload devem continuar preservadas até prova independente da revisão ativa e da revisão de rollback.
