# Node e Rust no Painel VPS

## Responsabilidades

Node continua responsavel pela API autenticada, contas, sessoes, PostgreSQL,
historico, executor privado e orquestracao de publicacoes. Caddy continua
responsavel pelo proxy e HTTPS. Os limites de CPU, memoria e processos continuam
aplicados pelo Docker/cgroups. Rust nao aumenta a capacidade fisica da VPS nem
redistribui RAM automaticamente entre aplicacoes.

O binario `panel-runtime` acrescenta duas operacoes pequenas e independentes de
projeto: calculo de RAM com `MemAvailable` e selecao exata de rotas cadastradas.
A API usa o calculo nativo em `/overview`. O gateway de despertar usa a selecao
nativa antes do fluxo existente de verificacao de identidade, inicio, espera de
saude e encaminhamento HTTP/WebSocket/SSE. Os contratos anteriores permanecem
validos; nenhum container ganha permissao nova de inicio ou gerenciamento.

Nesta primeira migracao, Node verifica a equivalencia de cada resposta nativa.
Resposta divergente, binario ausente, timeout ou falha preserva o comportamento
anterior em Node. Nao se promete melhoria de desempenho sem medicao comparativa.
O historico persistente de recursos continua com o coletor Node existente.

## Isolamento e limites

- Rust nao abre porta, nao acessa Docker e nao recebe arquivos, credenciais ou
  comandos administrativos. Recebe apenas os numeros/textos necessarios por stdin.
- Sem shell e sem ambiente herdado. So existem `version`, `memory` e `route`.
- Entrada de ate 64 KiB, saida/erro somados de ate 8 KiB, timeout de 2 segundos,
  no maximo dois processos simultaneos por processo Node.
- Circuito de falha de 30 segundos evita novas tentativas em cada acesso. O cache
  de rotas tem ate 256 entradas e 5 segundos, com a tabela completa na chave:
  alterar ou remover uma rota nao reaproveita uma configuracao antiga.
- Sem crates externos ou `unsafe`. Compilacao offline com Cargo.lock. Somente o
  binario final entra nas imagens; compilador e cache de build ficam no GitHub.
- O subprocesso fica dentro dos limites existentes do container. Nao foram
  aumentados memoria, CPU, processos, portas ou privilegios.

O protocolo interno v1 usa `memory`: total e livre em bytes, separados por linhas,
seguidos de meminfo; `route`: hostname normalizado na primeira linha, seguido de
host, slug e porta separados por TAB, no maximo 256 registros. Campos que poderiam
introduzir linhas sao recusados pela ponte Node. O resultado e JSON limitado.

## Instalacao e reversao

As imagens da API e do gateway incluem o binario estatico e executam um smoke
real durante o build. `PANEL_NATIVE_RUNTIME=prefer` habilita a integracao;
`PANEL_NATIVE_RUNTIME=off` preserva somente Node. Ausencia de configuracao fora
das imagens mantem Node como padrao.

O deploy de producao existente atualiza **API e executor** por digest, verifica
SHA/saude/HTTPS e reverte em falha. Ele **nao atualiza app-wake**. Instalar a imagem
da API nao comprova que o roteador nativo foi instalado: a imagem do gateway
precisa ser construida e ativada separadamente pelo operador, com todos os
overlays existentes, `up --no-deps app-wake`, apos testes e registro do digest
anterior. Nao recriar Caddy, projetos ou volumes. A reversao usa a imagem anterior
do mesmo servico; desativar Rust nao exige remover recursos ou dados.

`GET /runtime` exige a chave de borda **e sessao administrativa**, como `/overview`.
Mostra Node, protocolo, ultimo motor confirmado e falhas sem caminhos ou segredos.
O status e do processo consultado; nao representa o motor instalado em outro
container. Uma verificacao interna sem credenciais pode ser feita com
`docker exec softload-panel-api node native-runtime-smoke.mjs`.

## Verificacoes e evidencias

Workflow `native-runtime.yml`: Rustfmt, Clippy, testes Rust offline, equivalencia
real Rust/Node e gateway Docker com rede desativada, filesystem somente leitura,
capacidades removidas e limites de recursos. As imagens tambem executam os testes
Rust e o smoke Node/Rust antes de serem aceitas pelo build de producao.

Os testes Node cobrem falha, resposta divergente, rotas removidas, isolamento de
projetos, cache, concorrencia, timeout, saida excessiva e ambiente sem segredos.
As provas de transporte Unix e o binario Linux rodam no CI, nao no Windows.

Inventario somente-leitura em 31/10/2026, run
[41261846891](https://github.com/Softdown-prog/Painel/actions/runs/41261846891):
API e executor em `467bcadcad2ab9f3811fdcbf03912aec93539311`, ambos saudaveis.
Gateway de apps em `softload-panel-app-wake:1`, Caddy e tunel independentes;
nenhum componente Rust do Painel identificado nessa revisao. O Go shadow do
Terrania pertence ao jogo e nao comprova integracao Rust no Painel.

Estado verificado em 31/10/2026: PR #62 mesclado em 7202ad1; API/executor e gateway instalados e saudáveis. /api/runtime autenticado confirmou Rust com zero fallbacks; testes HTTP/SSE/WebSocket e isolamento passaram. O gateway usa imagem derivada das camadas da API, sem compilador no host. Seu deploy futuro permanece separado. Resultados, digests, recursos, reversão e limites estão em [RELATORIO-NODE-RUST-2026-10-31.md](RELATORIO-NODE-RUST-2026-10-31.md). A etapa seguinte foi auditada em [AGENTE-ADMINISTRATIVO-MCP.md](AGENTE-ADMINISTRATIVO-MCP.md).
