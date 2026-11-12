# Compilar LHS e Terrania na VPS diretamente deste chat

O Codex não participa. O ChatGPT usa o conector GitHub para abrir uma
Issue com título fixo [VPS] workspace. O workflow já autenticado do Painel
envia uma operação limitada ao executor root-owned da VPS. Nenhum comando
shell ou repositório arbitrário é aceito.

O jogo é baixado por HTTPS diretamente de um repositório público fixo,
na revisão exata (SHA de 40 caracteres). O supervisor Node 24 instalado
cria containers efêmeros com Playwright/Chromium e perfil completo.
O bridge usa um diretório raiz próprio /srv/panel-chatgpt-sources,
propriedade exclusiva do administrador. Ele reutiliza o supervisor de build
sem reutilizar os workspaces ou a execução do Codex.

## Solicitações via ChatGPT com a conexão GitHub

Use título da Issue: [VPS] workspace

1. Conferir habilitação e supervisor (sem alterar containers):

~~~json
{"action":"check"}
~~~

2. Teste integral do Lan House Simulator:

~~~json
{"action":"start","project":"lhs","profile":"lhs-precommit","sha":"SHA_DE_40_CARACTERES_DO_COMMIT"}
~~~

3. Teste integral do Terrania:

~~~json
{"action":"start","project":"terrania","profile":"terrania-precommit","sha":"SHA_DE_40_CARACTERES_DO_COMMIT"}
~~~

4. Consultar o recibo e resultado de um job:

~~~json
{"action":"status","jobId":"ID_HEXADECIMAL_DE_16_CARACTERES"}
~~~

Os SHA e IDs acima são placeholders e devem ser substituídos
pelos valores reais do GitHub e dos recibos. O workflow responde com
comentário no issue; o ChatGPT pode ler o resultado com seu conector.
Um recibo queued não é um resultado: somente passed=true na consulta
significa que toda a suíte passou. Falha de compilação deve ser reportada
explicitamente, nunca convertida em check verde.

O CI do bridge testa assinatura OIDC, autorizações, payloads, acesso
limitado a projetos, proibição de comandos arbitrários e prevenção
de vazamento de logs para Issues. Logs privados continuam na VPS;
um status público indica a etapa do erro, sem publicar credenciais.

## Habilitação no host: passo administrativo separado

Alterar os arquivos do GitHub não altera o programa receptor root
instalado na VPS. O bridge fica INATIVO até um administrador instalar
o receiver e a nova operação na política de host. Uma vez aprovado o
checkout e os testes do GitHub, executar como root (sem Codex):

~~~sh
sudo sha256sum /usr/local/lib/vps-operations/receiver.py /usr/local/lib/panel-workspaces/workspace_build.py
sudo bash operations/install-chatgpt-workspace-vps.sh check /checkout/revisado/Painel HASH_RECEIVER_INSTALADO HASH_SUPERVISOR_INSTALADO
sudo bash operations/install-chatgpt-workspace-vps.sh apply /checkout/revisado/Painel HASH_RECEIVER_INSTALADO HASH_SUPERVISOR_INSTALADO
~~~

O install verifica o hash da versão instalada, os componentes root-owned,
o supervisor e a política de operação autenticada. O modo check não
modifica arquivos. O modo apply atualiza apenas receiver, helper, supervisor e
permissão da nova operação, sem reiniciar API, Caddy, PostgreSQL, Codex,
runner ou containers de produção. Não altera os fluxos de deploy.

O servidor precisa ter git, acesso HTTPS aos repositórios públicos
e pelo menos 6 GiB livres para preparar a revisão. O supervisor
verifica disponibilidade de memória para Chrome, e o bridge bloqueia
compilações simultâneas na VPS de 4 GB. Cada revisão usa sua própria pasta imutável; antes de um novo teste,
o bridge verifica que não há compilação em andamento e remove cópias
anteriores do mesmo jogo que tenham proveniência validada. Não mantém
backups locais de fontes. Isso é separado da limpeza de imagens Docker.

O teste CI do GitHub sozinho não comprova execução na VPS. Após
instalação, homologar check, start e status com as revisões reais
dos dois jogos. Nenhum PR, merge ou deploy é executado pelo bridge.
