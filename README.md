# Softload Console

Prévia visual de um painel para administrar a VPS Softload.

## Estado atual

Este projeto publica apenas uma interface estática no Cloudflare Pages. Métricas, estados, logs e revisões exibidos são exemplos, identificados na interface. Os botões não executam ações na VPS. Não há login real nem credenciais no frontend.

Prévia pública: https://softload-vps-panel.pages.dev

## Próxima etapa

Após a revisão do visual, conectar uma API administrativa privada na VPS e autenticação real. O frontend deverá obter dados e solicitar operações autorizadas por um backend seguro; Docker, SSH e segredos nunca devem ser expostos ao navegador.

## Desenvolvimento local

Abra `index.html` em um navegador. Não há dependências nem build.

## Publicação

Os arquivos `index.html`, `styles.css` e `script.js` são enviados ao projeto `softload-vps-panel` no Cloudflare Pages. Um repositório GitHub e a publicação automática poderão ser conectados na próxima etapa.
