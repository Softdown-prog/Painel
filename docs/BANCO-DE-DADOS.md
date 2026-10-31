# PostgreSQL compartilhado entre projetos e containers — SEM SENHAS

## Contrato solicitado
- **Uma instância PostgreSQL 18 na VPS, independente de qualquer projeto.**
- **Vários bancos**: um por projeto, com usuários restritos e independentes; não obrigar aplicações a compartilharem identidade.
- **Nenhuma senha de banco** — sem campo de senha, sem SCRAM, sem gerar senha silenciosamente, sem guardar senha em arquivo nem em variáveis de ambiente.
- Autenticação remota privada com **certificados cliente TLS**, um certificado por projeto; isso ainda implica *chaves privadas*, administradas pelo Painel e não mostradas em navegador.
- A API do Painel possui seu próprio certificado administrativo (CN postgres) e nunca concede esse arquivo aos containers de clientes.

## Implementação no código
- `server/postgres-cert.ts` lê arquivos em `/data/postgres-tls` (0700), verifica permissões privadas e gera certificados X.509 de cliente por projeto via OpenSSL **sem invocar shell**. A CA privada permanece sob controle do servidor administrativo.
- `GET /database/status` lista bancos/papéis e informa `trust`, `cert` ou `other`, sinalizando provisionamento habilitado apenas quando a infraestrutura de certificados e opt-in estiverem presentes.
- `POST /database/projects` cria, mediante sessão administrativa, `p_<slug>` e `u_<slug>`. O papel é criado com `PASSWORD NULL`. Nenhum dado de certificado ou chave é retornado na resposta.
- Arquivos em `/data/database-credentials/<slug>/`: `client.crt`, `client.key` (0600), `ca.crt`, `connection.json` (sem senha). Cada container futuro deve receber **somente seu próprio** diretório, montado read-only; **nunca** a CA privada nem o certificado do Painel.
- O backend checa `pg_hba_file_rules` para recusar `host trust` e qualquer método de rede diferente de `cert` ou `reject`. Para criar, também prova TLS ativo, rejeição de conexão sem certificado e rejeição do certificado administrativo ao tentar entrar como novo usuário, e verifica autenticação do certificado do projeto. **Falha impede criação**.
- O usuário dono de banco não é superusuário nem cria bancos/roles. Não há SQL arbitrário, exclusão ou restauração pelo navegador.
- A política de projetos já existentes e as permissões de bancos não gerenciados devem ser auditadas separadamente; criar papéis não garante automaticamente revogação de `PUBLIC CONNECT` em bancos preexistentes.

## Estado da VPS
A instalação atual foi criada com `POSTGRES_HOST_AUTH_METHOD=trust` e não possui autenticação TLS por cliente configurada. O backend atual continua consultando o banco, mas **não deve liberar criação** antes da migração. A configuração `trust` permite a qualquer container na rede tentar assumir outros usuários PostgreSQL. O fato de a rede Docker ser interna não substitui autenticação.

**Não alterar pg_hba.conf ou reiniciar o PostgreSQL manualmente durante este PR.** A migração segura exige:
1. Gerar CA privada, certificado de servidor com SAN `DNS:vps-postgres` e certificado administrativo com CN `postgres`, sem nenhuma senha.
2. Montar a CA pública e certificado de servidor no PostgreSQL, e material de assinatura e certificado administrativo somente no volume privado do Painel. Arquivos com acesso mínimo (chaves 0600, pastas 0700).
3. Configurar `ssl=on`, `ssl_ca_file`, `ssl_cert_file` e `ssl_key_file` e HBA restritivo:
   ```
   local   all  postgres                   peer
   local   all  all                        reject
   hostssl all  all  0.0.0.0/0             cert
   hostssl all  all  ::/0                  cert
   hostnossl all all 0.0.0.0/0             reject
   hostnossl all all ::/0                  reject
   ```
   A ordem das regras é obrigatória; **não manter nenhuma regra `host ... trust` anterior**. `cert` verifica o CN do certificado com o nome do usuário conectado.
4. Ensaiar com um container descartável, garantindo: sem certificado → recusado; certificado de outro usuário → recusado; certificado correto → conectado.
5. Usar um procedimento de implantação coordenado com retorno possível à configuração anterior se a API perder conexão. A troca de `ssl=on` pode exigir **reiniciar apenas o PostgreSQL**, não apagar o volume.
6. Montar arquivos da CA administrativa no Painel e configurar `PANEL_POSTGRES_TLS_ENABLED=1`, `PANEL_POSTGRES_WRITE_ENABLED=1`, sem qualquer variável `PASSWORD`.
7. Testar dois projetos fictícios, cada um com seu certificado, e a impossibilidade de assumir o usuário do outro. O acesso aos bancos deve ser restrito por permissões reais; containers não recebem certificados de projetos vizinhos.

**Importante:** este PR modifica apenas GitHub. Publicar Pages não atualiza a API que roda no Docker, e nem configura automaticamente o PostgreSQL. Nenhuma senha é necessária ao operador, mas certificados e suas chaves privadas são identidades que devem permanecer protegidas. Renovação/revogação dos certificados é trabalho posterior antes do vencimento de 365 dias.

## Preparação automatizada dos certificados (sem reiniciar PostgreSQL)
A preparação host-only foi adicionada em `server/postgres-mtls-prepare-vps.sh`. Ela gera, sem senhas, uma CA privada, um certificado administrativo para o Painel (CN `postgres`) e um certificado de servidor para `vps-postgres` com SAN `DNS:vps-postgres`. Não lê, imprime ou pede senhas; mantém os arquivos apenas em armazenamento privado do servidor:

- Material administrativo em `softload_panel_data/postgres-tls` (visível para API como `/data/postgres-tls`), incluindo `ca.key`, `ca.crt`, `admin.key` e `admin.crt`.
- Material do servidor em `/etc/vps-postgres-tls/`, com `server.key`, `server.crt`, `ca.crt`.
- O script recusa sobrescrever material existente; gera arquivo novo somente mediante operação administrativa e **não edita nenhum container, HBA, PGDATA, configuração ou banco existente**.
- `server/postgres-mtls-preflight-vps.sh` é leitura: confere SSL, quantos bancos e regras `trust`/`cert` existem e se os certificados foram preparados.

Preparar certificados **não ativa** autenticação TLS. Habilitar `ssl=on` e substituir as regras HBA requer implantação separada e reversível, e verificação de conexão com e sem certificado antes de habilitar criação na interface.
