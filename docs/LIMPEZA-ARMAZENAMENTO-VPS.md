# Limpeza do disco da VPS

## Dois escopos, uma preferência administrativa

A rotina antiga do Painel considera somente `image-imports.json`: duas revisões
por aplicação e prazo de 14 dias. Ela podia registrar zero itens mesmo com cache
e imagens de serviços instalados por outros pipelines. O timer antigo do host
limpa apenas arquivos abandonados de transferência da Softload. Nenhum desses
dois mecanismos era uma limpeza completa do host.

O coletor `operations/storage_cleanup.py`, instalado como
`/usr/local/sbin/vps-storage-cleanup`, trata imagens órfãs dos repositórios
efetivamente usados por containers da VPS e cache de build sem uso há 30 minutos.
Não executa `docker system prune`, não força remoções e não apaga containers,
volumes, bancos, certificados, segredos, código de clientes ou arquivos pessoais.
Imagens referenciadas por qualquer container, inclusive parado, candidata ou
backup, continuam protegidas. Importações gerenciadas pelo Painel permanecem
sob sua política própria e são excluídas do coletor do host.

O coletor mantém observação persistente de imagens sem uso: o prazo de seis horas
começa quando a imagem é observada, nunca pela data antiga do build. Repositórios
desconhecidos ficam para revisão. Cada remoção revalida todos os containers e o
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
15 minutos e faz a limpeza quando passaram seis horas desde a última conclusão;
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
travas, ausência de uso e revalidação por referência. A rotina agendada nunca
reduz esse prazo automaticamente.

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
