# Painel VPS — guia rápido, sem termos técnicos

O objetivo do painel é permitir administrar uma VPS pequena hoje e vários sites, clientes e servidores no futuro. A interface deve falar a linguagem de quem quer colocar um site no ar, e deixar os detalhes técnicos para o administrador ou para o Codex.

## O que posso fazer hoje

**Visão geral:** acompanhar a utilização da VPS, os projetos e os containers de todo o servidor. Um projeto parado não impede o acesso ao painel.

**Sites e apps:** criar uma aplicação a partir de uma imagem já autorizada na VPS, definir limites de memória e processamento, iniciar, parar, reiniciar e ver registros. A aplicação começa **desligada**, sem domínio público. Neste protótipo há um limite de **8 aplicações**; ele ainda não é um gerenciador de clientes em larga escala.

**Projetos GitHub:** associar uma aplicação existente ao repositório do seu código e acompanhar as versões geradas pelo workflow autorizado. Builds e imagens têm etapas de verificação; isto não equivale a um deploy totalmente automático.

**Endereços:** preparar um endereço como `loja.apps.analysepro.com`, a partir do nome da aplicação e da zona liberada pelo administrador. **Preparar ou reservar não significa colocar na internet**. Por enquanto, o administrador precisa configurar DNS, HTTPS e atualização do servidor de endereços.

**Publicações:** acompanhar o histórico das aplicações por projeto. Para conferir a imagem atual ou os registros, abra a aplicação em **Sites e apps**. Os controles de compatibilidade de instalações antigas só aparecem quando habilitados pelo administrador.

## Exemplo: quero hospedar o site de uma loja

1. Entre em **Sites e apps** e escolha **Criar aplicação**. Dê um nome como `loja-exemplo` e selecione o modelo já aprovado no servidor. Caso o botão esteja desativado, ainda falta o administrador liberar essa função na VPS.
2. Ajuste a memória e o processamento. Use os valores iniciais se não souber qual escolher; aumente somente quando houver motivo.
3. Clique em **Iniciar**. **Ver registros** ajuda a entender se o programa falhou.
4. Use **Ligar ao GitHub** se o código estiver em um repositório. As atualizações dependem do workflow de build e das verificações.
5. Clique em **Escolher endereço**. Confira o endereço mostrado na tela, indique a porta que o programa realmente usa (por exemplo 3000) e clique em **Reservar endereço**.
6. A tela informa quando o endereço está **apenas reservado**. Ele só ficará acessível publicamente após ativar DNS/HTTPS e o servidor de endereços. O painel ainda não faz isso sozinho.

### Traduzindo algumas palavras

| Na tela | O que significa |
| --- | --- |
| Aplicação / container | Um programa ou site rodando separado dos demais na VPS |
| Imagem / modelo | O pacote pronto com os arquivos do programa que o servidor pode iniciar |
| Memória (RAM) | Quanto espaço o programa pode usar enquanto está funcionando |
| Processamento (CPU) | Quanto do processador o programa pode usar |
| Porta | Número que o programa usa para receber pedidos dentro do servidor. Não é a porta da sua casa |
| Endereço / domínio | O link que as pessoas vão usar para abrir seu site |
| Publicação / deploy | Colocar uma nova versão do programa no servidor |
| Registros / logs | Mensagens para descobrir por que o programa parou ou não abriu |
| Backup | Uma cópia que ajuda a voltar atrás caso algo dê errado |

## O que o painel ainda NÃO faz sozinho

Ainda não é possível hospedar domínios personalizados arbitrários de clientes, emitir certificados e ativar uma rota pública em um clique. Não há um fluxo completo de cobrança e isolamento para cada cliente, escala automática entre várias VPS, volumes persistentes gerenciados pela interface ou deploy totalmente automático. **Não ofereça esses recursos como prontos**.

A lista de implementação para o Codex está em [TAREFAS-CODEX.md](TAREFAS-CODEX.md). As instruções técnicas de administração permanecem em [domain-routing.md](domain-routing.md) e [docker-executor.md](docker-executor.md).

## Princípio para as próximas versões

A primeira tela mostra: **o que quero fazer?**, **quais dados preciso preencher?** e **isso já está no ar ou falta algo?**. Os detalhes internos (Docker, Caddy, GHCR, DNS-01, redes e comandos) ficam em **Avançado**, com explicação clara. Nenhum botão deve declarar publicado ou ativo sem confirmação real do servidor e de uma verificação externa.
