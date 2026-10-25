# Revisões e espaço na VPS — como funciona

Esta funcionalidade ajuda a impedir que a VPS pequena acumule **imagens antigas de aplicações** a cada publicação. Ela foi implementada no código do Painel, mas **precisa que a nova API e o executor sejam instalados na VPS** antes de funcionar com dados reais.

## Onde clicar

1. Abra o painel e escolha **Revisões e espaço** no menu.
2. Clique em **Verificar agora** para ver as revisões que foram importadas pelo próprio Painel.
3. Veja quantas estão em uso, protegidas como backup ou antigas e elegíveis para limpeza.
4. Quando o módulo estiver habilitado no servidor, clique em **Ativar limpeza automática**. A API fará uma verificação a cada 6 horas, mesmo que a página esteja fechada.
5. Se preferir, use **Limpar antigas agora** e confirme. O Painel registra as remoções e as falhas no histórico.

### Também funciona pelo Terminal VPS

- `revisoes` — situação atual, revisões antigas e proteção.
- `revisoes limpar` — pede confirmação antes de limpar as imagens antigas elegíveis.
- `revisoes auto ligar` — ativa a limpeza programada.
- `revisoes auto desligar` — pausa a limpeza programada.

## O que fica protegido

- **A imagem que um container gerenciado usa**: versão ativa, candidata de teste ou backup para rollback.
- **As duas últimas revisões importadas de cada aplicação**, mesmo quando nenhuma delas está em execução.
- **Toda imagem com menos de 14 dias** de importação.
- **Imagens compartilhadas** com uma revisão protegida.
- **Qualquer imagem usada por outro container na VPS**, verificada pelo executor diretamente no Docker antes de autorizar a exclusão, inclusive containers que não pertencem ao Painel.

A limpeza **não** roda `docker system prune` ou `docker image prune -a`, não remove containers, redes, volumes, bancos de dados ou imagens de outros proprietários do registro. A exclusão é individual, pelo digest GHCR que o próprio Painel registrou e validou. Se a verificação falhar, a imagem não é removida.

**Atenção:** preservar imagens não é equivalente a guardar backups de arquivos e bancos de dados. Não use limpeza de revisões como substituta dos backups.

## Diferença entre revisão, imagem e backup

- **Revisão:** versão do código produzida pelo GitHub, identificada por um SHA.
- **Imagem Docker:** pacote do programa baixado do GHCR para a VPS. É esse pacote que pode ocupar espaço mesmo sem estar em execução.
- **Container:** processo e configuração criada a partir de uma imagem. A rotina nunca apaga containers.
- **Backup de rollback:** container antigo mantido pelo mecanismo de releases. Continua protegido até o administrador finalizar uma publicação; apagar esse backup é uma operação diferente.
- **Volume:** área de arquivos permanentes do aplicativo. Nenhum volume é tocado pela rotina.

O espaço apresentado é **estimado** a partir do tamanho das imagens no Docker; o espaço realmente recuperado pode ser menor por causa de camadas compartilhadas. Se a VPS estiver ficando sem espaço, veja também volumes, logs, cache de build e dados de aplicações; este módulo não faz limpeza geral.

## Como habilitar na VPS

A configuração do código é opt-in. O operador autorizado deve instalar a versão atualizada de **API + executor** com os overlays que já estão em uso, conferir a comunicação, backup e saúde dos serviços e acrescentar `server/compose.revisions.yaml`:

```bash
# Exemplo de configuração do recurso; revise os demais arquivos Compose em uso na VPS.
PANEL_REVISIONS_CLEANUP_ENABLED=1
PANEL_REVISIONS_AUTOMATIC=0
```

A primeira variável libera a limpeza por imagens específicas; a segunda define o valor inicial da limpeza programada. Depois que o backend estiver instalado com `PANEL_REVISIONS_CLEANUP_ENABLED=1`, você pode **ligar e desligar pelo próprio Painel ou pelo Terminal VPS**, sem reiniciar o servidor. Isso fica salvo em `/data/revision-cleanup-settings.json`. O histórico fica em `/data/revision-cleanup-history.json`, com os 25 últimos resultados.

No código, a API registra as revisões importadas em `/data/image-imports.json`. O relatório e a limpeza leem somente os registros autorizados dessa base, verificando também a existência e identidade da imagem Docker.

### Pontos importantes antes de ativar

- A conta e o acesso à VPS devem permitir o deploy do backend e do executor. O frontend Cloudflare Pages sozinho não remove nenhuma imagem da VPS.
- O executor necessita da versão com a autorização de `DELETE /images/…?force=0&noprune=1` e confirmação de que nenhum container do host usa a imagem.
- A limpeza programada usa temporizador do processo da API. Se a API estiver desligada, não há limpeza; após reiniciar, o intervalo recomeça. Para agendamento persistente, monitoramento e envio de alertas, veja o backlog do Codex.
- Evite rodar limpeza durante manutenção de releases ou importação manual fora do Painel. Se o Docker recusar uma remoção, o item fica registrado como falha e pode ser revisado.
- A remoção de uma imagem antiga não é um evento de deploy e não muda qual container está ativo. Se uma revisão antiga removida for necessária no futuro, será preciso importá-la novamente.
- Se a imagem tiver tags/digests compartilhados, a exclusão por digest pode retirar somente aquela referência, sem recuperar todos os bytes da imagem. O relatório não garante espaço liberado exato.
- Imagens fora do processo de importação do Painel **não são avaliadas nem apagadas**. Limpeza de caches Docker da Softload V4 e retenção de imagens da infraestrutura são uma tarefa separada, que não deve atingir aplicações de clientes.

## Estado de desenvolvimento

Implementado no GitHub: API `server/revision-maintenance.ts`, política do executor `server/executor-policy.ts`, tela `revisions-ui.ts`, comandos do Terminal e testes. **Não houve inspeção nem exclusão de imagens na VPS real nesta etapa.** A validação de funcionamento na produção depende da instalação autorizada do backend.
