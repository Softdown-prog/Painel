# Code MCP via Actions e VPS — arquitetura, política e limites

**Separado** do gerenciador Angular de MCP/clusters. Este Code MCP serve para agentes navegarem em código-fonte com índices por repositório. Não executa comandos shell, git push nem deploy. O modo HTTP implantável é **somente leitura**; o modo stdio local é independente.

## Entrega nesta branch

- Ferramentas HTTP: `repo_list`, `repo_stats`, `repo_find_files`, `repo_find_symbols`, `repo_dependencies`, `repo_read_file`, `repo_search_text`, `repo_reindex`.
- Transporte MCP Streamable HTTP sem sessões, protocolo `2025-11-25`, POST em `/mcp`; GET e DELETE não permitidos. Token bearer em arquivo montado, verificações de Accept, versão de protocolo, tamanho e Origin (origens de navegador negadas).
- Registro de até 50 diretórios locais autorizados, cada um com índice isolado. **Nesta primeira imagem está cadastrado apenas o repositório Painel**. Permitir 50 entradas não significa que 50 repositórios já foram clonados, sincronizados ou receberam ACL individual.
- `Dockerfile` mínimo Node 24, sem shell em endpoints, UID 65534, filesystem read-only, sem socket Docker, CPU 0,5 vCPU, RAM 192 MiB, 64 processos; porta publicada apenas em `127.0.0.1:8789` na VPS. Imagem construída a partir dos **arquivos commitados** via `git archive`, nunca de arquivos locais não versionados.
- A imagem usa fontes de uma revisão fixa, não um checkout em tempo real. Ações e commits subsequentes **não** aparecem até nova imagem/atualização explicitamente autorizada.

## O que GitHub Actions faz

`.github/workflows/code-mcp-vps.yml`: em pushes da branch Angular que alterem o MCP, testa protocolo, política de autorização e container **em runner descartável**. Nenhuma mudança na VPS.

Após conclusão e autorização expressa para `main`, o workflow manual disponibilizará:
- `status`: consulta o container MCP nomeado.
- `install` + confirmação literal `INSTALL:code-mcp`: constrói imagem GHCR com SHA/digest, exige aprovação do ambiente protegido `vps-maintenance`, solicita ao broker instalação **apenas** do container `vps-code-mcp`. Se já houver container com esse nome, a operação recusa substituí-lo. O status retorna somente dados sanitizados.

O broker root-owned já existente aceita **somente** operações presentes na política instalada. Adicionar workflow à branch **não atualiza automaticamente** `/usr/local/lib/vps-operations` ou `/etc/vps-operations/policy.json`.

## Bootstrap necessário no host

O código do bootstrap está em `operations/upgrade-vpsops-code-mcp.sh`. Trata-se de **alteração privilegiada da política da VPS**, não executada pelos workflows atuais nem aqui. Requer execução por um canal administrativo independente, revisado e autorizado, a partir de checkout da revisão final aprovada; preserva chaves, usuário, sudoers, containers e outras políticas. **Não** conceder `NOPASSWD: ALL`, shell livre ao Actions ou Docker ao runner da Softload. A configuração real de aprovadores obrigatórios em `Settings → Environments → vps-maintenance` também deve ser confirmada antes de operar.

## Acesso ao MCP de fora da VPS

Por padrão o serviço ouvirá **somente loopback**. Para permitir acesso do ChatGPT ou Codex na internet, será preciso adicionar uma rota HTTPS no Caddy/Cloudflare com autenticação compatível com o cliente e política de Origins, sem publicar o bearer em commits, resultados de Actions ou respostas públicas. O token inicial é criado no host e **não é mostrado nos logs**. A conexão não existe automaticamente.

## Próximas etapas

1. Validar CI e segurança do protocolo, runtime, caminhos e políticas; só depois solicitar autorização para merge.
2. Preparar atualização do executor root-owned por canal administrativo realmente permitido; nunca declarar instalado por CI.
3. Executar workflow manual, receber status real da VPS e testar saúde.
4. Adicionar sincronização autorizada de repositórios (GitHub App / tokens mínimos por repo), índices por repo, autenticação por cliente e quotas. Implementar atualização/rollback do serviço.
5. Integrar HTTPS + cliente MCP. Não expor endpoint somente para contornar o problema de conexão.

Referência protocolo: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
