# Manutenção aprovada usando o executor vpsops atual

O usuário `vpsops`, a chave SSH, o forced-command e o wrapper
`/usr/local/libexec/vps-operations` continuam **os mesmos**. Não criar outro
usuário, SSH, túnel, runner nem conceder `NOPASSWD: ALL`.

O broker continua rodando como root apenas no wrapper já autorizado e passa
a reconhecer a operação `maintain` para chamadas do workflow manual
`.github/workflows/vps-maintenance.yml`. O protocolo OIDC verifica
repositório ID, autor ID, `main`, `workflow_dispatch`,
caminho exato do workflow e ambiente `vps-maintenance`.

## Configuração de aprovação (obrigatória antes de manutenção)

No GitHub, abrir **Settings → Environments → New environment** e criar
`vps-maintenance`. Configurar **Required reviewers** (identidade de um
administrador real) e impedir bypass quando disponível. **Se não houver essa
proteção, o workflow não pode ser considerado submetido a aprovação humana.**
A checagem OIDC confirma a identidade do ambiente, mas não verifica por si
só que há revisores configurados. Usar `workflow_dispatch` manual; PRs,
pushes e issues não acionam manutenção.

## Upgrade inicial do mesmo executor (uma única vez)

O código executado como root em `/usr/local/lib/vps-operations` não é
auto-atualizado por commits. Para instalar uma versão revisada e fixa da
`main`, usar uma sessão administrativa independente e executar:

```bash
SHA=<SHA40_DA_MAIN_VERIFICADA>
DIR="$(mktemp -d)"
curl -fsSL "https://codeload.github.com/Softdown-prog/Painel/tar.gz/$SHA" -o "$DIR/painel.tar.gz"
tar -xzf "$DIR/painel.tar.gz" --strip-components=1 -C "$DIR"
sudo bash "$DIR/operations/upgrade-vpsops-maintenance.sh" "$DIR"
```

O script preserva todas as entradas preexistentes da política JSON, SSH,
sudoers, volumes e containers. Só atualiza o receiver existente, adiciona
`maintenance.py` e autoriza o fluxo/ação `maintain`. O código anterior não
é transformado em shell livre. **Nenhum serviço é reiniciado no upgrade.**

## No GitHub Actions

Abra **Actions → VPS maintenance via existing vpsops executor → Run workflow**.
Escolha:

- `host_summary` / `host`: disco, memória e carga do host (somente leitura).
- `container_status` / alvo permitido: estado, saúde, revisão e limites.
- `restart_container` / alvo permitido: só o container registrado, exigindo
  confirmação literal `RESTART:<alvo>`.

Os alvos de início são `panel-api`, `panel-executor`, `panel-web` e
`terrania-multiplayer`. Antes de reiniciar, o broker confere associação do
container ao projeto/serviço Docker Compose registrado e obtém lock do
projeto. Após reiniciar, verifica novamente saúde, imagem e revisão.

Outros containers — incluindo PostgreSQL e Caddy compartilhados — **não
são reiniciados** por essa operação. O frontend não recebe Docker socket,
token de acesso nem botões privilegiados novos.

Ações não suportadas, caminhos arbitrários, comandos root livres e scripts
enviados por issue são recusados. A saída do Actions inclui somente dados
estruturados, sem ler segredos de ambiente. A auditoria do broker mantém ID,
hash e resultado da execução.

## Validação e limites

O GitHub CI comprova testes e empacotamento, mas **não comprova instalação
no host**. Confirmar atualização por uma execução real do workflow e comparar
o retorno `exitCode` e o estado dos containers. Operações mutáveis exigem
aprovação explícita no ambiente protegido. Este estágio não é acesso shell
root irrestrito; novas tarefas administrativas precisam de adaptadores
analisados e aprovados, usando o mesmo executor.
