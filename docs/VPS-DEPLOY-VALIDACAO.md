# Validação real GitHub → VPS — 31/10/2026

Este documento registra execuções comprovadas. SHAs abaixo são snapshots datados, não uma promessa de que a main nunca mudará. Cada nova publicação tem seu próprio artifact `vps-result.json` com a revisão instalada e os digests.

## Resultado comprovado

| Componente | Revisão validada | Evidência |
| --- | --- | --- |
| Painel API e executor | `15b227223b8ca8e15c92d32ba0bb3425c89acb6e` | [Deploy completo, exit 0](https://github.com/Softdown-prog/Painel/actions/runs/41174473482), saúde Docker + SHA HTTPS, outros serviços preservados |
| Frontend legado e Angular | mesma revisão | [Pages aprovado](https://github.com/Softdown-prog/Painel/actions/runs/41174473522), `/release.json`, `<panel-app>` e JS real em `/angular/`, sessão API 200 |
| Terrânia multiplayer | `ca2fb6f1fd3f648c20d00d9fe1fd7c9abd40ce52` | [Deploy completo](https://github.com/Softdown-prog/Terrania/actions/runs/41174722224), imagem por digest, `/health` com SHA, dois jogadores e movimento via WSS |
| Softload Blogger | `c462f28be2cd91108217f8184a9f5b94a333df7b` | [Deploy preexistente aprovado](https://github.com/Softdown-prog/Softloadv4/actions/runs/41141715259), main atual conferida, container e `/health` com mesmo SHA após despertar |

API Painel: digest `sha256:da9b628d41e5e4019391891e789c59272d68c9de41095db3ef540141f1fe59f3`.
Executor Painel: digest `sha256:fa854ffc84879771c92bfba1f0e7dcbe326f24bd679ed8a2b1f6a99acd909bf4`.
Os digests do Terrânia e das futuras revisões estão no resultado de cada run, sem tags mutáveis como prova.

## Causas separadas

1. **API/executor antigos:** faltava workflow de instalação. Pages atualizava somente estáticos/Function. Corrigido com `deploy-vps.yml` e broker exclusivo, sem dar privilégios ao runner Softload.
2. **Angular ausente:** pacote Pages copiava apenas arquivos de raiz; agora compila `angular/`, publica seu bundle e verifica JS/HTML/revisão por HTTPS. HTTP 200 isolado não bastava, pois o Pages podia retornar fallback legado.
3. **Multiplayer antigo:** CI construía/testava Docker mas não instalava. Novo workflow por projeto entrega GHCR por digest e preserva redes, quotas e origens.
4. **Probe recusado:** primeiro rollout do Painel, run `41174011471`, iniciou imagens corretas, mas HTTP 403 no User-Agent Python provocou rollback real para e446/5fdcc. Probe explícito `VPS-Operations-Healthcheck/1.0` devolveu 200 no mesmo IP e URL. Corrigido sem modificar Access ou regras Cloudflare. A versão anterior voltou saudável; o run permaneceu vermelho.
5. **Smoke WSS desatualizado:** teste público fixava protocolo 2, aplicação atual usa 3. Passou a importar a versão compartilhada; teste real de movimento e origem continuou obrigatório e passou no novo deploy.
6. **Softload parada:** repouso intencional, exit 0. Requisição à página despertou o mesmo container; saúde e SHA c462 confirmados. Não houve rebuild/reinstalação por estar em repouso.

## Inventário e associações verificadas

| Container | Responsabilidade / repositório | Publicação |
| --- | --- | --- |
| `softload-panel-api` | Painel, `Softdown-prog/Painel` | `deploy-vps.yml`, main, SHA OCI/digest + HTTPS |
| `softload-panel-executor` | Painel, mesmo repositório | mesmo workflow; `network_mode: none` |
| `terrania-origins-multiplayer-1` | `Softdown-prog/Terrania` | `deploy-vps.yml`, main, SHA OCI/digest + HTTPS/WSS |
| `softload-vps-app-1` | `Softdown-prog/Softloadv4` | `deploy.yml`, main, receptor próprio v3 app-only, rsync checksum + saúde/SHA HTTPS |
| `vps-postgres` | banco compartilhado independente | instalação administrativa; sem workflow/revisão de aplicação atribuídos |
| `softload-caddy` | proxy HTTPS compartilhado independente | instalação administrativa; sem revisão GitHub atribuída |
| `softload-panel-tunnel` | túnel privado administrativo | upstream cloudflared; não atribuir seu SHA à Softload |
| `softload-panel-app-wake` | gateway de aplicações gerenciadas | instalação anterior; revisão exata da imagem não rotulada, pendente |
| `softload-panel-app-gateway-1` | roteamento privado de aplicações | Caddy 2.10.2; sem revisão GitHub atribuída |
| `softload-wake` | despertar legado do Blogger | imagem blogger-only; revisão GitHub exata pendente |

Nenhum LHS, Agent, Sandbox, Embeddings ou Portainer foi encontrado na VPS. Não mover/remover recursos do LHS fora desta VPS. O frontend Terrânia é Worker Cloudflare, não container; a credencial ausente de sua publicação automática permanece pendência separada, sem afirmar que o workflow VPS a corrigiu.

Registro operacional central: `/etc/vps-operations/policy.json` associa projetos, repositórios, imagens e serviços; `/var/lib/vps-operations/audit.sqlite` conserva IDs, hashes e resultados reais. O workflow de inventário inclui containers externos ao cadastro. Labels ausentes permanecem nulas, sem inventar commit.

## Canal do ChatGPT comprovado

A ferramenta GitHub conectada criou a [issue #39](https://github.com/Softdown-prog/Painel/issues/39). Isso acionou [run 41174105744](https://github.com/Softdown-prog/Painel/actions/runs/41174105744), chegou por SSH/OIDC à VPS, executou inventário Docker e publicou resultado em comentário, recuperado pela mesma integração: **exit 0, 1,617 s**.

O conector atual não expõe `workflow_dispatch`; a ponte de issue é somente leitura, com título/identidade autorizados. Deploys ocorrem por push na main ou Actions/CLI. Comandos arbitrários do corpo da issue não são interpretados. Shell livre com aprovação por execução continua uma modalidade separada, ainda não fornecida por esses workflows.

## Testes e preservação

- 180 testes Node/Linux aprovados, incluindo sockets, contas, banco, inventário e transporte; nenhum teste ignorado.
- 14 testes do broker: assinatura OIDC e adulteração, identidade/branch/workflow, projeto errado, shell negado, expiração, replay, timeout, SHA real, HTTPS e rollback isolado.
- CI construiu Docker real e confirmou fronteiras API/executor e frontend privado.
- Terrânia: tipos, build, testes de frontend/servidor, Docker e smoke público com dois jogadores.
- Mesma conta administrativa do Painel (checksum do arquivo antes/depois idêntico), volumes e segredos preservados. PostgreSQL conectado. IDs/horários dos proxies, túnel, banco e gateways preservados. Softload apenas despertou sob demanda, sem recriação.
- Disco no momento da validação: 55 GB, 7,1 GB utilizados, 45 GB livres. RAM disponível aproximadamente 2,8 GB. Nenhum prune/limpeza, DNS ou política de acesso alterados.

## Operação e rollback

Actions → **Deploy verified Panel backend to VPS** ou **Deploy verified Terrania multiplayer to VPS**. A execução só fica verde após o executor devolver SHA/saúde/HTTPS corretos; o Terrânia acrescenta WSS. Artifacts contêm o resultado sanitizado. Para inventário: **VPS operations**, ou issue administrativa `[VPS] inventory` pela integração conectada.

Cada projeto tem lock e comando de ativação restrito. Em falha de ativação/saúde/SHA o broker reaplica somente o Compose anterior e aguarda saúde. O primeiro rollout do Painel exercitou essa reversão em produção, sem tocar nos demais projetos. Imagens/revisões anteriores foram preservadas; não foi executada limpeza durante o incidente. O receptor da Softload existente não foi substituído e sua confirmação pública passou na auditoria.
