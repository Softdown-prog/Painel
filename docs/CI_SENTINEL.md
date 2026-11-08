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
