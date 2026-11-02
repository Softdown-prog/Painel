SAC read-only v2 job reports

Panel exposes sacWorker.technicalReport only when the existing job query loads a saved factual compiler error from the separate SAC builder state directory. The v1 diagnostic is unchanged. The code never compiles sources, starts jobs, invokes Docker or changes the SAC submit policy.

The v2 report is accepted only for Angular build failure with matching job/project/profile/commit identities, a fail result, legacy phase checks, a known TypeScript signature and a bounded fixed-description report. The output is reconstructed and compared byte for byte to prevent arbitrary logs or invented explanations. At most four findings are returned. Unknown source positions remain null. No raw compiler output or secret fields are exposed.

Run `python3 -m unittest discover -s operations -p 'test_sac_worker.py' -v` and `python3 -m unittest discover -s operations -p 'test_sac_public_bridge.py' -v`. CI uses synthetic offline data; no VPS deployment or proof of production job reports yet. No merge or task submission is authorized.

Verified publication decision (02/11/2026): the Painel repository is PUBLIC. The project owner expressly authorized publication of bounded technical diagnostics (project, commit, TS code, relative source path, line and column) through GitHub Issue comments and Actions artifacts. The authorization DOES NOT extend to passwords, tokens, credentials, full compiler stdout/stderr, arbitrary messages, host paths or source file contents. The existing vps-command.yml delivery channel remains unchanged. This branch contains code/tests only and DOES NOT activate any runtime service, grant submission rights or deploy the v2 reader. A real remote job query is still unverified.

## Decisão de publicação e prova do cliente Actions

O responsável pelo projeto autorizou **publicar as fichas técnicas verificadas**,
incluindo projeto, commit, código de compilação, caminho relativo, linha/coluna.
Isso não autoriza publicar credenciais, mensagens livres do compilador,
arquivos privados, stdout/stderr nem segredos do transporte.

O teste `operations/test_sac_public_bridge.py` usa uma falha TypeScript
**sintética**, passa pelo leitor v2 de verdade e pelo cliente do Actions
`operations/client.py`, com respostas OIDC e SSH inteiramente simuladas.
Confere que o relatório chega a `vps-result.json` e ao
`GITHUB_STEP_SUMMARY`, preservando os diagnósticos sem transportar os
segredos sentinela. A workflow pública existente continua publicando o
resultado no comentário da issue solicitante.

**Limite da prova:** não houve conexão remota, workflow_dispatch de
produção ou consulta de job real. O leitor v2 não está instalado na
VPS e a execução de novos jobs SAC permanece desabilitada. O teste
não demonstra entrega real de comentário por uma issue pública, apenas
o contrato de saída que o passo `gh issue comment` consome.
