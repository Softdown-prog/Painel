# Isolamento do Codex 0.167.0

O serviço é separado da API e do executor. UID/GID 61110 exclusivos, sem shell
de login no host, sem sudo, sem Docker socket, sem montagens de produção, raiz
somente leitura, todas as capacidades externas removidas, 1 GiB e 1,5 CPU.
A rede administrativa existente preserva o contrato do receptor de deploy:
nenhuma terceira rede é adicionada à API. Só o novo serviço recebe saída externa.

`apparmor.profile` é um perfil nomeado, aplicado somente ao novo container.
`/newroot/**` é a árvore temporária que bubblewrap monta em seu namespace privado;
`/ r` permite abrir a entrada da raiz do container. Não há montagem da raiz do
host. Os mapas `/proc/<pid>/{uid_map,gid_map,setgroups}` são necessários para o
namespace sem root. O kernel continua verificando o UID e capacidades externas.
O operador autorizou explicitamente esses caminhos na instalação de 07/11/2026.

`seccomp.json` deriva do perfil padrão Moby, revisão
`4b8214fc4971e06172938a1f1554ccff6647ee80`, cujo JSON original tem SHA-256
`6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6`.
A única regra adicional permite `unshare`, `clone`, `mount`, `umount2` e
`pivot_root` para bubblewrap. O comportamento padrão continua `SCMP_ACT_ERRNO`;
as demais regras são preservadas. Não usar seccomp/AppArmor unconfined em produção.
Fonte: https://github.com/moby/profiles/tree/4b8214fc4971e06172938a1f1554ccff6647ee80/seccomp

O protocolo de 0.167.0 **não aceita** os campos `readOnlyAccess`/`access` dentro
da política legada `sandboxPolicy`; campos desconhecidos podiam ser ignorados.
O bridge usa os perfis nomeados `permissions` reais dessa versão, habilitados
pela capability `experimentalApi`, e os aplica a criação, retomada e cada turno.
Cada perfil bloqueia os outros projetos, CODEX_HOME, `/state`, `/run/secrets`
e a rede das ferramentas. O processo confiável do Codex mantém acesso às suas
credenciais para inferência e renovação de OAuth; elas não são retornadas ao chat.
Reinicie somente o Codex depois de cadastrar um novo clone para registrar o perfil.

`sandbox-smoke.mjs` testa nove verificações com arquivos sintéticos e o app-server
real, sem chamadas a modelos ou credenciais reais. O workflow dedicado repete
esses testes em Linux. Aprovação da CI não significa instalação na VPS.
