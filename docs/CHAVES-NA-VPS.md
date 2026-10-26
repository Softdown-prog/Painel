# Chaves e acessos — gerenciando credenciais na VPS pelo Painel

A nova aba **Chaves e acessos** permite cadastrar, substituir e excluir arquivos de chaves de API pela interface administrativa. O conteúdo é gravado **na própria VPS**, em uma pasta privada autorizada pelo operador. O frontend não salva os valores no navegador ou no GitHub, e o backend nunca disponibiliza um endpoint para ler uma chave cadastrada.

## Como usar

1. Entre no painel e abra **Chaves e acessos**.
2. Escolha um nome de arquivo fácil de reconhecer, por exemplo `gemini-api-key` ou `github-token`.
3. Descreva a chave, selecione **Serviços da VPS** ou **Site ou aplicação**, cole o valor e confirme sua senha administrativa.
4. Clique em **Gravar chave na VPS**.
5. Para atualizar uma chave, informe o **mesmo nome** e o valor novo; isso substitui o arquivo antigo. Para apagar, clique em **Excluir chave** e confirme com sua senha.

A listagem mostra nomes, descrições, alterações e se cada arquivo existe. **O valor da chave nunca aparece na listagem nem pode ser recuperado pela API.** Guarde uma cópia em seu gerenciador de senhas, não no chat.

## Instalação inicial na VPS — uma vez só

Este recurso é desativado por padrão, e a instalação inicial exige que um administrador com acesso à VPS a habilite. Antes de criar arquivos, confirme como o Codex configurou o SSH e os containers para evitar conflitos.

No host Linux, crie a pasta dedicada:

```sh
sudo install -d -o root -g root -m 700 /etc/softload-panel/managed-secrets
```

Na instalação Compose atual do Painel, acrescente **sem remover os overlays já existentes** o arquivo `server/compose.secrets.yaml` e habilite `PANEL_SECRETS_ENABLED=1`. Confira a configuração final com `docker compose ... config` antes de recriar apenas a API do Painel. A pasta do host será montada como `/run/panel-managed-secrets` dentro da API. Não é necessário abrir portas novas ou usar o terminal SSH a cada alteração.

**Não foi executada nenhuma instalação ou gravação de chave real na VPS nesta etapa.** O arquivo Compose novo foi criado para facilitar a ativação posterior.

Os valores são gravados como arquivos de texto com permissões `0600`; a pasta precisa ser `0700`. A lista de nomes e datas é guardada em um arquivo `.panel-secret-index.json` na mesma pasta, sem valores de chaves. O Painel recusa a pasta se for link simbólico ou tiver permissões públicas. Não há criptografia em repouso própria implementada — proteja backups, acesso root e armazenamento da VPS.

## Como fazer as aplicações realmente usarem as chaves

**Guardar não é a mesma coisa que aplicar a chave ao serviço.** O Painel não muda sozinho arquivos `.env`, containers da Softload V4, Compose ou variáveis de ambiente de aplicações. Isso evita trocar credenciais em produção inadvertidamente. Um programa normalmente precisa ler o arquivo da chave, ou receber sua variável de ambiente na inicialização.

### Exemplo: GitHub, builds e GHCR

O backend já lê essas variáveis:

| Finalidade | Variável de configuração da API |
| --- | --- |
| Token GitHub do Painel | `PANEL_GITHUB_TOKEN_FILE` |
| Token para imagens privadas GHCR | `PANEL_GHCR_TOKEN_FILE` |
| Usuário GHCR | `PANEL_GHCR_USERNAME` |

Se você cadastrar `github-token` na nova pasta, o caminho **dentro do container da API** será `/run/panel-managed-secrets/github-token`; se cadastrar `ghcr-read-token`, o caminho será `/run/panel-managed-secrets/ghcr-read-token`. Na revisão controlada do Compose do Painel, o operador pode apontar `PANEL_GITHUB_TOKEN_FILE` e/ou `PANEL_GHCR_TOKEN_FILE` para esses arquivos. Remova os mounts antigos só depois de verificar que o novo token funciona. Não configure permissões de escrita para serviços que precisam apenas de leitura.

Para chaves de OpenAI, Gemini, Cloudflare e outros provedores, o nome do arquivo pode ser personalizado. **O serviço consumidor deve receber apenas a sua própria chave**, via mount somente leitura, com caminho explícito. Não monte a pasta inteira com todas as chaves dentro de sites ou containers de clientes.

### Rotação sem perder o serviço

1. Cadastre a chave nova no provedor externo.
2. Grave o valor novo no Painel usando o nome do arquivo que o serviço consome.
3. Recarregue o serviço autorizado e confira o funcionamento.
4. Só então revogue a chave anterior no provedor.

Reiniciar um container é uma ação separada e exige atenção quando o aplicativo mantém a chave na memória. O Painel não a reinicia automaticamente.

## Sobre segurança e limitações

- As operações exigem a sessão administrativa e uma segunda confirmação com senha. Tentativas inválidas recebem a mesma limitação de login que o painel já usa.
- Cada valor tem até **8 KB** e é validado como **uma linha de texto** (chaves PEM multilinha não são suportadas nesta versão). Máximo de **80 nomes** cadastrados.
- Os valores não aparecem em respostas de listagem, HTML, logs de operação ou arquivos do GitHub.
- Não aceita caminho livre digitado pelo usuário: os arquivos ficam exclusivamente na pasta montada, identificados por um nome simples em minúsculas.
- Uma cópia de backup da pasta de chaves precisa ter a mesma proteção. Fazer backup da pasta **é tarefa separada**.
- A API de administração ainda foi concebida para **um administrador da VPS**, não para clientes com acesso próprio às chaves. Antes de criar contas para clientes, é obrigatória a separação de permissões e credenciais por organização.
- O serviço não é um cofre externo com HSM/KMS, não executa testes remotos do token e não suporta rotação automática com confirmação do provedor.

## Pendências para o Codex

Validar instalação da pasta host e overlay na VPS real, sem comprometer a configuração de SSH; revisar como `PANEL_GITHUB_TOKEN_FILE` e `PANEL_GHCR_TOKEN_FILE` são montados atualmente; testar a troca de uma credencial de demonstração; acrescentar montagem de secrets por aplicação e reinício seletivo, com confirmação e rollback; adicionar backups criptografados, auditoria por usuário e permissões por cliente antes de oferecer hospedagem multiusuário.

Implementação: `server/secrets.ts`, `server/compose.secrets.yaml`, `secrets-ui.ts`, `secrets-ui.js`. Testes: `server/secrets.test.mjs`.
