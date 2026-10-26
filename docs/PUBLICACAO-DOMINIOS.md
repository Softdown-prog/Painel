# Publicação de sites pelo Painel

Este fluxo é destinado somente a aplicações criadas e isoladas pelo Painel. Ele não altera `softload.analysepro.com`, nem roteia containers que não pertençam ao Painel.

## O que o botão Publicar faz

1. Confere se a aplicação está em execução na rede `softload_panel_apps`.
2. Cria ou atualiza somente o registro A do endereço reservado, marcado como pertencente ao Painel.
3. Atualiza uma configuração Caddy gerada, valida a configuração, conecta o Caddy frontal somente à rede isolada de apps e recarrega o proxy.
4. Faz uma verificação HTTPS externa. O estado só vira **Publicado** se essa verificação responder.

Se a emissão do certificado ainda estiver em andamento, o estado aparece como **Certificado em andamento**, sem afirmar que o site está no ar. Remover um endereço publicado faz o caminho inverso: remove a rota gerada e somente o DNS que foi criado pelo Painel; a aplicação e seus arquivos permanecem.

## Configuração única da VPS

Antes de habilitar o recurso, o operador instala os overlays `compose.routing.yaml`, `compose.secrets.yaml` e `compose.ssh-terminal.yaml`, mantendo os demais overlays já usados. A API deve receber:

```text
PANEL_DOMAINS_ENABLED=1
PANEL_DOMAIN_PUBLISH_ENABLED=1
PANEL_APPS_DOMAIN_ZONE=apps.analysepro.com
PANEL_CLOUDFLARE_ZONE_ID=<id da zona analysepro.com>
PANEL_DOMAIN_ORIGIN_IPV4=<IPv4 público da VPS>
```

No cofre do Painel, crie `cloudflare-dns` com um token Cloudflare exclusivo, limitado à zona necessária e às permissões **Zone:Read** e **DNS:Edit**. O valor fica no arquivo privado da VPS; não deve ser colocado no GitHub, no Pages nem em campos de aplicação.

O Caddy frontal deve importar `/etc/caddy/sites/*.caddy`, e os arquivos dessa pasta devem corresponder a `/opt/softload-infra/caddy/sites` no host. O Painel valida o Caddy antes da recarga e preserva uma cópia temporária para retornar à configuração anterior se ela for inválida.

## Homologação C02

O endereço reservado para validar o fluxo é `c02-lab.apps.analysepro.com`. Ele não foi criado por este documento e não deve ser considerado público antes da verificação HTTPS no próprio Painel.
