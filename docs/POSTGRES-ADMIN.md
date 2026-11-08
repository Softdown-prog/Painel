# Administração de bancos pelo Painel

No menu **PostgreSQL**, clique **Gerenciar banco**. A área usa Node/Angular e o PostgreSQL existente; não instala pgAdmin, outro servidor ou portas públicas.

- **Tabelas e dados:** estrutura, tipos, chave primária, páginas de 50 linhas, inclusão/edição/exclusão com confirmação do nome do banco. A versão `xmin` recusa edição desatualizada. Valores são texto para preservar bigint/numeric sem arredondar no navegador.
- **Editor SQL:** uma instrução por vez; somente leitura por padrão; alteração exige opção e confirmação. Até 100 linhas exibidas, 512 KB de resultado, timeout de 8 s e lock de 2 s. DDL, índices e GRANT/REVOKE são operações do banco selecionado. Não é shell nem superusuário SQL.
- **Backups:** formato custom do PostgreSQL 18, estrutura/dados, download em blocos e SHA-256. Até 64 MB por backup, 40 arquivos e 256 MB totais. Remoção local com confirmação. Não substitui a rotina criptografada/externalizada já existente. Sem uploads arbitrários de dumps nesta versão.
- **Restauração:** backup criado pelo próprio painel para um destino vazio; uma transação, erro interrompe/rollback, origem intacta. Crie um banco novo primeiro. Backups de bancos excluídos permanecem acessíveis em **Todos os backups**.
- **Acessos:** endereço interno, proprietário, identidade do editor e permissões de tabelas; nenhum certificado/chave/senha é enviado. Botões para criar acesso de leitura/gravação e revogar (inclui NOLOGIN para futuras conexões), com até 20 identidades por banco e certificados privados. GRANT/REVOKE em tabelas também via SQL. Não altera senhas/credenciais de aplicações já configuradas. Conexões já abertas não são terminadas à força.
- **Excluir banco:** cria backup antes, exige confirmação, não usa FORCE/CASCADE. Conexões ativas impedem a exclusão. Contas/certificados ficam preservados; não se excluem identidades potencialmente usadas por aplicações automaticamente.

## Isolamento

Rotas administrativas passam pela autenticação de sessão existente e pela chave de borda/Access. A API não recebe Docker socket nem root de host. O PostgreSQL continua sem portas publicadas.

O administrador por certificado é usado apenas em operações SQL fixas de catálogo/provisionamento. SQL digitado pelo usuário e ferramentas de backup usam uma identidade própria por banco, sem superuser/createrole/createdb/replication/bypassrls. Essa identidade recebe somente o proprietário exclusivo daquele banco. Bancos de sistema, donos compartilhados e donos com privilégios globais são recusados. A API revalida permissões a cada acesso.

O bootstrap adiciona uma faixa HBA obrigatória por certificado para `panel_db_admin` e membros de `vps_panel_certificate_clients`, com recusa explícita dos mesmos nomes fora de TLS/cert. Regras preexistentes de outras identidades ficam intactas. O status continua informando `trust` se ele ainda existir para clientes legados; `adminAuthentication=verified-certificate` comprova TLS/CN e recusa real sem certificado, não afirma que toda a instância foi migrada.

## Instalação administrativa explícita

1. CI e teste Docker/PostgreSQL 18 devem estar verdes; preparar nova imagem via GitHub Actions.
2. Registrar as imagens/overlays atuais. `prepare-database-admin-vps.py` começa com diagnóstico sem `--apply`.
3. `--apply` exige root, executa a rotina criptografada existente do Terrania, salva apenas HBA/auto.conf e metadados essenciais em `/etc/vps-postgres-admin/rollback-*` e instala certificados privados nos volumes existentes.
4. Ativa SSL e novas regras com `pg_reload_conf()`. Os quatro parâmetros devem ter contexto `sighup`. Não reinicia PostgreSQL nem seus clientes.
5. Verificar conexão com certificado, recusa sem certificado e recusa de CN divergente antes de ativar API. Certificados não são publicados nem versionados.
6. Copiar o overlay exemplo como `compose.postgres-admin-local.yaml`, **depois** de `compose.postgres.yaml`, preservando todos os overlays efetivos. O driver conserva overlays locais ausentes da revisão seguinte. Validar Compose efetivo e atualizar somente API com a imagem aprovada.
7. Testar login, catálogo real e operações em banco descartável, sem alterar tabelas de clientes. Conferir os demais serviços e o horário de início do PostgreSQL.

Reversão: recriar somente a API com a imagem/overlays registrados; remover o overlay administrativo da lista ativa. Para desfazer TLS/HBA, restaurar os dois arquivos essenciais registrados, preservar proprietário/permissões e executar `pg_reload_conf()`. Não remover volumes, contas nem certificados automaticamente. A imagem anterior continua conectando pelo caminho legado preservado.

## Validação

`server/database-admin.test.mjs`: parâmetros, confirmação, chave primária, concorrência otimista, schemas protegidos e falhas fechadas. `server/database-admin-docker.sh`: PostgreSQL 18 real em rede interna descartável, certificado obrigatório, projetos independentes, criação, SQL/CRUD, limites, backup/restore, recuperação após exclusão e timeout. `angular/e2e/database-manager.spec.mjs`: fluxo mobile e confirmação. Linux CI mantém os testes Unix existentes; limitações de permissões POSIX do Windows não são ocultadas.

Estado da instalação real e SHAs: consultar `docs/TAREFAS-CODEX.md`.
