# Workspaces de build isolados (primeira etapa)

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
- Usa `node:24-bookworm-slim` (imagem a fixar por digest em produção). **Não executa
  Playwright real ainda**; um perfil de navegador exigirá imagem com Chromium e
  bibliotecas pré-instalados. Os perfis testam TypeScript/Node/Angular sem abrir navegador.
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
sudo docker pull node:24-bookworm-slim
```

A imagem em produção deverá ser fixada por digest SHA-256 após homologação.
O script exige UID administrativo para iniciar e apenas acessa cópias cadastradas
sob `/srv/panel-codex/workspace`. Para verificar o ID real, consulte as cópias
no Painel, não invente nomes. **Não copie chaves nem tokens para o workspace.**

## Uso com o MCP administrativo existente

Em **Painel → Agentes Codex → Administração da VPS**, a ferramenta já existente
`solicitar_comando_vps` pode propor o comando fixo, sujeito à aprovação humana:

```sh
python3 /usr/local/lib/panel-workspaces/workspace_build.py start gh_12_abcdef12 lhs-precommit
```

`gh_12_abcdef12` é um **exemplo de identificador**, não o nome de uma cópia
confirmada na VPS. O retorno é JSON com `jobId`. Um segundo comando consulta o
andamento, sem publicar nada no GitHub:

```sh
python3 /usr/local/lib/panel-workspaces/workspace_build.py status <jobId>
```

Perfis atuais:

| Perfil | Passos |
| --- | --- |
| `lhs-quick` | npm ci, typecheck, build e **40 arquivos de testes representativos** de simulação, economia, clientes, filas, circulação, saves, PS1/PS2, renderização, serviços e interface. **Smoke, não aprovação do jogo inteiro** |
| `lhs-core` | npm ci, typecheck, build, npm test |
| `lhs-angular` | npm ci, dependências Angular, typecheck, build, lint e build Angular |
| **`lhs-precommit` (padrão)** | TypeScript, build, **todos os testes Node do jogo via `npm test`**, lint e build de produção Angular. **Não substitui os testes reais de navegador no CI** |

O perfil rápido jamais autoriza um commit isoladamente. Para alterações normais, usar o perfil padrão **`lhs-precommit`**, e para Canvas, gameplay e UI também exigir Playwright e capturas reais numa etapa adicional. A API não deve inferir aprovação do GitHub PR a partir deste resultado. Um build
válido exige `status=passed`; `queued`, `running`, `busy` ou `failed` **não** são
sucesso. Os jobs iniciados pelo terminal são curtos: o script cria um supervisor
desvinculado, e os perfis podem durar vários minutos. Logs de etapas permanecem
na pasta privada do job e são retornados em trecho limitado pela operação `status`.

## Pendências antes da automação ponta a ponta

1. Integrar `validar_workspace` e `consultar_workspace` ao bridge de ferramentas
   do projeto com vínculos protegidos, em vez do comando administrativo manual.
2. Homologar Docker real no servidor, versões Node e acessos de rede (o teste
   local atual usa subprocessos simulados, **não** o daemon da VPS).
3. Adicionar perfil Playwright/Chromium e captura dos visuais reais.
4. Adicionar expiração e limpeza de históricos de job; os diretórios temporários
   da cópia são removidos automaticamente ao final de cada tarefa.
5. Configurar uma rede de instalação com egress restrito e imagem por digest.

## Testes offline da implementação

```sh
python3 -m unittest operations/test_workspace_build.py -v
```

Os testes verificam sintaxe dos argumentos, escopo dos mounts, falha fechada,
bloqueio de traversal/symlink, exclusão da cópia temporária e rede `none` nos testes.
Eles **não** comprovam a execução de `npm test` na VPS.
