SAC read-only v2 job reports

Panel exposes sacWorker.technicalReport only when the existing job query loads a saved factual compiler error from the separate SAC builder state directory. The v1 diagnostic is unchanged. The code never compiles sources, starts jobs, invokes Docker or changes the SAC submit policy.

The v2 report is accepted only for Angular build failure with matching job/project/profile/commit identities, a fail result, legacy phase checks, a known TypeScript signature and a bounded fixed-description report. The output is reconstructed and compared byte for byte to prevent arbitrary logs or invented explanations. At most four findings are returned. Unknown source positions remain null. No raw compiler output or secret fields are exposed.

Run python3 -m unittest discover -s operations -p test_sac_worker.py -v. CI only uses synthetic offline data. No VPS deployment or proof of production job reports yet. Before enabling a real GitHub Issue query, assess repository visibility because issue comments may expose source paths and diagnostics. No merge or task submission is authorized.

Verified security boundary (02/11/2026): the Painel repository is PUBLIC. Its existing vps-command.yml workflow posts request results into GitHub Issue comments and uploads workflow artifacts. Even a bounded relative source path and TS code might disclose project details. Do NOT deploy this reader or request real diagnostic jobs through public issues until the reporting channel is restricted to authorized readers, or the disclosure policy is explicitly reviewed. This branch contains code/tests only and does NOT activate any runtime service, or change the GitHub workflow delivery channel.

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
