# GitHub → VPS: confirmação real, por projeto

## Causas verificadas em 31/10/2026

- O workflow Pages publica somente frontend/Function. Ele não atualizava API nem executor.
- Angular era compilado no Dockerfile opcional, mas não era copiado para o Pages. HTTP 200 em `/angular/` sozinho pode ser o fallback HTML antigo; validar `<panel-app>` e o JavaScript.
- API instalada: `e4469c7...`; executor: `5fdcc96...`; main do Painel: `62e6251...`. Não eram revisões equivalentes.
- Multiplayer Terrânia: Compose em `/root/Terrania/server/compose.yml`, checkout `d69dbd9...`, imagem local sem label de revisão. Nenhum workflow instalava esse backend.
- Softload Blogger estava no SHA de main `c462f28...`. Container parado com exit 0 e gateway saudável não comprova falha: a política existente permite repouso. Não reinstalar por esse motivo.
- O frontend Terrânia é um Worker Cloudflare, não um container VPS; sua falha de credencial é independente e não é corrigida reiniciando o multiplayer.

## Canal independente do painel

`operations/receiver.py` é instalado como código root, por administrador, fora dos projetos. A identidade SSH exclusiva `vpsops` não pertence ao Docker, não tem sudo geral, PTY ou encaminhamentos. Sua única chave tem forced-command para o broker. O broker usa OIDC GitHub com assinatura RSA/JWKS HTTPS fixo, validade curta, audience da VPS, IDs numéricos de ator/repositório, branch main, evento e caminho de workflow permitidos. PRs não recebem esse canal. A política instalada em `/etc/vps-operations/policy.json` associa serviços, imagens e repositórios explicitamente.

Não depende do Pages, não abre porta HTTP administrativa nem reutiliza o runner da Softload. SSH é o transporte privado autenticado escolhido; OIDC acrescenta a identidade da execução. Os secrets `VPS_OPERATIONS_SSH_KEY` e `VPS_OPERATIONS_KNOWN_HOSTS` são exclusivos desse canal; o primeiro não fornece shell livre.

O exemplo de política contém associações verificadas desta VPS, não descoberta por semelhança de nomes. Alterar essa política é uma operação administrativa separada. PostgreSQL, Caddy, túnel e gateways não são serviços do projeto Softload.

## Publicação

`deploy-vps.yml`: testes → imagens construídas no GitHub → GHCR por digest → OIDC + SSH → conferência de labels SHA/source → atualização somente dos serviços registrados → saúde Docker → SHA HTTPS → resultado JSON. A credencial GHCR é o token efêmero do job, somente em stdin/arquivo temporário privado removido após pull. Não é mantida na VPS.

Painel preserva todos os overlays instalados, conta, segredos, redes e volumes. Atualiza `executor` e `api` com `--no-deps`, sem `down`, prune ou remoção de órfãos. Na falha, retorna aos arquivos/imagens anteriores e testa saúde. Não há limpeza de imagens neste fluxo. Registros de Compose e ponteiro são alinhados somente depois da verificação.

Cada projeto tem lock independente. SQLite guarda ID, hash da solicitação e resultado. Repetição idêntica devolve resultado anterior; conteúdo divergente é recusado. Tarefa interrompida permanece marcada para inspeção: não se repete uma mutação silenciosamente. Processos têm timeout e o broker possui prazo máximo; falha de promoção aciona rollback.

Resultados sanitizados ficam em artifacts e resumo do Actions; logs administrativos ficam privados em `/var/lib/vps-operations`. Não publicar saída arbitrária de processos nem variáveis. Não remover a imagem anterior durante a migração.

## Acionar por GitHub/ChatGPT

Em Actions → **VPS operations**, executar `inventory` ou `verify` (projeto + SHA esperado). O conector GitHub disponível no ChatGPT não expõe `workflow_dispatch`, mas permite criar e ler issues. Ponte implementada: uma issue de título exato **`[VPS] inventory`**, criada pela identidade administrativa cadastrada, dispara apenas inventário de leitura e recebe o resultado em comentário. Não executa comandos do corpo, labels ou comentários. A validação OIDC continua obrigatória no host.

Workflows comuns não possuem shell livre. A modalidade administrativa avançada com aprovação específica por execução ainda deve ser integrada separadamente; não substituir isso por parâmetro bash num workflow público. Não declarar essa parte concluída com o canal de diagnóstico/deploy.

## Rollback e instalação

Antes de instalar, registrar imagens, IDs, horários de início, overlays e montagens atuais. Copiar somente os três pequenos arquivos do executor e a política revisada; executar `operations/install-vps.sh` com uma chave pública dedicada. Isso não reinicia containers. Instalação inicial da identidade e atualização de seu código não ocorrem automaticamente a partir de PR.

Manter revisão/imagem anterior e Compose efetivo. O rollout guarda cada release por SHA; um rollback reaplica somente os serviços do projeto. Os mecanismos de deploy já funcionais da Softload não são substituídos pelo do Painel. Migração completa do frontend para VPS é outra etapa: Pages continua protegido e ativo.

## Estados de entrega

Código implementado e testes locais não significam instalado. Registrar separadamente PR/CI, instalação do broker, execução real de diagnóstico pelo GitHub, deploy efetivo, SHA/digest no Docker e resposta HTTPS. Atualizar a tarefa com os runs reais após a instalação.
