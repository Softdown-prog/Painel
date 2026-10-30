# Diagnosticar a conexão com a API da VPS

No painel, abra **Configurações → API da VPS → Testar conexão**. Na tela de login existe o mesmo botão. Ele consulta apenas a sessão; não reinicia serviços, não executa comandos e não repete uma ação administrativa que possa ter sido concluída antes da queda de conexão.

**API conectada** confirma a resposta da API, não a saúde dos sites. Uma sessão expirada pede novo login. Uma resposta HTML, uma página de autenticação do Cloudflare ou um erro 502 não deve ser apresentada como senha incorreta nem como dados vazios.

## Evidência e limite do diagnóstico

Em 30/10/2026, consultas públicas a `https://panel.analysepro.com/api/session` e `https://softload-vps-panel.pages.dev/api/session` retornaram HTTP 502, sem os campos `authenticated` e `setupRequired` da API. O endereço privado recusou a consulta anônima com HTTP 403, compatível com a proteção do Cloudflare Access. Isso não comprova a saúde do serviço de origem nem identifica sozinho o componente com defeito.

A correção de código melhora o transporte e permite localizar o problema. Restaurar a conexão de produção exige confirmar o caminho no servidor; não foi realizada nenhuma alteração na VPS por esta branch.

## Caminho esperado

| Trecho | Contrato |
| --- | --- |
| Navegador → Pages Function | `/api/*`, na mesma origem, sessão em cookie HttpOnly |
| Function → API privada | Origem fixa `https://panel-api.analysepro.com`, credenciais de serviço do Access e chave de borda somente no servidor |
| Túnel → API | `http://softload-panel-api:8080`, pela rede Docker compartilhada `softload_proxy` |
| API → executor | Socket Unix privado; o executor continua sem rede e com a política Docker existente |

O destino do túnel deve usar o nome do serviço, não `localhost` dentro do container do túnel nem um IP antigo de container. O endereço privado permanece protegido pelo Access. Não liberar a API publicamente nem desativar a autorização para resolver um 502.

## Diagnóstico no console da VPS

Use o console administrativo da VPS, fora do terminal do painel, pois o terminal depende desta mesma API. Na raiz de um checkout que contenha esta correção:

```bash
bash server/diagnose-connection-vps.sh
```

Requer Docker autorizado e Python 3. O script é somente leitura: não instala, atualiza, recria ou reinicia containers; não altera arquivos, redes ou DNS. Ele lê a chave já montada dentro da API, usa-a apenas nos dois destinos internos fixos e não imprime credenciais, respostas privadas ou variáveis de ambiente. Também funciona em uma imagem antiga da API: envia o verificador via entrada padrão, sem copiar arquivos para o container.

| Resultado | Próximo passo |
| --- | --- |
| Container ausente ou parado | Investigar a instalação e a inicialização desse componente; não reiniciar outros projetos |
| Etapa 1 falha em `127.0.0.1` | Conferir API, porta 8080 e montagem/leitura da chave privada. HTTP 404 pode indicar chave de borda incorreta |
| Etapa 1 passa, etapa 2 falha | Conferir nome/alias `softload-panel-api`, resolução Docker e escuta da API em `0.0.0.0` |
| Etapa 3 não confirma rede compartilhada | Conferir a ligação do túnel e da API à rede prevista. Não adicionar rede ao executor |
| Etapas internas passam, consulta pública falha | Conferir no Cloudflare o destino do túnel, sua conexão e a política/token de serviço do Access; comparar a chave de borda do Pages com a da API sem expô-las |
| Consulta pública passa e login é solicitado | A API está acessível. Entrar novamente: as sessões administrativas são encerradas quando a API reinicia |

A etapa 2 consulta o nome Docker a partir da própria API; não comprova sozinha conectividade a partir do túnel. A etapa 3 verifica a topologia, e a etapa pública confirma o caminho completo até o contrato de sessão. O script retorna código 1 quando uma dessas verificações falha e código 2 quando faltam ferramentas/acesso local. Estados impressos de executor e túnel são informação adicional, não prova da saúde das aplicações hospedadas.

## Credenciais e publicação

Os bindings secretos `PANEL_EDGE_KEY`, `CF_ACCESS_CLIENT_ID` e `CF_ACCESS_CLIENT_SECRET` ficam no ambiente **Production** do projeto Cloudflare Pages `softload-vps-panel`. Não são a senha administrativa, não entram em JavaScript estático e não devem ser enviados em capturas, logs ou issues. A Function remove espaços acidentais nas extremidades, recusa redirecionamentos e normaliza falhas do provedor sem expor seu conteúdo.

Após integrar a correção, o workflow Pages publica a interface e a Function. Isso **não atualiza** a API/executor na VPS. O novo healthcheck HTTP só é instalado quando a imagem da API e o Compose forem atualizados pelo operador, preservando os overlays e volumes existentes. O script de diagnóstico pode ser usado antes dessa atualização. Não há necessidade de recriar o executor apenas para instalar o healthcheck HTTP.

## Validação reproduzível

Na raiz do repositório, com Node 24:

```bash
npm install --no-audit --no-fund
npm run typecheck
npm test
npm run build:frontend
npm run check:js
bash -n server/diagnose-connection-vps.sh
```

Os testes cobrem redirecionamentos do Access, falhas de gateway HTML/JSON, sessão/cookies, timeouts inclusive durante o corpo da resposta, ausência de repetição de comandos, recuperação manual e prontidão HTTP com servidor local. O CI também valida os overlays Compose e constrói API/executor em Docker isolado. Esses resultados não substituem o diagnóstico e o login na VPS real.
