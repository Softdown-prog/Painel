# Node + Rust — instalação e validação na VPS

Data: 31/10/2026, America/Sao_Paulo. VPS softloadeng, 164.163.9.7.

## Estado real

- Código: [PR #62](https://github.com/Softdown-prog/Painel/pull/62), mesclado com autorização explícita em `7202ad14551947d039d13a5a0c04451c6b143223`.
- CI: Node/TypeScript, Rustfmt, Clippy, cinco testes Rust, contratos reais Node/Rust e Docker aprovados. Os seis workflows da main terminaram com sucesso.
- Frontend: Pages publicado na revisão 7202ad1. Nenhuma alteração visual específica foi exigida pelo núcleo nativo.
- Backend: [deploy 41263717377](https://github.com/Softdown-prog/Painel/actions/runs/41263717377), exit 0, revisão instalada, saúde e HTTPS verificados, outros serviços preservados.
- Gateway: instalação separada concluída; somente softload-panel-app-wake foi recriado, preservando os IDs dos demais containers, volumes, redes e limites.

| Componente | Imagem instalada | Estado |
|---|---|---|
| API | ghcr.io/softdown-prog/painel-api@sha256:9b625d5a9b2843ce46e60b6fbba4b6d8cb6075d3f03d35251b4f239d6ec0a342 | healthy, SHA 7202ad1 |
| Executor | ghcr.io/softdown-prog/painel-executor@sha256:784ed9e52888d5468c82b1eaa9eb5929dea071168507334af858e602963adae6 | healthy, SHA 7202ad1 |
| Gateway | vps-panel-wake:7202ad14551947d039d13a5a0c04451c6b143223; ID sha256:a7a5880f7f88550f4aa6e45d750363d6f77cd57581821d8de060fb460c7ee784 | healthy, SHA 7202ad1 |

## Testes reais

O login existente funcionou após o reinício autorizado da API. A visão geral recebeu dados reais e confirmou a revisão instalada. GET /api/runtime, autenticado, retornou Node 24.22.2, native.engine=rust, protocolo 1 e zero fallbacks. O terminal executou uptime com saída 0 e o smoke nativo da API e do gateway passou, com três operações bem-sucedidas cada.

Um container descartável da mesma imagem do gateway, sem rede externa, portas publicadas, volumes ou Docker socket, validou HTTP 200 e SSE para dois projetos, rejeição de host desconhecido com 404, WebSocket Upgrade e isolamento. Resultado: ok=true, http=true, sse=true, websocketUpgrade=true, projectIsolation=true, fallbacks=0. O início de containers do wake permanece coberto pelos testes existentes com executor simulado; não se pararam projetos reais para testar isso.

A [issue #64](https://github.com/Softdown-prog/Painel/issues/64#issuecomment-6552432214), criada pelo conector GitHub deste chat, acionou o [workflow 41265987589](https://github.com/Softdown-prog/Painel/actions/runs/41265987589). O resultado voltou ao GitHub e foi lido pela ferramenta: exit 0, 1,898 s no executor, 12 containers inventariados, API/executor/gateway saudáveis na revisão 7202ad1. Isso comprova o canal de diagnóstico, não execução arbitrária ou edição de arquivos pelo ChatGPT comum.

## Recursos e preservação

Snapshot Docker: API 33,27 MiB de 160 MiB; gateway 24,68 MiB de 96 MiB; MCP existente 24,73 MiB de 192 MiB. CPU instantânea 0,00% nessa amostra, sem alegação de benchmark. O binário Rust tem 428.248 bytes. Os limites continuam no Docker/cgroups; não foi criado alocador automático de memória nem aumentado o hardware.

O gateway reutiliza as camadas da API já baixada e acrescenta somente seu entrypoint. Nenhum compilador Rust foi instalado no host. O uso de disco observado passou de 8.667.983.872 para 8.680.136.704 bytes durante a operação; a variação de cerca de 12 MB inclui atividade simultânea e não é uma atribuição exata por processo.

Foram preservados os 14 overlays. O backup de configuração tem apenas 544 bytes, em /run/panel-native-wake-7202ad1-compose.before.json, SHA256 a2979d107a6b1294b0ebbf916fa23b9acca773facc38ea479f8cd5ef0cd0bb5f. O recibo está em /run/panel-native-wake-7202ad1-result.json, status installed. Imagem anterior preservada: softload-panel-app-wake:1, ID sha256:93312eb148de16a7d835aa4419d9379e5952cc6a033eff22b4a8aeed85637518. A rotina restaura o override e a imagem anterior se a saúde falhar. Não foi necessário rollback nesta instalação.

Nenhum DNS, Caddy, banco, conta, certificado, segredo ou volume foi removido. Não foi instalado modelo de IA. A rotina e quatro testes de guardas/reversão estão no PR #63, ainda separado da main.

## Limite operacional conhecido

O workflow padrão continua atualizando API/executor. O gateway foi ativado separadamente e está fixado à revisão validada; futuras atualizações do seu código exigem ativação explícita até ele ser incorporado ao contrato central. Não marcar o gateway como atualizado só porque um novo deploy da API terminou.

A investigação do próximo agente está em [AGENTE-ADMINISTRATIVO-MCP.md](AGENTE-ADMINISTRATIVO-MCP.md).
