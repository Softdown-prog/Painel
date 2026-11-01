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

## Bootstrap sem merge, pela Shell da VPS (alternativa manual)

A restrição atual `main` no OIDC do vpsops impede a etapa de implantação do workflow enquanto a nova implementação está **somente** na branch `feat/angular-complete-migration`. Isso é intencional: não mover a branch para `main` antecipadamente.

Após atualizar `vpsops` com os scripts administrativos previstos, é possível instalar o serviço **somente por sessão Shell administrativa autorizada**, usando `tools/repo-mcp/install-vps-from-source.sh` numa cópia do commit exato. O script faz build local de fonte imutável, verifica labels, exige a política code_mcp instalada, cria exclusivamente `vps-code-mcp`, token local, porta loopback e valida health+401. Ele aborta caso esse nome já exista, não modifica serviço existente e limpa apenas seu próprio container em caso de falha. **Este bootstrap não representa o workflow de deploy pelo Actions**; a implantação pelo Actions ficará para quando o usuário autorizar concluir a migração da branch.

## Rede privada para o Cloudflare Tunnel (código preparado, não ativado)

Inventário real da VPS: `vps-code-mcp` (healthy, rede Docker padrão `bridge`, 127.0.0.1:8789) e `softload-panel-tunnel` (executando na rede `vps_panel_control`). **O Tunnel não enxerga o MCP pela rede atual**; dentro do container Cloudflare, `localhost` não é o localhost da VPS.

`tools/repo-mcp/edge-network.mjs` gerencia somente a rede Docker nova `vps_code_mcp_edge` (bridge interna, sem gateway/portas públicas), com dois containers fixos e com verificações de label, imagem, health, porta loopback e ausência de Docker socket. Não altera o painel, redes preexistentes, Caddy, banco, DNS ou Cloudflare. O código não corre automaticamente em workflows que recebem pushes.

Em uma Shell administrativa aprovada, **após revisar o código e o estado dos dois containers**, a execução do arquivo em um checkout imutável funciona assim:

```sh
node tools/repo-mcp/edge-network.mjs --check
# Somente com aprovação explícita, via root:
node tools/repo-mcp/edge-network.mjs --apply LINK:code-mcp
# Reversão, inclusive se um serviço estiver unhealthy:
node tools/repo-mcp/edge-network.mjs --rollback UNLINK:code-mcp
```

O modo `--check` não faz alterações; os demais exigem root e a confirmação literal. A instalação atual do MCP permanece no endereço loopback, além de receber o alias interno `code-mcp-bridge`.

### Rota HTTPS — configuração separada no Cloudflare

A hospedagem pública **não está feita**. Quando a conexão de rede tiver sido aplicada e validada no host, um administrador deve configurar, no **túnel Cloudflare já existente**, um hostname HTTPS **exclusivo para MCP** e a origem fixa `http://code-mcp-bridge:8789`. O endpoint MCP será `https://<hostname-configurado>/mcp`. Um exemplo de hostname não constitui DNS cadastrado. Não apontar Cloudflare para `http://localhost:8789` (é o localhost de outro container), não abrir porta 8789 na WAN e não alterar as rotas já existentes de Terrania, Softload ou Painel.

Testes de aceitação necessários, sem publicar credenciais em logs:
- Interno: `/health` indica saúde; `/mcp` sem Bearer retorna **401**; POST com Bearer válido e `Accept: application/json, text/event-stream` responde `initialize`.
- Externo: HTTPS válido, hostname exclusivo, `/mcp` sem token retorna 401, `/mcp` com token inválido também 401, chamadas de navegador com Origin inesperado retornam 403. Não copiar o token no chat, issue, logs ou artefatos.
- Revogar a rota pública caso o token seja exposto. Logs de Cloudflare/Caddy devem evitar a captura do cabeçalho Authorization. Pode-se adicionar controles de acesso e rate-limit no Cloudflare sem mudar as credenciais do MCP.

### Compatibilidade de clientes

O servidor HTTP atual é **somente leitura** e recebe **Bearer estático**, gerado localmente e nunca comitado. Clientes compatíveis com MCP que conseguem enviar Bearer customizado podem usá-lo. **Isso não constitui uma implementação OAuth 2.1** e, portanto, não garante integração direta ao ChatGPT ou outros clientes que exijam descoberta/fluxo OAuth. Para esses, implementar um provedor OAuth 2.1 com PKCE, metadados de recurso protegido e tokens com audience correto antes de declarar a integração concluída. Token único também **não concede permissões diferentes para 50 repositórios**. A sincronização de outros repositórios e ACL individuais permanecem pendentes.

Referências: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization e https://developers.cloudflare.com/tunnel/get-started/.

## Ativação da rede pela Shell — sem reiniciar serviços

Para o ambiente de produção, usar `python3` (presente na VPS) em vez de depender do Node instalado no host. `tools/repo-mcp/edge_network.py` possui as mesmas regras de propriedade e rede que o protótipo JS, com testes de idempotência/rollback. Em checkout de revisão fixa:

```sh
sudo python3 tools/repo-mcp/edge_network.py check
sudo python3 tools/repo-mcp/edge_network.py apply LINK:code-mcp
sudo python3 tools/repo-mcp/edge_network.py check
# Reversão explícita, se necessária:
sudo python3 tools/repo-mcp/edge_network.py rollback UNLINK:code-mcp
```

O resultado de apply só confirma a rede interna; não confirma origem do túnel, DNS público ou a conexão com um cliente.

## Smoke de um cliente Streamable HTTP (sem vazar token)

`tools/repo-mcp/client-smoke.mjs` funciona como cliente MCP real: verifica 401 sem token/401 token inválido/403 Origin, negocia `initialize`, chama `tools/list`, `repo_list`, `repo_stats` e `repo_find_files`. Recebe endpoint e caminho do token, mas **não recebe o segredo como argumento**, e só imprime contagens/estados.

```sh
# Em um ambiente Node 24 com acesso ao loopback do host:
node tools/repo-mcp/client-smoke.mjs http://127.0.0.1:8789/mcp /etc/vps-operations/code-mcp-token
# Em cliente autorizado com HTTPS e uma cópia pessoal segura do token:
node tools/repo-mcp/client-smoke.mjs https://SEU-HOSTNAME-CONFIRMADO/mcp /caminho/privado/token
```

`SEU-HOSTNAME-CONFIRMADO` é variável ilustrativa, não DNS criado.

Codex CLI, após um hostname HTTPS configurado e acesso ao token por canal administrativo privado (nunca copie o segredo em chats ou commits):

```sh
# No COMPUTADOR do cliente, com variável CODE_MCP_TOKEN definida no processo:
codex mcp add painel-code --url https://SEU-HOSTNAME-CONFIRMADO/mcp --bearer-token-env-var CODE_MCP_TOKEN
codex mcp list
```

O token da VPS fica em `/etc/vps-operations/code-mcp-token`, com acesso administrativo restrito. Não publicá-lo no GitHub, issue, log ou página do painel. Para conectar um cliente externo, é preciso provisionar o segredo no cliente por meio seguro e garantir que ele esteja no ambiente do processo Codex.

**O token de execução de `cloudflared` em `/etc/softload-panel/tunnel-token` não é um token administrativo da API Cloudflare.** A rota de publicação é configurada separadamente no Dashboard (Networking > Tunnels > túnel existente > Routes > Add route > Published application), hostname exclusivo e Service URL `http://code-mcp-bridge:8789`. Não modificar os hostnames existentes. O hostname público também pode exigir autorização adicional via Cloudflare Access, desde que o cliente suporte o método configurado.
