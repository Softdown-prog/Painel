# Tarefas para o Codex — Painel da VPS Softload

> **Leia primeiro:** este documento registra o que falta fazer ou validar. Não marque itens como concluídos sem testes e provas no GitHub. O objetivo é transformar o painel em um gerenciador de hospedagem **rápido, amigável e seguro**, que comece em uma VPS pequena e possa crescer até vários servidores, sites e clientes.
>
> **Estado de referência:** GitHub `Softdown-prog/Painel`, branch `main`, interface Cloudflare Pages, backend Node 24/TypeScript e Docker Compose na pasta `server/`.

**Limite atual de capacidade:** são permitidas até **8 aplicações gerenciadas** por instalação. Esse teto é uma proteção temporária do protótipo, não o desenho final de hospedagem de clientes. Aumentar o limite exige controle por servidor, cotas, separação de clientes e observabilidade (tarefa C07).

## Regra principal de experiência

O usuário quer ações simples: **Criar site**, **Conectar GitHub**, **Escolher domínio**, **Publicar**, **Ver se está funcionando**, **Reiniciar**, **Fazer backup** e **Excluir**. Nunca mostrar comandos, identificadores internos ou configurações do Caddy na tela principal. Explicar limitações em português do Brasil, sem fingir que algo está pronto.

### Situação real no código

| Área | Estado confirmado no repositório | O que falta |
| --- | --- | --- |
| Visão geral | Listagem e métricas de serviços autenticados | Saúde por aplicação, atualização em tempo real, alertas |
| Sites e apps | Criar/iniciar/parar containers permitidos, recursos, logs e parada por inatividade | Wizard de hospedagem, redes/portas, arquivos persistentes, escala além de 8 |
| Projetos GitHub | Conexão de repositório, builds, pull opt-in por digest, releases com backup | Publicar do GitHub com validação final e rollback guiado, sem passos manuais |
| Endereços | Reserva de `slug.apps.zona` na rede dedicada e arquivo Caddy gerado | Aplicação pública automática e verificada, domínios próprios de clientes, TLS |
| Executor Docker | Isolado em outro container, socket Unix, testes simulados e Docker real no CI | Implantação real autorizada, auditoria durável, política por cliente |
| Clientes e múltiplas VPS | **Não implementado** | Contas/organizações, cobrança, servidores, cotas e migração |
| Deploy da API no host | **Não implantado por esta automação** | Acesso administrativo restrito específico para o Painel, backup e rollback |
| CI | Testes de código, Compose, smoke com Docker real em runner temporário | E2E do usuário no navegador e smoke seguro na VPS |

## P0 — Resolver antes de vender hospedagem

### C01 · Implantação controlada do backend na VPS

**Por que:** a interface Cloudflare Pages pode ter código mais novo do que a API instalada na VPS.

**Onde olhar:** `server/compose.yaml`, `server/Dockerfile`, `server/executor.Dockerfile`, `server/preflight-vps.sh`, `docs/docker-executor.md`.

**Implementar/validar:**
- Inspecionar, sem imprimir segredos, os serviços existentes, overlays Compose realmente em uso, backups, UID do volume `softload_panel_data`, redes, processos e healthchecks.
- Executar o preflight **somente leitura**. Fazer backup verificável antes de qualquer mudança.
- Configurar um mecanismo de publicação **específico do Painel**, auditado, com credenciais mínimas, um deployment por vez e rollback. **Não** ampliar permissões do `softloadrunner` do projeto Softloadv4 ou reutilizar seus comandos SSH restritos.
- Subir o executor e depois a API apenas com plano de contingência. Verificar os containers atuais e páginas autenticadas. Não reiniciar a Softload V4 sem necessidade.
- Registrar data, revisão, checagens e resultado. Se não houver privilégio autorizado, **registrar bloqueio e deixar instruções para o operador**, sem burlar o acesso.

**Aceite:** executor saudável, API funcionando pela URL do painel, serviços Softload intactos, API sem bind do Docker socket real, plano de rollback testável. Não declarar sucesso só porque o GitHub Actions passou.

### C02 · Domínio de verdade com um clique (após C01)

**Por que:** hoje o painel só reserva o endereço e gera um arquivo. **Não publica o site**.

**Onde olhar:** `server/domains.ts`, `domains-ui.ts`, `server/router/Caddyfile`, `server/compose.routing.yaml`, `docs/domain-routing.md`.

**Implementar:**
- Wizard `Aplicação → Endereço → Publicar` com resumo antes de confirmar. Suportar **domínio próprio do cliente** (`cliente.com`, `www.cliente.com`) além de subdomínio do painel, somente após prova de controle do domínio e prevenção de domínio já ocupado.
- Verificar DNS e criar/renovar HTTPS de forma segura, inclusive domínio raiz, com tratamento de falha; não presumir certificado wildcard automático.
- Adicionar gerenciamento de configuração do gateway com validação antes da troca, recarga segura e rollback, sem editar arquivos do Caddy principal sem autorização explícita.
- Exibir estados confiáveis: `Não configurado`, `Aguardando DNS`, `Certificado em andamento`, `Publicado`, `Erro — ver detalhes`; só usar **Publicado** após teste HTTPS externo com hostname correto.
- Permitir remover o domínio e despublicar sem excluir os arquivos do cliente; isolar redes e impedir roteamento para containers de outro cliente.

**Aceite:** site de teste responde corretamente por HTTPS com domínio verificado; troca de domínio e reversão são idempotentes, auditadas e têm testes. Não direcionar domínio de produção para um serviço que ainda não foi verificado.

### C03 · Publicar projeto GitHub em fluxo guiado

**Por que:** conectar repositório, gerar imagem, importar e promover ainda exige várias etapas manuais.

**Onde olhar:** `github-ui.ts`, `projects-ui.ts`, `server/github.ts`, `server/projects.ts`, `server/image-import.ts`, `server/releases.ts`, `templates/panel-app-build.yml`.

**Implementar:**
- Fluxo `Conectar GitHub → Selecionar repositório → Escolher RAM/CPU → Publicar`; mostrar etapa atual e necessidade de autenticação, sem exibir token.
- Revalidar permissão do repo, branch/workflow, origem/proveniência da imagem, digest, limites, healthcheck e aprovação humana antes da troca.
- Logs amigáveis e URL de cada tentativa; backup automático da versão anterior e botão **Voltar à versão anterior**, com auditoria e diagnóstico.
- Não presumir que todos os repositórios são Node.js, nem executar scripts fornecidos por clientes com o mesmo privilégio do painel.
- Preservar volumes e configurações conforme política explícita; impedir promoções simultâneas ou cruzadas.

**Aceite:** um site de demonstração pode ser publicado e atualizado do GitHub seguindo ações claras, com falha simulada e rollback verificado.

### C04 · Segurança para sites de clientes (bloqueador multiusuário)

**Por que:** um único operador e um socket Docker com poder de administrador **não** são suficientes para terceiros não confiáveis.

**Implementar:**
- Organizações/clientes, papéis (dono, operador, visualizador), autenticação reforçada, isolamento por projeto, quotas e trilha de auditoria com identidade e request ID.
- Separar completamente o plano de controle do código executado pelos clientes; negar acesso de cliente ao socket, rede interna, segredos da Softload e metadados do host.
- Políticas de imagens confiáveis, recursos, volumes, rede de saída, limites de número de containers; prevenção de abuso, rate limit e logs sem senhas.
- Simular ataques de container cruzado e recursos indevidos em testes automatizados.

**Aceite:** um cliente não consegue listar, reiniciar, acessar logs, segredos ou domínios de outro cliente. Revisão de segurança antes de exposição pública.

## P1 — Hospedar clientes com praticidade

### C05 · Tela única “Meus sites”
Mostrar nome, endereço, status **confirmado**, consumo, GitHub conectado, último deploy e ações `Abrir site`, `Atualizar`, `Reiniciar`, `Ver registros`, `Backup`. Ajustar `index.html`, `apps-ui.ts` e backend necessário. Fazer pesquisa e filtros para dezenas/centenas de sites; **não** carregar todos os logs de uma vez. Aceite: administrar um site frequente sem passar por várias telas.

### C06 · Arquivos, variáveis e bancos de dados
Volumes persistentes com backup e restauração, quotas de disco por aplicação, variáveis de ambiente e segredos criptografados com redação em logs. Nunca armazenar chaves GitHub em HTML/localStorage ou imagens. Suportar conexão a banco por projeto com limites, sem compartilhar credenciais. Aceite: reiniciar/atualizar um site sem perder dados.

### C07 · Escalar para mais clientes e mais VPS
Remover a suposição fixa de 8 apps por meio de capacidade configurável com teto por host; não retirar limites de segurança indiscriminadamente. Criar inventário de servidores, CPU/RAM/disco disponíveis, tags, agendamento de aplicação, migração segura, grupos/ambientes (dev/homologação/produção) e estratégia de distribuição, sem misturar serviços internos da Softload com hospedagem de clientes. Começar com uma VPS pequena, permitir outra VPS sem reescrever todo o painel. Aceite: acrescentar um segundo servidor em homologação e administrar duas aplicações em hosts diferentes sem exposição de credenciais.

### C08 · Backup, recuperação e histórico
Backups automáticos e testados (restauração periódica), snapshots apenas quando compatíveis, histórico de operações, jobs duráveis com estados e repetição segura de deploys interrompidos. Aceite: recuperação demonstrada após falha de um deploy e de uma aplicação persistente.

### C09 · Monitoramento e orçamento da VPS
Painel simples de consumo por aplicação (memória, CPU, armazenamento, tráfego), alertas de disco/RAM e de indisponibilidade, limites de custo por cliente e estimativas sem inventar cobrança exata. Métricas amostradas sem sobrecarregar VPS pequena. Aceite: alerta antecipado antes de esgotar disco/memória e visão agregada por host.

## P2 — Operação de hospedagem

### C10 · Clientes, planos e cobrança
Cadastro, convite, isolamento por cliente, planos com limites e cobranças, suspensão reversível com avisos, política de retenção e backups antes de exclusão. Não permitir que atraso de pagamento exclua dados sem política clara.

### C11 · Templates e hospedagem simples
Modelos aprovados para sites estáticos, Node, Python e outros stacks com controles por tecnologia; deploy em 1–3 ações sem precisar conhecer Docker. Confirmar runtime detectado, build e configuração antes de publicar. Não aceitar Dockerfile arbitrário com privilégio elevado na VPS.

### C12 · Testes de usabilidade mobile e acessibilidade
Ensaiar os fluxos `Criar → GitHub → Endereço → Publicar` em Android e desktop, botões legíveis, mensagens de erro recuperáveis, labels acessíveis, tela vazia com próximo passo e skeletons. Testes E2E completos com Playwright somente em ambiente isolado (não alterar sites dos clientes).

## Como o Codex deve trabalhar

1. Ler `AGENTS.md`, este arquivo, `docs/GUIA-RAPIDO.md` e o estado atual da `main`. Verificar se alguma tarefa já foi resolvida por commits mais recentes.
2. Escolher a primeira tarefa P0 ainda não concluída e registrar escopo, riscos, dependências e testes antes de alterar.
3. Fazer implementação incremental, preferindo TypeScript no código novo, sem copiar as aplicações existentes para dentro do painel. Sincronizar JS compilado de frontend com os fontes `.ts`.
4. Executar `npm run typecheck`, `npm test`, `npm run check:js`, `npm run build:frontend` e os testes Docker/Compose relevantes.
5. **Nunca** publicar alterações administrativas na VPS sem caminho autorizado, backup e plano de rollback; não imprimir segredos e não contornar restrições do runner.
6. Atualizar este documento indicando **implementado no código**, **testado em CI**, **publicado no frontend** e **validado na VPS** como situações distintas. Incluir SHA, link do CI, prova e o que ficou pendente.
7. Informar o resultado em termos simples: `o que mudou`, `como usar`, `o que ainda falta`.

## Melhorias de linguagem obrigatórias

- Prefira `Criar aplicação` a `Docker create`; `Endereço` a `rota`; `Publicar` a `promover candidata`; `Ver registros` a `tail logs`.
- Se for inevitável mostrar `porta`, explicar que é o número de acesso **interno do programa**.
- Deixe `configuração Caddy`, `digest`, `GHCR` e `network` em área avançada.
- Nunca escrever `Publicado` ou `Tudo certo` se só houve cadastro de rota, build, pull de imagem ou sucesso em CI.
- Não criar “botão mágico” que executa ações destrutivas sem explicar efeitos e obter confirmação.

## Termos e arquivos de apoio

Guia de uso: [GUIA-RAPIDO.md](GUIA-RAPIDO.md). Domínios técnicos: [domain-routing.md](domain-routing.md). Segurança e instalação: [docker-executor.md](docker-executor.md). Importação GitHub: [ghcr-import-and-recovery.md](ghcr-import-and-recovery.md).
