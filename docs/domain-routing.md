# Domínios de aplicações — gateway isolado

A aba Domínios prepara subdomínios para aplicações Docker gerenciadas. Os arquivos são server/domains.ts, server/router/Caddyfile e server/compose.routing.yaml.

## Escopo e limites

- O operador configura PANEL_APPS_DOMAIN_ZONE em uma zona dedicada como apps.analysepro.com; o hostname de cada aplicação é derivado exclusivamente de seu identificador (exemplo: loja.apps.analysepro.com). Não há entrada para domínios arbitrários.
- Somente até oito aplicações gerenciadas pelo Painel, verificadas por nome e labels, na rede softload_panel_apps podem receber rotas; portas HTTP internas entre 1024 e 65535.
- Os containers preexistentes na rede bridge não são migrados automaticamente. O overlay atribui a rede isolada somente aos novos containers; releases preservam o modo de rede do container anterior.
- Registrar/remover gera configuração em /data/caddy/managed-apps.caddy e um cadastro em /data/domain-routes.json, no volume do Painel. A alteração não muda DNS, não recarrega o Caddy e não garante disponibilidade pública.
- O serviço novo app-gateway escuta internamente em 8081 e não publica portas 80/443 nem monta o Docker socket. O Caddy existente permanece intocado.

## Implantação opcional

1. Revise sua configuração existente e crie um registro DNS curinga para a zona dos aplicativos, apontando para a entrada pública apropriada da VPS.
2. Configure HTTPS para a zona no Caddy existente. Certificados wildcard exigem DNS-01 ou um certificado wildcard previamente emitido; apenas cadastrar o DNS não basta.
3. Adicione ao Caddy existente uma regra estritamente limitada à zona de aplicativos, encaminhando as requisições para app-gateway:8081, preservando Host. Não utilize uma regra que capture os domínios da Softload.
4. Habilite o overlay apenas após revisar todos os overlays e dependências usados na VPS:

    cd /caminho/real/do/Painel/server
    export PANEL_DOMAINS_ENABLED=1
    export PANEL_APPS_DOMAIN_ZONE=apps.analysepro.com
    docker compose -f compose.yaml -f compose.apps.yaml -f compose.routing.yaml up -d --build

5. No painel, crie uma aplicação nova na rede isolada. Na aba Domínios escolha a aplicação e sua porta HTTP interna e selecione Preparar domínio.
6. Confira a configuração gerada e faça uma recarga explícita APENAS do gateway interno:

    docker compose -f compose.yaml -f compose.apps.yaml -f compose.routing.yaml exec app-gateway caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

Se a instalação usa outros overlays de GitHub/Projetos/Releases/GHCR, inclua-os no comando de execução apropriado. **Esses comandos não foram executados na VPS nesta etapa.**

## Endpoints

| Método | Caminho | Função |
| --- | --- | --- |
| GET | /domains | Zona, rede, habilitação e rotas cadastradas |
| POST | /domains | JSON {"slug":"loja","port":3000}, gera rota |
| DELETE | /domains/:slug | Remove rota, preserva o container |
| GET | /domains/caddy | Mostra snippet Caddy preparado |

A exclusão de um container com domínio registrado é bloqueada. Remova a rota e recarregue o gateway antes de remover o container. A API mantém as mesmas exigências administrativas e segredo de borda; não aceita comandos Caddy arbitrários.

## Pendências

- DNS e TLS são configurados pelo operador. O fluxo atual não efetua reload automático do Caddy de produção nem do gateway.
- O proxy poderá retornar 502 para aplicações paradas. Ainda não há ativação sob demanda, monitoramento de saúde pelo gateway nem migração de volumes.
- A API principal continua com Docker socket de poder administrativo. O gateway não tem esse socket, porém um executor Docker de permissões estritas ainda é necessário antes de oferecer a terceiros.
- A publicação de releases atual pode provocar pequena indisponibilidade na troca de nomes.
