# Agente administrativo da VPS — auditoria e próximo escopo

## Conclusão comprovada

É tecnicamente viável oferecer comandos, edição de arquivos e resultados a Codex/ChatGPT por um serviço MCP. A arquitetura proposta mantém a interpretação no cliente de IA e executa as ferramentas na VPS; não exige hospedar pesos de modelo ou GPU nesse servidor. Isso é uma proposta de implementação, não uma conexão administrativa já instalada.

A documentação oficial descreve servidores MCP remotos para ChatGPT/Codex e autenticação OAuth:
- https://developers.openai.com/api/docs/mcp
- https://developers.openai.com/plugins/build/mcp-server
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/deploy/connect-chatgpt
- https://learn.chatgpt.com/docs/learn/best-practices

## Base já existente na VPS

vps-code-mcp está running/healthy, imagem vps-code-mcp:c2dcead5b2e3d5b5fd919c9edf3b1c0888063b76, origem OCI Softdown-prog/Painel. Essa revisão pertence ao trabalho separado de MCP/Angular e não foi alterada. O processo usa UID/GID 65534, filesystem somente leitura, limite 192 MiB/0,5 CPU, sem Docker socket. A única montagem observada foi seu token em modo leitura; a porta do host é 127.0.0.1:8789.

Código instalado: [documentação imutável](https://github.com/Softdown-prog/Painel/blob/c2dcead5b2e3d5b5fd919c9edf3b1c0888063b76/docs/CODE-MCP-VPS.md).

O teste local autenticado retornou initialize HTTP 200, serverInfo multi-repo-code-mcp 1.0.0, tools/list 200 e repo_list 200. Sem token, 401. execute_command foi recusado. Nenhum valor de token saiu do host.

Ferramentas anunciadas: repo_list, repo_stats, repo_find_files, repo_find_symbols, repo_dependencies, repo_read_file, repo_search_text e repo_reindex. São operações de consulta/indexação de código; não fornecem shell, edição de arquivos do host ou deploy. As annotations readOnlyHint não vieram nesse retorno e precisam ser revisadas antes de uma conexão final. O registro da imagem é um snapshot de repositórios, não o filesystem vivo da VPS.

## O que o chat já consegue acionar

O conector GitHub efetivamente disponível foi usado para criar [VPS] inventory na issue #64 e recuperar a resposta real do workflow 41265987589, exit 0. O canal GitHub/OIDC/SSH dedicado funciona para esse diagnóstico sem depender do terminal do navegador. O conector não expõe workflow_dispatch com parâmetros livres neste conjunto de ferramentas; a ponte por issue é limitada por identidade e título exato. Não tratar uma issue arbitrária como autorização de shell.

Não foi registrada uma conexão MCP administrativa neste chat. Não foram testados comandos ou escrita a partir de uma conversa separada do ChatGPT comum. A documentação admite esse uso, mas a conexão do cliente, suas políticas de conta e a autorização ainda precisam ser validadas.

## Implementação seguinte, sem duplicar modelos

1. Reutilizar o broker existente para status/tarefas e uma identidade de serviço própria; o MCP não recebe o Docker socket nem root geral.
2. Adicionar leitura de arquivos vivos por projeto e proposta/aplicação de patch com caminho permitido, rejeição de links que escapem do projeto, hash anterior e gravação atômica. Código deve ir para checkout/branch e pipeline, preservando volumes e arquivos de clientes.
3. Submeter operações estruturadas por projeto com ID único, auditoria, timeout, limite de saída e consulta/cancelamento. Shell administrativo fica separado, vinculado à confirmação específica, comando/cwd e identidade, sem autoaprovação pelo próprio agente.
4. Preparar MCP Streamable HTTP com autenticação de usuário compatível com ChatGPT/Codex (OAuth 2.1 e descoberta/escopos), sobre HTTPS ou túnel privado suportado. Token local sozinho não comprova essa conexão externa.
5. Testar leitura e um patch em projeto descartável, rejeição entre projetos, repetição, timeout, rollback e ida/volta pelo cliente real. Confirmar recursos medidos e só então habilitar outras operações.

O próximo escopo é um executor administrativo conectado à IA; não substituir o painel, sua autenticação ou o projeto Softload Blogger, nem interferir na branch Angular em desenvolvimento. Nenhum novo agente/modelo/endpoint administrativo público foi instalado nesta auditoria.
