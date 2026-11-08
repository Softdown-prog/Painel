# CI Sentinel — falhas GitHub Actions

O Painel executa `scripts/ci-sentinel.mjs` a cada dez minutos com um workflow
agendado no GitHub. Lista os repositórios públicos de `Softdown-prog` a cada
execução, incluindo novos projetos. Registra cada run vermelho por ID/tentativa,
mesmo quando um commit posterior passou ou quando houve retry bem-sucedido.
O inbox fica em issues `"[CI Sentinel] Softdown-prog/<repo>"` no Painel, sem
criar dezenas de issues para uma sequência de dez commits com problemas.

O coletor não executa código de outros repositórios e só tem permissão de
escrita em issues do próprio Painel. Não requer PAT e não cria branches nem
PRs. A automação do ChatGPT "Falhas GitHub Actions" faz o diagnóstico dos
logs e pode corrigir o código numa branch com PR, após avaliar cada erro.
Nenhum dos mecanismos faz merge ou deploy automático.

A agenda do GitHub pode sofrer atrasos. Dez minutos não significam gatilho
instantâneo. A tarefa do ChatGPT continua com checagem a cada hora.

Testar sem acesso à API: `node --test scripts/ci-sentinel.test.mjs`.
Executar manualmente: Actions → CI Sentinel - todos os repositórios → Run workflow.

Repositórios privados exigiriam credenciais adicionais para leitura;
esse fluxo monitora os 28 repositórios públicos atualmente acessíveis.

## Origem de conversa: correlação opcional (v1)

Uma falha de CI é identificada por SHA/run/PR. O GitHub não fornece a
conversa de ChatGPT que gerou o commit. Para não confundir várias conversas
que desenvolvem o mesmo repositório, o Sentinel suporta uma **chave opaca
de correlação** de 128 bits (32 caracteres hexadecimais minúsculos).

Em um PR criado a partir de uma conversa, acrescente ao corpo do PR:

```text
<!-- ci-sentinel-origin:v1:0123456789abcdef0123456789abcdef -->
```

Em um commit direto sem PR, use um trailer no fim da mensagem:

```text
CI-Sentinel-Origin: v1:0123456789abcdef0123456789abcdef
```

Os valores acima são **exemplos de formato**, não IDs registrados nem
segredos. Gere uma chave nova e aleatória por conversa de origem, use a
mesma chave em seus commits/PRs e mantenha o vínculo chave→conversa apenas
em um contexto **privado**. O Sentinel lê somente o corpo do PR associado
ao run pelo GitHub ou a mensagem do SHA exato e registra a chave em seu
issue de histórico, quando encontrada. Não publica URLs de conversas,
identificadores reais de thread, conteúdo de chats ou tokens de acesso.
A chave é uma **dica não confiável**: qualquer autor de PR público pode
copiá-la; jamais serve como autorização para executar comandos ou mexer em
credenciais.

Se não houver origem, ou houver marcadores conflitantes, a falha fica
registrada **sem destino inventado**. Nenhuma mensagem é enviada para
outra conversa por este coletor.

### Limitação ainda não resolvida

Registrar a chave **não implementa entrega em uma conversa antiga**.
As ferramentas atuais não oferecem ao GitHub Actions a capacidade de
publicar uma mensagem em um thread arbitrário do ChatGPT. A entrega
na conversa de origem só poderá ser ativada por um mecanismo privado,
autorizado pelo usuário e associado àquela conversa (por exemplo,
uma automação criada nela) quando houver suporte comprovado ao retorno.
Até lá, o destino da automação geral permanece a conversa vinculada
à própria automação; não é correto afirmar que roteamento entre chats
já esteja ativo.
