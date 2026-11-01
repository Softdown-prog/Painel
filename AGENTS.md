# Instruções para Codex — Softload Painel

Este repositório é o painel administrativo da VPS, não o projeto Softloadv4. O usuário quer um gerenciador de hospedagem fácil, rápido e capaz de crescer para vários sites, clientes e VPS.

## Leia antes de programar

1. `docs/TAREFAS-CODEX.md`: backlog **vivo** com prioridades, impedimentos, critérios de aceite e estado de cada função.
2. `docs/GUIA-RAPIDO.md`: linguagem que deve aparecer nas telas para quem não conhece Docker.
3. `README.md`: arquitetura e estado das integrações.
4. `docs/docker-executor.md` e `docs/domain-routing.md`: restrições de segurança e de ativação na VPS.

## Regras do projeto

- Sempre conferir os últimos commits da `main` antes de trabalhar; outras sessões podem estar alterando o código. Não sobrescrever alterações concorrentes.
- Usar português brasileiro simples nas telas. Termos de infraestrutura, quando necessários, ficam em “Configuração avançada”. A interface deve mostrar **o próximo passo**.
- Não afirmar que um domínio está público quando apenas foi reservado. Não afirmar que deploy ou saúde da VPS foi verificado com base apenas no CI.
- Manter os serviços internos da Softload separados dos containers de clientes; não usar labels, redes ou nomes de produção de maneira oportunista.
- Nunca remover limite de RAM/CPU/containers simplesmente para “escalar”. Escala exige quotas, isolamento, auditoria e monitoramento por servidor.
- O executor ainda tem acesso privilegiado ao Docker do host. Jamais expor comandos arbitrários, Docker socket ou tokens a clientes, frontend ou workflows não autorizados.
- O runner `softloadrunner` de Softloadv4 não tem acesso ao Docker/sudo por design. Não contornar essa restrição.
- Sem ordem explícita e mecanismo autorizado, **não tocar na VPS, DNS, Caddy de produção ou serviços em execução**. Documentar a pendência para o operador.
- Para novos arquivos frontend, usar TypeScript; `npm run build:frontend` recompila JS e `npm run check:js` valida scripts. Não publicar JS fora de sincronia.
- Rodar `npm run typecheck`, `npm test`, `npm run check:js`, `npm run build:frontend` e validação Compose pertinente.
- Após cada implementação atualizar `docs/TAREFAS-CODEX.md` com SHA e validações distintas: código criado, CI aprovado, frontend publicado e VPS validada.
- Escrever o resumo ao usuário assim: **o que ficou mais fácil**, **onde clicar**, **o que ainda falta**.

## Priorização

1. P0: implantação autorizada/rollback, publicação real de domínios, GitHub→deploy, isolamento multiusuário.
2. P1: tela única de sites, armazenamento/segredos, múltiplas VPS, backup, métricas.
3. P2: modelos de hospedagem, clientes, planos e testes de experiência.

O arquivo de tarefas documenta detalhes e aceites. Não substituir esse backlog por suposições.

## MCP de navegação deste repositório (desenvolvimento, não VPS)

O repositório contém um MCP stdio próprio em `tools/repo-mcp/server.mjs`, com índice gerado pelo Actions (workflow `.github/workflows/repo-mcp-index.yml`) e documentação em `tools/repo-mcp/README.md`. Use `repo_find_files` e `repo_find_symbols` para localizar arquivos e definições; `repo_dependencies` para descobrir vínculos; `repo_read_file` antes de editar; e `repo_search_text` para referências. Edição `repo_replace_text` usa comparação SHA-256 e simulação por padrão, não faz commit. A ferramenta GitHub permanece necessária para operações remotas. **Não confundir** com o cadastro de MCP/clusters no painel Angular.

## Servidor MCP HTTP hospedável (implantação separada)

A branch Angular também prepara `tools/repo-mcp/http-server.mjs` e `operations/code_mcp.py`. São independentes da aba Angular de clusters/MCP; o servidor HTTP é **somente leitura**, com token bearer, Origin bloqueado, repositórios explicitamente cadastrados, limite de 50 entradas e acesso por token único nesta fase (não significa ACL individual de 50 repositórios). O image builder atual inclui **somente o Painel**. A operação na VPS é exata: `code_mcp status/install`, sem root shell, sem instalar outros containers; exige OIDC main/workflow_dispatch/ambiente protegido e bootstrap separado do broker instalado no host. CI da branch **não instala na VPS**, não abre HTTPS e não liga o MCP a assistentes automaticamente. Ver `docs/CODE-MCP-VPS.md`.

## Integração Cloudflare Tunnel do Code MCP

`tools/repo-mcp/edge-network.mjs` gerencia uma **rede privada adicional**, somente entre `vps-code-mcp` e `softload-panel-tunnel`. Padrão read-only `--check`; `--apply LINK:code-mcp` e `--rollback UNLINK:code-mcp` são operações root **manuais**, separadas do GitHub CI, com validações de propriedade e rede. Não modificar Caddy ou Cloudflare remotamente por suposição; não expor 8789 na WAN. O servidor usa Bearer fixo, não OAuth, e a publicação real HTTPS depende de rota Cloudflare autorizada. Consultar `docs/CODE-MCP-VPS.md`.

## Executor Rust em modo sombra

`server/rust-executor` contém somente núcleo de decisões em Rust, sem docker.sock, sem socket HTTP e sem permissão operacional. `candidate_allowed` é parecer, nunca autorização executável (`enforcement_allowed` é sempre falso). Manter `server/executor.mjs` como autoridade de produção até existir paridade e benchmarks reais; não implantar o protótipo na VPS nem expor a container privilegiado. A branch permanece separada da main.
