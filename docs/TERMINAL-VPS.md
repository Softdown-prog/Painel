# Terminal da VPS — comandos pelo painel, sem depender do Codex

O painel agora tem a aba **Terminal VPS**. Abra `https://panel.analysepro.com/#terminal`, entre com o login de administrador e use comandos simples. O terminal consulta a API autenticada da VPS via a mesma conexão Cloudflare Pages → Function → Tunnel utilizada nas demais telas. **Ele não executa comandos no navegador nem finge valores de produção.**

## Comandos disponíveis

| Comando | O que faz |
| --- | --- |
| `ajuda` | Mostra a lista completa |
| `status` | Estado de serviços e resumo de recursos reportado pela API |
| `recursos` | Memória, CPU e espaço reportado |
| `servicos` / `docker ps` | Lista os serviços Softload conhecidos (não todos os containers do host) |
| `apps` | Lista aplicações gerenciadas, estado e RAM máxima |
| `logs app` / `logs loja` | Registros de um serviço Softload ou aplicação gerenciada |
| `iniciar app`, `parar sandbox`, `reiniciar agent` | Controla serviços existentes autorizados |
| `iniciar loja`, `parar loja`, `reiniciar loja` | Controla aplicação gerenciada |
| `app criar loja minha-imagem:versao 256 0.5` | Cria aplicação a partir de imagem permitida, desligada por padrão |
| `app recursos loja 512 1` | Altera limites autorizados de RAM (MB) e CPU |
| `app remover loja` | Remove aplicação parada e sem domínio cadastrado |
| `dominios` | Mostra endereços reservados sem afirmar publicação |
| `dominio criar loja 3000` | Reserva o endereço na zona autorizada; ainda não publica |
| `dominio remover loja` | Remove reserva de endereço |
| `repos`, `projetos`, `deploys` | Consulta integrações GitHub e histórico |
| `limpar`, `historico` | Controles da tela e histórico em memória da sessão |

Atalhos opcionais: `docker logs loja`, `docker restart app`. Esses nomes são uma forma familiar de chamar **as operações aprovadas do painel**; não dão acesso irrestrito ao Docker ou ao Linux.

## Como usar

1. Abra **Terminal VPS**, faça login no painel e digite `status` ou use o botão **Estado da VPS**.
2. Digite `servicos` para conferir os serviços da Softload.
3. Para solucionar um problema, digite `logs app`. Para reiniciar, digite `reiniciar app` e confirme a ação.
4. Para um site criado no painel, use `apps`, `iniciar nome-do-site` e `dominio criar nome-do-site 3000`.
5. Um endereço **reservado** só estará público depois que o administrador habilitar e verificar o roteamento do domínio.

O Terminal não precisa chamar GitHub Actions nem Codex a cada comando: utiliza os endpoints que já existem na API. A API pode impedir alterações quando o módulo da VPS estiver desativado, a imagem não estiver autorizada ou o container não pertencer ao painel. Isso aparece como erro, não como sucesso fictício.

## Comandos Linux de verdade (SSH opcional)

Também implementei o comando `linux <comando>`. Exemplo: `linux uptime`, `linux ls -la /opt` ou `linux docker ps`. **Nesse modo, o comando é enviado por SSH à VPS real**, usando a conta que o administrador configurar. Não é um simulador do navegador.

**Estado em 25/10/2026:** instalado e validado na VPS `softloadeng`. O painel usa uma chave SSH exclusiva, verificação de identidade do host e a conta `root` local da VPS; `linux <comando>` portanto aceita comandos administrativos e `sudo`. A chave privada fica em `/etc/softload-panel/terminal-ssh-key` com modo 0600 e não é enviada ao frontend, ao Cloudflare Pages ou ao GitHub. Não há dependência do Codex para executar comandos depois da instalação.

O funcionamento é simples: o administrador ativa o modo SSH, você entra no Painel e digita `linux uptime`. O terminal usa a sessão administrativa já autenticada, sem pedir a senha novamente nem aplicar um desbloqueio de dez minutos. A sessão do Painel dura até 12 horas; sair do Painel encerra o acesso. Cada resposta tem um botão **Copiar saída**, inclusive no celular. O resultado inclui o código de saída da operação.

Esse primeiro modo SSH **executa um comando por vez**, espera até 18 segundos e devolve até 24 KB de saída. Ainda não é uma sessão interativa do tipo `vim`, `htop` ou `nano`, nem mantém o diretório entre comandos `cd`. Para operações demoradas use ferramentas apropriadas (por exemplo `systemctl`, `docker compose` ou um job no host), com os privilégios que a conta SSH realmente possui.

### Instalação inicial na VPS (administrador do servidor)

Estas instruções foram executadas na VPS `softloadeng` em 25/10/2026 e permanecem como referência para uma futura reinstalação.

1. Identifique a conta Linux administrativa apropriada e a interface SSH do **host**. A configuração inicial sugere um usuário separado `panelops`, mas ela não é criada automaticamente; verifique se você quer uma conta com poderes administrativos e quais comandos poderá executar. Não compartilhar as credenciais da Softload com sites de clientes.
2. Gere uma chave SSH Ed25519 **no host**, guarde a chave privada em `/etc/softload-panel/terminal-ssh-key` com leitura restrita, e cadastre **somente a chave pública** no `authorized_keys` da conta escolhida. Use permissões restritas e não publique a chave privada no GitHub, Cloudflare ou no frontend.
3. Verifique a chave pública do servidor SSH (*host key*) presencialmente no host e prepare o arquivo `/etc/softload-panel/terminal-ssh-known-hosts` com o hostname e fingerprint corretos. Não desative verificação de identidade SSH para “funcionar mais rápido”.
4. Confirme que o container `api` consegue alcançar a porta SSH do host Docker via `host.docker.internal`. Em algumas VPS o SSH não aceita conexões pela interface Docker; isso precisa ser ajustado no host, sem abrir uma nova porta pública.
5. Adicione o overlay `server/compose.ssh-terminal.yaml` ao seu conjunto Compose **atual**. Configure `PANEL_TERMINAL_SSH_ENABLED=1`, `PANEL_TERMINAL_SSH_HOST`, `PANEL_TERMINAL_SSH_PORT` e `PANEL_TERMINAL_SSH_USER` conforme o host. Confira previamente a configuração mesclada com `docker compose ... config` (sem imprimir segredos no chat ou em logs compartilhados). Atualize somente a API quando tiver backup e janela de manutenção.
6. Teste primeiro `linux whoami` e `linux uptime`. Depois confira os comandos administrativos que a conta possui. `sudo` só funcionará se a **sua** configuração de permissões no host permitir; o Painel não concede privilégios adicionais escondidos.

O serviço SSH exige a sessão autenticada do Painel e não registra o comando completo no log do servidor (somente um hash resumido, duração e código de saída). Não abre nenhuma nova porta pública, e a chave privada fica montada somente na API. Um comando demorado ou saída muito grande é interrompido por limite.

Se você preferir uma experiência de shell interativo como a do PuTTY, com `vim` e entrada contínua, ainda faltará uma segunda etapa: PTY/WebSocket com controle de sessões. Ela está anotada para depois em [TAREFAS-CODEX.md](TAREFAS-CODEX.md), mas **não é necessária para usar `linux <comando>`**.

## Status de implantação

Frontend publicado e backend implantado em 25/10/2026. A API e o executor estão saudáveis na VPS, e os testes autenticados pelo domínio público confirmaram `linux whoami` e `linux sudo -n whoami`, ambos com saída `root`. Recursos novos como criar apps e reservar endereços continuam dependendo de seus módulos próprios e não são implicados pela ativação do terminal.

O histórico fica apenas na memória da página e não é persistido no navegador. A saída de comando usa `textContent`, não interpreta HTML recebido em logs.
