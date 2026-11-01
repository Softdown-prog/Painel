# Testes de entrada antes da produção

O agente é uma barreira determinística dentro do receptor `vpsops` já autorizado.
Não precisa de modelo de IA, daemon adicional, porta pública ou novo segredo.
Fica disponível pelo mesmo SSH com comando forçado e identidade OIDC do GitHub.

## Sequência de publicação

1. O GitHub testa e constrói as imagens do commit autorizado na `main`.
2. A VPS autentica a execução, aplica a trava do projeto e rejeita repetições divergentes.
3. O contrato instalado pelo administrador precisa listar exatamente os serviços atuais.
4. As imagens precisam ter digest, origem e SHA corretos.
5. Cada candidata é iniciada isoladamente e passa pelos testes fixos da VPS.
6. Somente quando **todas** passam o adaptador atualiza os serviços daquele projeto.
7. A verificação final continua exigindo SHA instalado, saúde e HTTPS quando configurado.
8. Falha após a ativação usa o rollback existente. Falha na entrada nem inicia a ativação.

Não é garantia de ausência de bugs: testa contratos operacionais específicos. Testes
funcionais do projeto continuam no CI; credenciais e bancos reais não são entregues
a uma imagem ainda não aprovada. Um serviço novo precisa de contrato antes do deploy.

## Formulário por projeto

O campo `admission` fica em `/etc/vps-operations/policy.json`, fora do repositório e
dos inputs do workflow. Exemplo para uma API independente:

```json
{
  "version": 1,
  "services": {
    "api": {"profile": "http-json", "port": 8787, "path": "/health", "revisionField": "revision"}
  }
}
```

Não aceita comandos, scripts, variáveis livres, mounts, destinos externos nem prazo
arbitrário. A imagem deve responder JSON com a revisão esperada. Perfis disponíveis:

| Perfil | Verificações isoladas |
| --- | --- |
| `panel-api` | Inicialização real da API genérica, SHA da sessão, booleanos, dados administrativos recusados sem sessão e chave de borda obrigatória |
| `panel-executor` | Inicialização e módulos reais, saúde via daemon Docker simulado, inventário vazio e rejeição de criação privilegiada/ação em container alheio |
| `panel-web` | Inicialização, contrato da revisão e entrada Angular presente; proxy completo continua no teste de staging existente |
| `http-json` | Inicialização pelo comando da imagem e HTTP 200/JSON/revisão no endpoint cadastrado |

Uma candidata usa UID 65534, rede `none`, raiz somente leitura, capacidades removidas,
192 MiB sem swap adicional, 0,5 CPU, 64 processos e diretórios temporários limitados.
Não monta dados, credenciais, certificados ou socket Docker. O teste HTTP entra somente
na namespace de rede da candidata via `nsenter`; não publica portas nem conecta redes.
O executor recebe um daemon **simulado dentro da própria candidata**, sem acesso ao host.
Imagens com `VOLUME` implícito são recusadas para não criar volumes anônimos.
As candidatas são sequenciais, removidas ao fim e nunca substituem nomes de produção.

## Onde consultar o resultado

Abra a execução do deploy em **GitHub → Actions**. O resumo e `vps-result.json`
contêm `admission.status`, verificações, serviço que falhou e ação recomendada.
Uma rejeição retorna código 1, mantém `productionChanged: false` e deixa o workflow
com falha. O receptor guarda o mesmo resultado na auditoria SQLite privada.
Repetir uma solicitação que já falhou continua retornando código 1.
Não publica stdout da aplicação, credenciais ou logs privados do host.

## Instalação incremental

O Pages e o deploy de API **não instalam automaticamente executáveis root do host**.
`operations/install-admission-vps.py` atualiza somente o receptor existente e adiciona
os testes; não cria usuário, token, permissão, acesso Docker ou endpoint novo.
Exige checksums previamente auditados do driver e receptor instalados, adquire as
travas de todos os projetos e preserva adaptadores locais, inclusive Go shadow.
Aborta se houver projeto não revisado ou mudança concorrente.

Antes de trocar, guarda apenas os pequenos arquivos administrativos alterados e a
política em `/var/lib/vps-operations/admission-v1-before`, com acesso root. Não copia
código de aplicações, imagens nem volumes. A instalação preserva chaves e sudoers.
Reversão: com as mesmas travas, restaurar driver/receptor/política desse diretório;
os módulos novos podem permanecer sem consumidores. Nenhum container precisa reiniciar.

Softload V4 e outros projetos com receptores independentes **não ficam protegidos
automaticamente**. Devem integrar a mesma chamada antes da sua ativação e possuir
testes próprios. O inventário por si só não representa cobertura de deploy.

## Estado desta revisão

- Código: implementado na branch `feat/deploy-admission-guard`.
- Testes: 16 novos locais e 41 Python no Ubuntu aprovados; TypeScript, build frontend e sintaxe JS aprovados.
- Ensaio real na VPS: API/executor do Painel, Terrânia Node e Go aprovados; contrato inválido rejeitado, 12 IDs de produção preservados. Duração total: 49,89 s.
- CI de `c92c406dc18df570a9254666b835df3aed46a8e7`: Console `41270050600`, Rust/Node `41270050665` e Docker real `41270050682`, todos aprovados.
- Receptor instalado e contratos ativos: `panel`, `terrania`, `terrania-go-shadow`. Instalador do commit `c92c406`; testes do commit `f44f0bb` (mesmos bytes). Nenhum container reiniciado, sem candidatas restantes.
- Módulo `admission.py`: SHA256 `6f9107c13ec57a333e0e50522bcb5025858048d75c38fe287a4f4c0c08c86f73`; probe `be290ff73452c0b473c8cc45b6a384e63c4820027fff8a25acd745a35cf108e3`.
- Driver instalado: SHA256 `896675ef8c6ee90a7fdae0c96078adbdae0cfc201c0c876f8dac7e55c24e9752`; receiver `c1fbb5f359c41b62a75c85c2929dd344395616fef0c720517e12b1fdbaa4a765`.
- Reversão privada: `/var/lib/vps-operations/admission-v1-before`, 26.304 bytes; preserva os adaptadores locais anteriores. IDs comparados antes/depois da instalação: nenhuma mudança.
- Canal GitHub → receptor atualizado → GitHub: issue #67, run `41270124112`, exit 0, 1,779 s. Isso valida transporte/autenticação/inventário; não é um deploy.
- Primeiro deploy completo pelo novo gate: pendente de merge autorizado do PR #66. O merge foi bloqueado pela revisão automática por exigir aprovação específica do usuário; não foi contornado.
- APIs públicas continuam na revisão `7202ad14551947d039d13a5a0c04451c6b143223`; não declarar a revisão do PR como instalada dentro dos containers.
- Frontend: nenhuma alteração; não existe um botão novo nesta etapa.
