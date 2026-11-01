# MCP de navegação do código — Painel

Este é um servidor MCP stdio **para agentes de programação**, separado do módulo de servidores MCP e clusters administrado pelo Painel. Não fica instalado na VPS, não expõe HTTP e não inicia containers.

## Ferramentas do MCP

- repo_stats: estatísticas do índice, modo somente leitura ou edição.
- repo_reindex: gerar novamente o índice local.
- repo_find_files: localizar nomes e caminhos de arquivos.
- repo_find_symbols: buscar definições com número de linha.
- repo_dependencies: imports, dependências locais e arquivos importadores.
- repo_read_file: ler linhas numeradas e obter hash SHA-256.
- repo_search_text: pesquisar texto com limite de resultados e de bytes.
- repo_replace_text: preparar ou aplicar substituição com comparação de hash, sem commit.

O índice é criado em .repo-mcp/index.json e ignora arquivos de build, binários, links simbólicos, diretórios de dependências e caminhos sensíveis. Busca de símbolos/imports é heurística; não substitui TypeScript e testes.

## GitHub Actions

Workflow: .github/workflows/repo-mcp-index.yml

Cada push na branch feat/angular-complete-migration executa testes do MCP e gera o índice como artefato painel-code-index, retido por 7 dias. Permissão do token: contents: read. Sem push, commit, PR, deploy, segredo ou acesso à VPS. O workflow_dispatch manual só poderá ser iniciado pela interface quando o workflow existir na branch padrão; por ora o push na branch já aciona a rotina.

Actions executa um processo temporário, não hospeda MCP 24 horas. O arquivo no GitHub ou o artefato não conecta automaticamente este MCP ao ChatGPT.

## Execução como MCP stdio em um clone local

Requer Node.js 24+. Na raiz do checkout:

    node tools/repo-mcp/cli.mjs index
    node --test tools/repo-mcp/repo-mcp.test.mjs
    node tools/repo-mcp/server.mjs

Exemplo de configuração para cliente compatível com mcpServers (substituir caminho):

~~~json
{
  "mcpServers": {
    "painel-code-navigator": {
      "command": "node",
      "args": ["tools/repo-mcp/server.mjs"],
      "env": {
        "REPO_MCP_ROOT": "/caminho/checkout/Painel",
        "REPO_MCP_ALLOW_WRITE": "0"
      }
    }
  }
}
~~~

A configuração exata depende do cliente MCP. O cliente deve conseguir iniciar o processo no checkout.

## Edição segura

O repo_replace_text é simulação por padrão (dryRun=true). Escrita de verdade requer REPO_MCP_ALLOW_WRITE=1 no ambiente do cliente, **fora do Actions** e dryRun=false no pedido. Leia primeiro o arquivo por repo_read_file; forneça expectedSha256, oldText e newText. Se alguém alterou o arquivo, o hash diverge e a edição é recusada. Arquivos protegidos e o código do próprio MCP não podem ser alterados por essa ferramenta. Não há commit, push ou PR automático.

Ainda é preciso revisar diffs e executar os testes usuais do Painel. O GitHub já conectado ao assistente segue como meio de leitura e escrita remota até o cliente MCP ser conectado.
