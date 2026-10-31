# PostgreSQL multiprojetos — integração com o Painel

## Estado

O operador confirmou na VPS que PostgreSQL 18 está rodando como container vps-postgres, e que criou e apagou um banco de teste. A API do painel ainda precisa de deploy autorizado e verificação de conexão real. O PostgreSQL é um serviço compartilhado da VPS e não pertence a nenhum projeto específico.

## O que esta mudança entrega

- GET /database/status autenticado verifica PostgreSQL diretamente apenas quando a integração é habilitada.
- Mostra versão, contagem de bancos não-template, conexões, ocupação total e até 100 bancos com nome, proprietário e tamanho.
- UI diferencia conectado, não habilitado e indisponível; jamais fabrica números.
- Acesso SQL fixo de leitura. Não implementa criação, exclusão, edições, consultas arbitrárias ou backup.
- Não instala nada na VPS; não toca nos volumes PostgreSQL, DNS, Caddy ou containers hospedados.
- A ativação é opcional, no overlay server/compose.postgres.yaml.

## Ativar posteriormente, em deploy coordenado

Verifique primeiro que a rede Docker vps_pg_private já existe e que vps-postgres responde nela. O overlay conecta SOMENTE a API do Painel a essa rede externa; a API também continua na rede administrativa vps_panel_control. O executor Docker continua sem rede.

Para validar a combinação dos arquivos em uma máquina com acesso ao Docker:

    docker compose -f server/compose.yaml -f server/compose.postgres.yaml config --quiet

Para ativar, inclua server/compose.postgres.yaml na implantação autorizada, preservando os outros overlays reais do painel. Não substitua a lista de arquivos usada em produção sem conferi-la. Não use down -v; não altere volumes; não reinicie desnecessariamente o túnel. O deploy Pages da interface NÃO atualiza a API na VPS.

A integração define PANEL_POSTGRES_ENABLED=1, PANEL_POSTGRES_HOST=vps-postgres, PANEL_POSTGRES_PORT=5432, PANEL_POSTGRES_DB=postgres e PANEL_POSTGRES_USER=postgres. Sem a flag, a API continua respondendo not_configured. Se o banco ou rede não responderem, a API retorna unavailable (não mascara como zero nem divulga erro interno).

## Limitação de segurança importante

A instância existente foi criada com POSTGRES_HOST_AUTH_METHOD=trust para funcionar sem senha. Isso não limita o número de bancos, mas QUALQUER container que tenha acesso a essa rede pode se identificar como qualquer usuário do PostgreSQL, inclusive superusuário. Logo, a rede privada não equivale a autenticação nem isola usuários de diferentes projetos. Não adicionar containers de clientes ou projetos não confiáveis diretamente à rede administrativa do PostgreSQL. Este PR só consulta dados; operações de escrita e permissões por projeto precisam de etapa separada de segurança.

## Testes e validação real

Console CI e Docker integration smoke passaram para eb994e7 (runs 41151858886 e 41151858841), mas o teste extra do overlay e a revisão final ainda exigem novo CI. Validar typecheck, build:frontend, npm test, check:js e Compose. Após deploy coordenado da API: abrir Sistema → Banco de Dados, clicar Verificar situação e confirmar dados reais. Testar também a API sem sessão (401), sem flag (not_configured), com rede interrompida (unavailable) e os controles de escrita desabilitados.

Não classificar API conectada ou recurso publicado apenas porque CI passou. A implantação e conexão real na VPS ainda devem ser confirmadas separadamente.
