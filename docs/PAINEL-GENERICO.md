# Painel VPS independente dos projetos hospedados

O painel administra a VPS. Softload, jogos, lojas e outros sites são projetos hospedados; nenhum deles é requisito para iniciar a API, entrar com a conta administrativa ou consultar os dados do painel.

## Responsabilidades e contratos

| Componente | Responsabilidade |
| --- | --- |
| Pages e Function | Interface, sessão por cookie e encaminhamento autenticado à API privada |
| API | Autenticação, projetos, consultas e coordenação das operações permitidas |
| Executor | Acesso ao Docker por política restrita, sem rede e sem comandos arbitrários |
| Túnel | Entrada privada da API pela rede administrativa do próprio painel |
| Projetos hospedados | Aplicações independentes, com recursos, repositórios e histórico próprios |

`GET /session` preserva `authenticated` e `setupRequired` e informa `legacySoftload`. A interface só mostra os controles de compatibilidade quando esse último campo é `true`. Uma API antiga sem esse campo continua acessível; a interface apresenta o inventário geral e explica quando uma função nova ainda não está instalada.

`GET /publications` é uma consulta administrativa ao histórico já salvo dos vários projetos. Não inicia, repete ou avança publicações. `GET /deploys` também oferece esse histórico no modo genérico, preservando os campos anteriores como vazios/nulos. A conclusão das etapas de publicação não é apresentada como prova de saúde HTTPS do site.

`GET /overview` mantém as medições da máquina mesmo se o executor estiver indisponível, identificando que os containers não foram confirmados. `GET /containers` continua oferecendo o inventário somente leitura de todos os projetos. Estar no inventário não concede direitos de iniciar, parar, remover ou inspecionar dados privados de um container externo.

## Inicialização independente

O Compose base não monta `/opt/softload-infra/softload/.env` e não usa a rede externa `softload_proxy`. A API não lê a revisão de um projeto em arquivo de ambiente. A API também não espera o healthcheck do executor para iniciar: o volume do socket pode existir antes de o executor escutar, e as operações Docker ficam indisponíveis até ele se recuperar. Contas, sessão e diagnóstico do host não dependem da prontidão do executor, GitHub ou aplicações hospedadas. O Docker do host continua necessário para executar os containers do próprio painel.

A rede `vps_panel_control` é criada pelo Compose do painel. A API e o túnel a compartilham; o executor continua com `network_mode: none`. O arquivo separado `server/tunnel.compose.yaml` referencia essa mesma rede como externa **ao projeto Compose do túnel**, não como dependência de um projeto hospedado. A rede deve existir após iniciar a composição da API.

O destino do túnel permanece `http://softload-panel-api:8080`. Esse nome é uma identidade técnica existente do painel, preservada para evitar mudanças de rota desnecessárias. Não usar `localhost` dentro do túnel nem um IP transitório de container.

## Compatibilidade opcional

O padrão de API e executor é `PANEL_SOFTLOAD_LEGACY=0`. Nesse modo:

- Não há consultas automáticas ao workflow, `/health` ou containers da Softload.
- Uma instalação nova não pré-cadastra o repositório Softload. Repositórios já salvos são mantidos.
- Os endpoints de controle antigos não concedem acesso aos containers App/Agent/Caddy.
- O executor continua reconhecendo e protegendo as aplicações gerenciadas por nome e labels, de qualquer projeto registrado.

Se a instalação realmente precisa dos controles antigos, o operador pode incluir `server/compose.legacy-softload.yaml` junto dos demais overlays. Ele habilita explicitamente o perfil tanto na API quanto no executor. Caddy permanece somente leitura; Sandbox, Embeddings e Portainer continuam fora da política de controle. A compatibilidade não exige arquivos de ambiente ou redes da Softload para iniciar a API.

Não foram renomeados os containers administrativos, o volume `softload_panel_data`, o volume do socket, os caminhos das chaves, as labels de propriedade, os arquivos persistidos ou o cookie. São identificadores de compatibilidade, não dependências de uma aplicação hospedada. Contas e projetos existentes continuam legíveis; reiniciar a API encerra as sessões em memória e exige novo login, como antes.

## Configuração de cada instalação

O binding administrativo `PANEL_API_ORIGIN` no Pages pode apontar a outra origem privada HTTPS. Ele aceita somente uma origem válida, sem usuário, senha, porta alternativa, caminho, query ou fragmento. O navegador não pode escolher o destino. Sem o binding, a instalação atual mantém `https://panel-api.analysepro.com`. As três credenciais privadas continuam necessárias e não são enviadas ao navegador.

A publicação de domínios é opcional e exige configurar o proxy frontal dessa VPS, com `PANEL_FRONT_PROXY_CONTAINER` e `PANEL_FRONT_PROXY_SITES_DIR`, além das credenciais DNS e habilitações já existentes. O nome e o caminho são validados antes de gerar comandos; o painel não escolhe automaticamente o Caddy de um projeto. O perfil de compatibilidade explícito mantém os valores anteriores para a instalação antiga. Esses parâmetros não são exigências para login ou consultas.

## Implantação e recuperação da instalação existente

Esta mudança de rede exige uma implantação coordenada de API, executor e túnel por um canal administrativo autorizado. O deploy Pages atualiza a interface e a Function; não atualiza esses containers.

1. Identificar e preservar os overlays, volumes e caminhos de credenciais já usados. Não executar `down -v` nem recriar o cadastro administrativo.
2. Pelo canal administrativo independente, diagnosticar a API e o destino do túnel antes de atribuir o HTTP 502 a um projeto removido. O script de [diagnóstico](CONEXAO-API.md) é somente leitura.
3. Preparar as imagens de API/executor e o Compose completo. Na atualização, a API e o túnel precisam compartilhar `vps_panel_control`. Atualizar somente a API enquanto o túnel permanece na rede anterior interrompe o acesso.
4. Manter o destino do túnel pelo nome estável da API, a chave de borda, a autorização do Access e o token de túnel existentes. Uma alteração de rede não exige trocar credenciais.
5. Confirmar a prontidão HTTP dentro da API, o DNS/conexão a partir da rede do túnel, o contrato de `/api/session` no endereço público e o login administrativo. Conferir projetos, inventário, registros e permissões antes de considerar a implantação concluída.

Quando o terminal do próprio painel é o único acesso disponível, ele deixa de ser um canal de recuperação se a API estiver inacessível. Adicionar outro botão na mesma API não resolve essa dependência. Será necessário recuperar um canal independente, como acesso administrativo ao provedor/SSH, ou acesso ao Cloudflare para corrigir um encaminhamento incorreto caso essa seja a causa. Não existe um endpoint de emergência sem autenticação nem uso do runner de outro projeto como atalho.

## Validação

O teste de integração sobe a API sem arquivos/containers da Softload, sem executor e com a rede de projetos interceptada. Valida setup, login, permissões, métricas parciais, histórico de projetos e persistência após reiniciar e habilitar compatibilidade. Os testes de política distinguem modo genérico de legado e mantêm as restrições de imagens, recursos e containers externos.

O CI valida Compose base, os overlays, o túnel e a preservação do volume de dados. O smoke Docker cria uma rede administrativa interna descartável, mantém o executor sem rede e consulta a API por DNS a partir de outro container. Não utiliza a VPS nem redes de projetos de produção. A validação do servidor real permanece uma etapa separada.
