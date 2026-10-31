# PostgreSQL multiprojetos — gestão por projeto (em desenvolvimento)

## Situação confirmada na VPS
O operador confirmou a API em execução com a revisão e4469c7, PostgreSQL 18.6 conectado, 1 banco `postgres` e 9 conexões no momento do teste. Isso **não** significa que a nova criação de bancos já tenha sido implantada.

## Implementação deste PR
- `GET /database/status` consulta bancos, tamanhos, papéis sem senhas e configuração de autenticação por `pg_hba_file_rules`.
- A interface **Sistema → Banco de Dados** exibe a segurança real da conexão e a lista de contas. O botão **Criar banco** fica desativado até a API confirmar `provisioningEnabled: true`.
- `POST /database/projects`, autenticado pela sessão administrativa do Painel, cria um par de banco/usuário gerenciado a partir de um slug estritamente validado. Não aceita SQL fornecido pelo navegador. Exemplo: `site-loja` → banco `p_site_loja`, usuário `u_site_loja`.
- A senha de cada usuário é gerada automaticamente, nunca retornada na resposta, guardada exclusivamente no volume administrativo da VPS sob `/data/database-credentials/<slug>.json`, com arquivo 0600 e diretório 0700.
- O papel criado não é superusuário, não cria bancos ou papéis; o novo banco tem `PUBLIC CONNECT` revogado. Contagem máxima provisória: 40 bancos gerenciados; sem remoção automática.
- A rota de criação exige **simultaneamente**: `PANEL_POSTGRES_WRITE_ENABLED=1`, credencial administrativa em arquivo protegido `PANEL_POSTGRES_PASSWORD_FILE`, autenticação **SCRAM** em todas as regras host não rejeitadas, e **prova por conexão** de que uma senha errada retorna `28P01`. Faltando qualquer requisito, a API bloqueia **antes de qualquer CREATE**.
- Os projetos já hospedados não são automaticamente associados aos bancos, nem são conectados à rede PostgreSQL. Criar um banco não instala a aplicação nem injeta credenciais nela.
- Não há função de excluir/restaurar banco ou consultar SQL arbitrário na interface. A observabilidade e o provisionamento são serviços da VPS compartilhada, independentes dos aplicativos.

## Bloqueio esperado na instalação atual
A instância atual usa `POSTGRES_HOST_AUTH_METHOD=trust`, permitindo que qualquer container conectado à rede interna se apresente como qualquer role, inclusive superusuário. Isso **não** oferece isolamento. Por segurança, a nova interface deve exibir aviso explícito e **manter a criação desabilitada** nessa instalação.

Não habilitar `PANEL_POSTGRES_WRITE_ENABLED` antes de migrar a autenticação de todas as conexões host para SCRAM-SHA-256, preparar um arquivo privado de senha administrativa e testar a rejeição de senha incorreta. A migração do `pg_hba.conf` e das credenciais exige procedimento separado e validação do impacto nos clientes. Não alterar o banco de produção, apagar volume ou mudar rede de maneira improvisada.

## Ativação futura
1. Preparar política SCRAM e credenciais com procedimento específico, preservar conexões dos projetos e manter o PostgreSQL sem porta publicada no host.
2. Confirmar que a conta administrativa do Painel realmente se autentica com senha e que senha incorreta é rejeitada.
3. Instalar secret administrativo em caminho privado visível à API e habilitar explicitamente a flag de escrita. Até lá, apenas a leitura e o diagnóstico estão disponíveis.
4. Publicar a nova API no host através de atualização isolada com rollback. Cloudflare Pages atualiza somente o frontend.
5. Abrir Sistema → Banco de Dados, conferir o diagnóstico e, após confirmar a liberação, criar um projeto de teste. Conferir criação do banco, papel restrito e arquivo de credencial com mode 0600; evitar registrar o segredo nos logs.

## Limites
A leitura de `pg_hba_file_rules` descreve o arquivo de configuração e pode apresentar alterações não recarregadas; por isso não é aceita como única prova de segurança. A execução da rota de escrita testa ativamente a rejeição de senha errada. As credenciais geradas nunca são enviadas pelo navegador, mas ainda falta uma etapa futura para injetá-las com segurança em cada serviço hospedado.

**Verificações:** typecheck, frontend compilado, testes, check:js e Compose devem passar no GitHub antes do merge. CI não prova que a funcionalidade está implantada na VPS.
