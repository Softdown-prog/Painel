# Banco de Dados — preparação da interface sem PostgreSQL

## Estado atual
A aba **Sistema → Banco de Dados** existe para preparar a administração multiprojetos.
**Nenhum PostgreSQL, pgAdmin, Adminer, driver, volume, container ou porta foi criado**, e nenhuma credencial de banco é requerida.
A API disponibiliza apenas `GET /database/status`, após autenticação administrativa (sessão e chave da borda), respondendo `integration: not_configured`.
Todas as demais rotas sob `/database` respondem indisponível (503), e POST em `/database/status` é recusado (405).

A interface tem seções de Visão geral, Bancos e projetos, Usuários e acesso, Tabelas e consultas, Cópias e recuperação e Monitoramento. Os indicadores são **—**, não zeros nem números fictícios. Botões destrutivos/de criação permanecem desabilitados e sem chamadas a servidores.

## Arquitetura pretendida — somente para uma etapa futura, com autorização
- Uma instância PostgreSQL por host; um banco por projeto, e uma role LOGIN por aplicação com permissões restritas. O usuário administrativo não deve ser utilizado por aplicações.
- Rede Docker privada entre API e banco, nenhuma exposição de porta 5432 no host, sem acessar PostgreSQL a partir do Pages/navegador.
- API com adaptador isolado, timeout e limites de requisição, allowlist de operações; consultas iniciais paginadas e só leitura. Não aceitar SQL arbitrário no navegador.
- Operações de criação/rotação/exclusão com autenticação de sessão, confirmação, validação de nomes e posse de projeto, auditoria e separação de papéis.
- Segredos armazenados apenas em local protegido na VPS, fora do Git e fora de logs, com rotação controlada.
- Segurança contra SQL injection: identificadores validados, parâmetros SQL para valores e nunca interpolar SQL enviado por clientes.
- Medição real de conexões, tamanho por banco, queries lentas e uso de WAL; apresentar indisponível quando não houver acesso, sem inventar métricas.
- Recuperação com cópias consistentes, retenção, criptografia e um destino fora da VPS; testes de restauração antes de habilitar botão Restaurar.
- Recursos e operação de banco distintos do executor privilegiado de Docker; API sem acesso geral a arquivos do host e sem abertura de novo domínio.
- Aprovação explícita e plano de reversão antes de instalar, mudar Docker/Compose, redes, volumes, Caddy ou credenciais.

## Contrato futuro
Até o adaptador PostgreSQL ser desenvolvido e auditado, o endpoint de status continuará `not_configured`; a interface não marca ações como disponíveis.
Um estado real de conexão, listas de bancos, contas, projetos, tabelas e métricas só poderá ser exibido após implementar e testar novas rotas autenticadas.
O cadastro de projetos do Painel **não** implica existência automática de um banco.
