# SAC ↔ MCP: roteamento entre projetos (sem broker)

Esta implementação **não usa o broker vpsops** para consultar o SAC.
Ela aproveita o servidor HTTP MCP **já existente** em
\`tools/repo-mcp/http-server.mjs\`, que conhece um mapa de repositórios
e autentica o cliente com Bearer. O único acréscimo é a ferramenta
read-only \`sac_job_report\`. Ela escolhe o diretório autorizado pelo
registro e devolve uma ficha técnica **já gravada** pelo SAC.

\`\`\`text
ChatGPT / cliente MCP autenticado
           ↓ repo + jobId
      Code MCP existente
           ↓ seleção por lista fixa de repositórios
   <reportsRoot>/<projectId>/gha-<run>-<attempt>.json
           ↓ validação estrita do relatório v2 existente
      technicalReport (JSON/texto)
\`\`\`

O MCP **não compila**, não executa Docker/shell, não recebe comandos,
não enfileira job, não faz commit/deploy e não precisa de ML/LLM local.
Continua cabendo ao SAC Worker e à toolchain gerar o registro.
O ChatGPT é o responsável por interpretar o erro e corrigir o código.

## Contrato de roteamento

O registro, preparado pelo operador, pode ter uma entrada como:

\`\`\`json
{
  "repos": [
    {"name":"Data_libray",
     "path":"/srv/repos/Data_libray",
     "projectId":"data-library",
     "reportsPath":"/srv/sac-reports/data-library"}
  ]
}
\`\`\`

A ferramenta \`sac_job_report\` recebe \`{"repo":"Data_libray","jobId":"gha-900-1"}\`.
\`reportsPath\` é OPCIONAL: repositórios sem essa configuração
mantêm as ferramentas MCP de busca de arquivos exatamente como antes,
mas ainda não oferecem relatórios SAC.

O servidor só aceita \`reportsPath\` que corresponda precisamente a
\`<reportsRoot>/<projectId>\`, com diretórios reais (não symlinks);
a leitura do arquivo usa \`O_NOFOLLOW\`, limite de bytes e ID de job
fechado. Identidades de projeto/job/SHA, código de falha, fases, mensagem
técnica fixa, arquivo relativo, linha/coluna e texto são revalidados.
Nenhum campo bruto desconhecido é copiado para a resposta. O cliente
só recebe dados factuais e os marcadores de não execução das fases
pós-build. Se o job ainda não existir, o status é \`not-recorded\`;
se o arquivo não for confiável, a consulta falha fechada.

## Escopo e entrega na VPS

**Aprovação da publicação pública:** o responsável aceita divulgar
metadados técnicos filtrados, mas não tokens, senhas, credenciais,
conteúdo arbitrário do compilador ou logs brutos.

**Ainda não há rotas de relatórios SAC instaladas em produção.**
A imagem MCP instalada historicamente só contém o snapshot Painel.
Para operar outros projetos, um deploy futuro deverá registrar
explicitamente os respectivos snapshots e disponibilizar os relatórios
já produzidos por montagem **somente leitura** em
\`/srv/sac-reports/<projectId>\`, com controle de acesso e atualização
de snapshot. Esta branch **não modifica** o container, registry em
produção, Docker, systemd, SSH, Cloudflare, broker ou políticas vpsops.
O antigo \`install-vps-from-source.sh\` contém verificações do broker,
mas não é usado por este roteador e não foi acionado.

**Testes reais desta microetapa:** uma instância MCP local autenticada
atende dois projetos sintéticos com SHA/job distintos, nega leitura
cruzada, rejeita travessia, symlink, falsificação de aprovação e texto
adulterado, e preserva as consultas antigas. Não comprova leitura de
resultados reais na VPS. A implementação não deve ser apresentada como
homologação multiprojetos de produção apenas por passar na CI.

PR #79 do Painel (adaptador SAC de broker) foi encerrado sem merge
por mudança de arquitetura. Referência: issue #41 da Data Library.
