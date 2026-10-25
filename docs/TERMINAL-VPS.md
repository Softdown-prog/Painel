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

## O que falta para comandos Linux completos

Este primeiro Terminal já funciona como cliente de administração da API existente, mas **não é SSH/bash**: `sudo`, `apt`, `cd`, edição de arquivos e comandos arbitrários ainda não estão disponíveis. Um comando desconhecido é recusado, sem ser encaminhado ao host.

Para oferecer um verdadeiro terminal Linux dentro da interface e continuar independente do Codex, a próxima fase é instalar **uma única vez** na VPS um serviço próprio de terminal SSH/PTy, acessível apenas ao administrador autenticado do Painel. Requisitos mínimos:
- Conta de operação separada dos serviços Softload e controle explícito de quando uma sessão abre/fecha.
- Conexão através do Tunnel existente, com sessão curta e log de acesso (sem armazenar senhas e tokens digitados).
- Streaming WebSocket para saída de terminal e redimensionamento, confirmação para comandos destrutivos e bloqueio entre clientes quando multiusuário.
- Instalação operada por quem já possui acesso SSH/Portainer autorizado à VPS. **Não exige usar o Codex depois de instalada**, nem abrir uma porta de SSH pública extra.
- Revisão de conflitos com as configurações atuais, backup e testes na VPS. Não habilitar root remoto irrestrito por engano.

Essa evolução está documentada como C13 em [TAREFAS-CODEX.md](TAREFAS-CODEX.md). O instalador poderia ser executado **manualmente uma vez** por você ou um administrador; o Codex é opcional, não faz parte da operação cotidiana.

## Status de implantação

Frontend: a partir do commit que introduziu `terminal-ui.ts`, `terminal-ui.js` e `terminal.css` (ver CI do repositório). As consultas a `/services` e `/overview` dependem da API privada da VPS já estar em execução. Recursos novos como criar apps e reservar endereços só funcionam depois que os módulos opcionais do backend forem realmente atualizados e habilitados. **Não confundir frontend publicado com backend implantado na VPS.**

O histórico fica apenas na memória da página e não é persistido no navegador. A saída de comando usa `textContent`, não interpreta HTML recebido em logs.
