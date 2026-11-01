# SAC-008B — submissão de validação pelo GitHub Actions (sem API)

O código do Painel acrescenta a operação de broker `sac_submit`, acionada **somente** por `vps-command.yml` em `main`, com OIDC, SSH forced command, ator autorizado e allowlist root-owned. Nenhuma API HTTP, socket público ou MCP remoto foi criado.

O ChatGPT/GitHub poderá solicitar um job criando uma Issue na conta autorizada com título literal `[VPS] sac-submit` e corpo JSON exato (abaixo), **após a atualização manual da ponte e habilitação de projeto**. `workflow_dispatch` com `operation=sac_submit` aceita os mesmos campos por inputs fixos:

```json
{"project_id":"demo-a","profile_id":"angular-root",
 "source_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

O `operations/client.py` apenas transporta os campos ao broker. O `operations/receiver.py` reconfirma ator, workflow, branch `main` e operação. `operations/sac_submit.py` valida os três campos, id/attempt vinculados ao run autenticado, e allowlist do operador. Publica **somente o pedido** em `/var/lib/data-library-worker/state/sac-inbox/gha-<run_id>-<attempt>.json` por arquivo temporário e hardlink exclusivo; nunca sobrescreve um pedido anterior com identidade igual e conteúdo diferente. O recibo público contém `queued`, `executed:false` e `deploymentAuthorized:false`.

## Proteções / limites

- `sac_submit.enabled` **false por padrão**, `projects:[]`. Nenhum projeto real foi habilitado neste PR; o operador deve aprovar explicitamente os IDs/perfis e a versão do runner no worker antes de processar trabalho.
- Não aceita campo shell, script, paths, URL, imagem Docker, branch ou token.
- Só escreve em diretório fixo, preexistente e pertencente ao usuário `data-library`, sem seguir symlink, com `O_NOFOLLOW` e entrega atômica; a VPS precisa ter diretório e permissão corretos e o broker/root precisa enxergá-lo.
- O One Worker atual requer código novo da Data Library com `--sac-inbox` **opt-in**. Sem isso o pedido ficará no inbox sem processamento.
- Acknowledgement do worker registra `status:received`, `execution:disabled`. **Nenhum Angular real é compilado neste marco**: não ativar este gate em produção fingindo que já roda compilações.
- O pedido contém SHA alegado do usuário. Quando o executor for implementado ele deverá provar que o SHA pertence ao repositório allowlisted e que usa sandbox isolado, sem executar dependências diretamente no host multiprojetos.
- A política root-owned em `/etc/vps-operations/policy.json`, o broker instalado e a unidade systemd **não são automaticamente atualizados** com merge no GitHub. Precisa de implantação separada e aprovada, com verificação do esquema de permissões na VPS.
- Os workflows deste PR são testes offline CI, nunca executam o endpoint existente nem alteram VPS/One Worker.

Repositório complementar: `Softdown-prog/Data_libray`, branch `feat/sac-008b-worker-inbox`.

## SAC-008C: consulta individual de resultado

Após a instalação/habilitação administrativa separada, a Issue literal `[VPS] sac-job` no Painel pode conter **somente** `gha-<run_id>-<attempt>` no corpo; `workflow_dispatch` pode usar `operation=sac_worker`, `sac_action=job` e `sac_job_id`. O broker lê apenas `sac-results/<id>.json`, valida IDs/estado/cobertura e retorna um **resumo sanitizado** por GitHub Actions, não stdout ou arquivos de projeto. `not-recorded` significa resultado ainda não gravado, não significa Worker offline. Esta operação não executa compiladores. Para iniciar auditoria SAC-008C, o One Worker precisaria estar explicitamente configurado e aprovado, com as duas políticas/flags de execução.
