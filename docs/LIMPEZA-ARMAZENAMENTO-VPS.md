# Limpeza do disco da VPS

## Dois escopos, uma preferência administrativa

A política atual do Painel conserva somente imagens ligadas a containers existentes.
Não mantém duas revisões anteriores nem impõe retenção de 14 dias para imagens.
Uma imagem importada tem apenas uma hora de tolerância para iniciar a publicação.
O GHCR continua sendo a origem para novas instalações ou reversões futuras;
nenhuma imagem local extra fica reservada como backup.

O coletor `operations/storage_cleanup.py`, instalado como
`/usr/local/sbin/vps-storage-cleanup`, trata imagens sem container de qualquer repositório, inclusive imagens sem tag,
e cache de build sem uso há 30 minutos.
Não executa `docker system prune`, não força remoções e não apaga containers,
volumes, bancos, certificados, segredos, código de clientes ou arquivos pessoais.
Imagens referenciadas por qualquer container, inclusive parado, continuam
protegidas até que o container seja removido. Imagens instaladas para compilação
(`panel-lhs-qa:node24-pw1.56.1`, `panel-dev-toolbox:core/browser/full`)
ficam explicitamente preservadas mesmo sem container permanente. Importações
com menos de uma hora são protegidas para permitir o estágio de publicação.

O coletor mantém observação persistente de imagens sem uso: o prazo de 15 minutos
começa quando a imagem é observada, nunca pela data antiga do build. O timer
faz nova tentativa até uma hora depois; imagens de qualquer repositório entram
no plano, mas só são removidas se continuarem sem nenhum container. Cada remoção revalida todos os containers e o
ID resolvido pela referência, sem `force` e sem apagar pais automaticamente.
Mantém as mesmas travas dos deploys registrados/legados; build ou Runner.Worker
ativo adia o trabalho. Código de deploy, registro de projetos e permissões do
executor não são alterados. Uma imagem antiga removida deve ser obtida novamente
do registry para redeploy; não se conserva arquivo de backup de imagens.

## Operação pelo painel

Em **Revisões e espaço**, o botão existente também solicita o coletor quando
instalado. A API autenticada grava apenas UUID e instante num arquivo fixo; não
envia comandos, caminhos ou parâmetros root. O `systemd.path` processa a tarefa.
HTTP 202 significa solicitado, não concluído. Atualizar a tela mostra o estado,
quantidade de imagens e bytes realmente liberados segundo o sistema de arquivos.
Falha ou espera por deploy não aparece como sucesso vazio. O campo novo é
compatível com backend/instalações antigas; não declara instalação a partir do CI.

O botão **Ativar/Pausar limpeza automática** usa a mesma preferência persistida
de antes. O serviço do host consulta essa preferência. O timer verifica a cada
15 minutos e faz a limpeza quando passou uma hora desde a última conclusão;
uma espera por deploy será tentada novamente. Solicitações manuais têm UUID,
deduplicação persistente e validade de 24 horas. Dados em
`/var/lib/vps-storage-cleanup` e metadados sem credenciais no volume do Painel.

## Instalação e verificação

Revisar uma revisão consistente e executar como administrador
`python3 operations/install-storage-cleanup.py`. O instalador verifica o volume
existente, instala somente esse programa e suas três units, sem reiniciar API,
PostgreSQL, Caddy, aplicações ou runner. Recusa trocar uma instalação diferente
sem revisão de checksum. Código/CI e instalação são estados separados.

Sem argumentos, `vps-storage-cleanup` faz somente o plano. `--apply` aplica o
plano elegível. A primeira limpeza administrativa pode usar
`--apply --min-unused-hours 0` após revisão dos alvos: continua exigindo todas as
travas, ausência de uso e revalidação por referência. A rotina agendada respeita a observação de 15 minutos por imagem.

Consultar `systemctl status vps-storage-cleanup.timer`,
`journalctl -u vps-storage-cleanup.service` e o relatório do painel. Para pausar
somente este coletor, parar `vps-storage-cleanup.timer` e
`vps-storage-cleanup.path`; isso não interfere em serviços hospedados.

## Runner LHS

O ajuste no repositório A7 mantém os binários oficiais do runner uma única vez
no volume persistente. A imagem não incorpora mais pacote compactado e segunda
cópia dos binários. O volume de registro e ferramentas não é lixo e não é alvo
deste coletor. Redução da imagem e remoção das camadas antigas devem ser medidas
separadamente; somar tamanhos de imagens compartilhadas não mede espaço livre.

### Configuração privada do cliente Docker

O serviço preserva ProtectHome=yes/NoNewPrivileges e usa HOME/DOCKER_CONFIG em
/var/lib/vps-storage-cleanup. Não copia a configuração nem os tokens de /root.
O teste de CI executa --check-docker sob o mesmo sandbox do systemd, além da
fixture Docker e testes de autorização/concorrência. Atualizar uma instalação
existente exige --expected-installed-sha256 com o hash previamente auditado;
o instalador adquire a trava do coletor e recusa trocar units diferentes.
