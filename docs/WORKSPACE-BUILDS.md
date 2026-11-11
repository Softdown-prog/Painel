# Workspaces isolados de compilação e testes reais do LHS

O Painel já possui cópias de projeto em `/srv/panel-codex/workspace/<projeto>`.
`operations/workspace_build.py` executa perfis **fixos** de compilação usando
containers Docker temporários. O código local ainda não enviado ao GitHub é
copiado para um diretório efêmero; portanto, o teste acontece **antes do commit**.
O GitHub Runner não participa deste procedimento.

## Isolamento e limites

- Nenhum container recebe socket Docker, volumes de produção, credenciais, portas,
  capacidades Linux, privilégio root ou acesso à rede host.
- A cópia inicial usa rede `none` e remove `.git`, `.env*`, `.npmrc`, `auth.json`
  e `node_modules`. A dependência é instalada **somente na cópia sanitizada**.
- Apenas `npm ci` usa a rede Docker `bridge` para buscar dependências; os testes
  rodam sem rede. Isso não equivale a uma política de egress rigorosa: antes de
  habilitar para código não confiável, configurar uma rede dedicada com filtragem.
- Um build por vez, 1,5 vCPU, 1.536 MiB RAM, 128 processos, timeouts por etapa.
- Imagem local `panel-lhs-qa:node24-pw1.56.1` construída de
  `operations/workspace-build.Dockerfile`: Node 24, Playwright 1.56.1 e Chromium
  pré-instalados. O teste em GitHub-hosted Docker comprova abertura de Chromium,
  mas **não** comprova que a imagem já existe na VPS.
- O perfil pré-commit executa todos os testes Node, Angular e **testes reais
  no Chromium**: Canvas, cache de pixels, desktop/mobile, editor de layout,
  jogabilidade PS1/PS2 e navegação no site Angular.
- A tag local deve ser protegida contra alteração por outros usuários do host.
  A imagem base deve ser fixada por digest após homologação.
- Não altera o projeto original, a `main`, a VPS em produção ou o CI.

## Instalação controlada na VPS (não executada por esta entrega)

Apenas o administrador do host deve executar depois de conferir o código e
configuração da VPS. O Python fica fora de qualquer diretório editável pelo agente.
A implantação precisa garantir que o SSH administrativo existente aceite o
comando fixo e que a imagem Node esteja presente no daemon Docker.

```sh
sudo install -d -o root -g root -m 0755 /usr/local/lib/panel-workspaces
sudo install -o root -g root -m 0755 operations/workspace_build.py /usr/local/lib/panel-workspaces/workspace_build.py
sudo install -d -o root -g root -m 0700 /srv/panel-workspace-builds
sudo docker build -f operations/workspace-build.Dockerfile -t panel-lhs-qa:node24-pw1.56.1 operations/
```

O build deve ocorrer no checkout revisado do Painel; não apontar para código de uma branch desconhecida. A imagem em produção deverá ser fixada por digest SHA-256 após homologação.
O script exige UID administrativo para iniciar e apenas acessa cópias cadastradas
sob `/srv/panel-codex/workspace`. Para verificar o ID real, consulte as cópias
no Painel, não invente nomes. **Não copie chaves nem tokens para o workspace.**

## Uso pela aba Agentes Codex

Após o deploy compatível do bridge e da API, e a instalação do supervisor
na VPS, no projeto **Lan House Simulator** importado e autorizado:

1. O agente chama `validar_workspace` com `perfil: "lhs-precommit"`.
2. O Painel apresenta a proposta para aprovação humana, vinculada ao projeto
   cadastrado, à branch registrada e ao destino SSH autenticado.
3. Após aprovada, a API executa somente um comando fixo do supervisor.
   O recibo inicial contém `status: "queued"` e `passed: false`; isso **não**
   significa compilação aprovada.
4. O agente chama `consultar_workspace` com o `jobId` retornado. A consulta
   valida que o resultado pertence ao mesmo projeto. Apenas `status: "passed"`
   com `passed: true` confirma aquela execução.

O agente não recebe o Docker socket nem um terminal arbitrário do projeto.
O modo **Administração da VPS** ainda permite, separadamente, usar
`solicitar_comando_vps` com aprovação explícita. Se a integração automatizada
não estiver implantada, o administrador pode executar:

```sh
python3 /usr/local/lib/panel-workspaces/workspace_build.py start gh_12_abcdef12
python3 /usr/local/lib/panel-workspaces/workspace_build.py status <jobId>
```

`gh_12_abcdef12` é apenas exemplo de identificador. A cópia verdadeira deve
ser conferida no Painel. Sem cópia autorizada, o supervisor recusa o job.
Essa integração usa as ferramentas **Agentes Codex do Painel**, e **não** implica
que o MCP HTTP de consulta `vps-code-mcp` forneça execução ou que esta
conversa no ChatGPT tenha recebido acesso à VPS.

Perfis atuais:

| Perfil | Passos |
| --- | --- |
| `lhs-quick` | npm ci, typecheck, build e **40 arquivos de testes representativos** de simulação, economia, clientes, filas, circulação, saves, PS1/PS2, renderização, serviços e interface. **Smoke, não aprovação do jogo inteiro** |
| `lhs-core` | npm ci, typecheck, build, npm test |
| `lhs-angular` | npm ci, dependências Angular, typecheck, build, lint e build Angular |
| `lhs-visual` | Build do jogo, site Angular canônico e testes em Chromium para Canvas desktop/mobile, layout por toque, PS1 e PS2 | 
| **`lhs-precommit` (padrão)** | Todos os testes Node do jogo via `npm test`, TypeScript, Angular, **além de toda a suíte de navegador `lhs-visual`**. O Actions continua sendo a segunda validação independente |

O perfil rápido jamais autoriza um commit isoladamente. Para alterações normais, usar **`lhs-precommit`**, que já inclui Playwright e capturas reais. A API não deve inferir aprovação do GitHub PR a partir deste resultado. Um build
válido exige `status=passed`; `queued`, `running`, `busy` ou `failed` **não** são
sucesso. Os jobs iniciados pelo terminal são curtos: o script cria um supervisor
desvinculado, e os perfis podem durar vários minutos. Logs de etapas permanecem
na pasta privada do job e são retornados em trecho limitado pela operação `status`.

## Pendências antes de ativar em produção

1. Homologar imagem Docker real na **VPS** e verificar memória, CPU, DNS e
   comportamento dos navegadores com o LHS completo.
2. Instalar o script em local root-only, revisar permissões e garantir
   que o serviço de agente/bridge esteja na mesma revisão compatível da API.
3. Proteger o egress das instalações `npm ci` com rede dedicada e
   fixar a imagem base e as dependências por digest.
4. Implementar expiração/limpeza dos logs dos jobs. O diretório temporário
   da cópia do código já é removido ao final da execução.
5. Comprovar a execução no **projeto real**, não somente testes de contrato e
   smoke de Chromium. Confirmar que a cópia corresponde à branch desejada.

Nenhum deploy, merge ou alteração nos outros containers está autorizado por
esta documentação. Também não existe aprovação automática de PR após o build.

## Testes offline da implementação

```sh
python3 -m unittest operations/test_workspace_build.py -v
```

Os testes verificam sintaxe dos argumentos, escopo dos mounts, falha fechada,
bloqueio de traversal/symlink, exclusão da cópia temporária e rede `none` nos testes.
Eles **não** comprovam a execução de `npm test` na VPS. O GitHub Actions verifica também a compilação TypeScript do Painel, os contratos dos Agentes e a inicialização real do Chromium em Docker isolado.
