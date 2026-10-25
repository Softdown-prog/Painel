# Publicar pelo servidor — sem manter o navegador aberto

A tela **Projetos GitHub** agora pode criar um trabalho de publicação na VPS. Depois que você escolhe um **build concluído com sucesso** e confirma **Publicar revisão**, a API continua trabalhando independentemente do navegador. Você pode fechar o celular e consultar a publicação depois.

## Etapas

1. Conferir o vínculo do projeto com o repositório GitHub autorizado e confirmar que a aplicação atual está funcionando.
2. Verificar se a imagem do build já foi importada. Se não, usar o importador GHCR existente: ele valida o workflow, o commit, o digest SHA-256 e o HEALTHCHECK da imagem.
3. Criar uma candidata sem parar a versão atual, usando os mesmos limites e rede.
4. Aguardar a candidata ficar `healthy`.
5. Promover **apenas** a revisão escolhida, verificando seu SHA no backend durante a operação.
6. Consultar novamente o Docker. Só marcar **Concluído** se a revisão ativa estiver funcionando e o backup anterior for preservado.

Se algo não estiver consistente, o estado será **Precisa de revisão**, sem excluir automaticamente os containers.

## Como habilitar na VPS

**Código no GitHub não significa instalado na VPS.** Um administrador precisa primeiro implantar a API correspondente, mantendo os overlays que já estão em uso e um backup verificável. A configuração adicional é `server/compose.publications.yaml` com `PANEL_PUBLICATIONS_ENABLED=1`. Também precisam estar habilitados e funcionais `PANEL_GHCR_PULL_ENABLED=1` e `PANEL_RELEASES_ENABLED=1`, além de token GitHub/GHCR e Docker executor configurados.

Confira o Compose mesclado antes da atualização. Não reinicie os containers da Softload V4 somente para habilitar a função do Painel. Se houver incompatibilidade com a VPS, mantenha o recurso desligado até resolver. Nenhum job real foi iniciado durante o desenvolvimento.

## Funcionamento técnico e limites atuais

- `POST /projects/:slug/publication` recebe **somente** `{"runId":123}`. Requer uma sessão administrativa existente na API. Retorna o trabalho persistido; repetir o mesmo `runId` reutiliza o registro anterior.
- `GET /projects/:slug/publication` retorna o último trabalho e até dez registros recentes. O navegador pode consultar a qualquer momento.
- O estado fica em `/data/publication-jobs.json` (volume `softload_panel_data`), salvo após cada etapa por escrita temporária e rename. O worker é retomado no início da API, a cada ciclo de três segundos.
- Fases possíveis: na fila (`queued`), importando (`importing`), preparando (`staging`), esperando saúde (`health`), promovendo (`promoting`), concluído (`completed`), precisa de revisão (`attention`) ou falhou (`failed`).
- Um trabalho ativo por instalação. Prazo total de até 22 minutos. Retomada segura verifica se candidata e/ou backup existem antes de prosseguir. O backend não executa limpeza automática de reservas e não restaura uma versão sem confirmação humana.
- O processo de publicar uma imagem **ainda começa de um build concluído**. O build do código no GitHub é iniciado separadamente; não é build→deploy contínuo automático sem aprovação.
- O modelo pressupõe **uma API ativa por instalação**. O bloqueio do worker é local ao processo; para duas réplicas de API/múltiplas VPS será necessário um lease/lock persistente e ownership de jobs. **Não habilite duas réplicas do worker** com o mesmo volume antes dessa melhoria.
- Durante uma reinicialização no meio do download, a importação pode precisar ser repetida uma vez. Se a verificação falhar, o job sinaliza revisão manual. Operações já feitas nos containers são reconciliadas com o estado real do Docker.
- Mesmo após o HEALTHCHECK e a promoção, continua necessário verificar a URL externa em HTTPS antes de afirmar que um domínio público está funcionando. Essa é uma tarefa distinta de roteamento de domínios.
- O histórico atual registra etapa e resultado, não cada linha do log Docker. Para falhas, consulte o painel do projeto e o log da API.

## O que falta (para o Codex, se necessário)

Teste de publicação em uma VPS de homologação com Docker e GHCR reais; confirmação do container ativo após reboot; isolamento do worker em múltiplas réplicas; retomada com credenciais rotacionadas; aumento seguro de limite de retenção de histórico; uma experiência **Criar site → gerar build → publicar** em um único fluxo, sem etapas técnicas para o operador.

Arquivo de implementação: `server/publications.ts`. Testes: `server/publications.test.mjs`, `server/publish-ui.test.mjs`.
