# Angular do Painel na VPS — GHCR e staging isolado

## O que é instalado

O workflow `deploy-panel-web.yml` compila a imagem estática/Angular no GitHub Actions,
testa HTML, JavaScript e proxy da API, publica a imagem `ghcr.io/softdown-prog/painel-web:<SHA>`
e opcionalmente solicita ao broker da VPS a implantação somente do `panel-web` por digest.
Não há `npm install`, Docker build, Cloudflare ou atualização de backend na VPS.

**Importante:** o frontend público continua sendo Cloudflare Pages. A instalação
do container de staging é privada, sem portas abertas e não troca DNS, Tunnel nem Caddy.
Um job de build verde não significa que o deploy na VPS ocorreu.

## Autorização inicial (uma única vez, por root)

O broker instalado não tem a autorização `panel-web`. Sua política e seus módulos Python
são root-owned e não podem ser modificados por um workflow não autorizado.
Por isso, uma sessão administrativa independente deve instalar essa extensão **uma única vez**.
O script `operations/install-panel-web-adapter-vps.sh` atualiza apenas `driver.py`,
adiciona `web.py` e preserva todos os registros anteriores de `/etc/vps-operations/policy.json`,
acrescentando o projeto `panel-web` e o workflow `deploy-panel-web.yml` na lista permitida.
Ele não substitui `receiver.py`, não mexe em chave SSH e não reinicia containers.

Após revisar e integrar o PR, baixe uma revisão fixa do repositório e execute:

```bash
SHA=<SHA40-DO-MERGE-NA-MAIN>
mkdir -p /tmp/panel-web-bootstrap
curl -fsSL "https://codeload.github.com/Softdown-prog/Painel/tar.gz/$SHA" -o /tmp/panel-web-bootstrap/source.tar.gz
tar -xzf /tmp/panel-web-bootstrap/source.tar.gz --strip-components=1 -C /tmp/panel-web-bootstrap
sudo bash /tmp/panel-web-bootstrap/operations/install-panel-web-adapter-vps.sh /tmp/panel-web-bootstrap
```

Não executar simultaneamente ao instalador antigo `web/deploy-staging-vps.sh`.
O novo adaptador usa o mesmo lock para proteger o container.

## Ativar deploy via GitHub Actions

Depois do bootstrap, abra **Settings → Secrets and variables → Actions → Variables**
e configure `PANEL_WEB_DEPLOY_ENABLED=true`. A partir desse momento, alterações de
Angular e frontend na main enviam a imagem diretamente da GHCR para o staging.
Também é possível disparar manualmente **Actions → Build and deploy Panel web staging via GHCR → Run workflow**.

Antes desse preparo, os pushes apenas compilam/publicam a imagem; o job `deploy` é
intencionalmente ignorado. Se for iniciado manualmente antes do preparo, será recusado
pela política antiga: não há permissão implícita ou shell arbitrário.


### Acionar pela integração GitHub do ChatGPT

Depois de instalar a autorização root-owned, também é possível criar uma **nova issue**
no repositório Painel com o título exato:

    [VPS] deploy panel-web

Somente issues abertas pela identidade administrativa cadastrada, na branch main
e com esse título disparam o workflow. O corpo e os comentários NÃO recebem
comandos de shell, imagens alternativas ou caminhos. A imagem é construída no
GitHub e seu SHA vem do próprio evento/identidade OIDC. Issues de outros autores
ou com título diferente não têm o job de build/deploy executado.

Na primeira tentativa **antes** da instalação root-owned, o broker recusará
o deploy sem alterar o host. O ChatGPT pode consultar o workflow de execução
e o artifact JSON sanitizado para verificar a resposta real.

## O que o deploy verifica

- Selo OCI SHA completo e repositório exato na imagem GHCR.
- Origem protegida e rede privada `vps_panel_control`, sem portas expostas.
- Existência do segredo de proxy no host e saúde da API original.
- Candidato isolado: `/__panel_web_health`, `/api/session`, Angular e arquivos JavaScript.
- Só então promoção do `softload-panel-web` e verificação de saúde/SHA.
- IDs dos outros containers preservados; rollback somente do serviço web.
- Retorno `stagingVerified:true` e `publicVerified:false` no artifact do Actions.

Depois confirme por uma nova issue de inventário `[VPS] inventory` que a imagem
do `softload-panel-web` apresenta o SHA esperado e status healthy.
Publicação HTTPS direta da VPS exige staging protegido e uma mudança separada,
reversível, no roteamento. Não faz parte deste PR.
