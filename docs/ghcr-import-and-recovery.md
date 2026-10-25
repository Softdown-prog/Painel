# GHCR por digest e recuperação segura

Esta etapa acrescenta importação de imagens do GHCR por digest imutável e diagnóstico de deploy interrompido.

## Fluxo no painel

1. Execute o workflow panel-app-build.yml no repositório vinculado e confirme sucesso na branch aprovada.
2. Em Projetos > Consultar builds, selecione Importar do GHCR na execução concluída.
3. A API verifica o run GitHub, resolve a tag sha-<commit> para o digest remoto SHA-256, faz o pull pelo digest e inspeciona a imagem local.
4. Acompanhe o status no cartão. HTTP 202 confirma somente que o trabalho começou. O ID da imagem, digest, revisão e runId são registrados no volume após o pull e a verificação.
5. Clique em Preparar na VPS somente após a importação. A preparação revalida ID da imagem, RepoDigests, labels OCI de origem/revisão e HEALTHCHECK, depois cria uma candidata sem tocar no container atual.
6. Aguarde HEALTHCHECK saudável antes de promover. O container antigo continua como backup; use Restaurar anterior para rollback.

## Rotas novas

| Método | Caminho | Descrição |
| --- | --- | --- |
| GET | /projects/:slug/images/import | Estado da importação e última revisão persistida |
| POST | /projects/:slug/images/import | JSON {"runId":123}; inicia a importação por digest |
| GET | /projects/:slug/releases/recovery | Diagnóstico somente leitura dos três slots |
| POST | /projects/:slug/releases/recovery | JSON {"confirm":"RESTORE_SAFE_STATE"}; restauração segura e explícita |

A restauração só atua sobre containers identificados pelas labels e nomes do painel. Se o container principal desapareceu durante a troca e o backup foi preservado, a API para a candidata se necessário, restaura o backup e o inicia. Se o principal está parado e não existe backup, pode apenas reiniciá-lo. Estados ambíguos ou containers sem labels corretas permanecem bloqueados para revisão manual. Nenhuma recuperação deleta imagens ou containers.

## Ativar na VPS (opt-in)

Esse recurso está desabilitado por padrão. Para imagens públicas, adicione server/compose.ghcr.yaml aos overlays existentes e configure PANEL_GHCR_PULL_ENABLED=1. Configure também os overlays de GitHub, Aplicações, Projetos e Releases se forem usados.

    cd /caminho/real/do/Painel/server
    export PANEL_GHCR_PULL_ENABLED=1
    export PANEL_RELEASES_ENABLED=1
    docker compose -f compose.yaml -f compose.github.yaml -f compose.apps.yaml -f compose.projects.yaml -f compose.releases.yaml -f compose.ghcr.yaml up -d --build api

Para imagens privadas, acrescente server/compose.ghcr-private.yaml e configure PANEL_GHCR_USERNAME. O arquivo /etc/softload-panel/ghcr-read-token deve estar presente na VPS com permissão restrita e um personal access token (classic) com read:packages. Tokens do GHCR nunca devem ir ao frontend ou ao repositório. Pacotes públicos podem ser consultados sem credencial.

Os exemplos são instruções de configuração; não foram executados nesta etapa na VPS.

## Limites e segurança

- A tag SHA pode ser reatribuída por quem possui permissão de gravação no pacote. O digest fixa os bytes da imagem importada, mas metadados GitHub e labels OCI não são atestação criptográfica de autoria.
- É admitida somente uma importação simultânea por processo. A conexão de download tem limite de 10 minutos; a conclusão fica registrada em image-imports.json no volume protegido.
- Se a API reiniciar durante um download, seu estado em memória se perde. Um pull inacabado não registra uma release importada e pode ser repetido.
- A recuperação é confirmada, sob o mesmo lock das operações de release, mas não utiliza journal persistente ou recuperação transacional de qualquer estado arbitrário.
- Ainda não há roteamento de tráfego por domínio, atualizações sem interrupção, migração de volumes, rollback automático por monitoramento, nem verificação de assinatura/attestation.
- Mesmo com docker.sock montado como read-only, o processo da API possui privilégios elevados no host. Não exponha a funcionalidade a terceiros antes de criar um executor isolado, com permissões mínimas e auditoria.
