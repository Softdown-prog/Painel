# Instruções para Codex — Softload Painel

Este repositório é o painel administrativo da VPS, não o projeto Softloadv4. O usuário quer um gerenciador de hospedagem fácil, rápido e capaz de crescer para vários sites, clientes e VPS.

## Leia antes de programar

1. `docs/TAREFAS-CODEX.md`: backlog **vivo** com prioridades, impedimentos, critérios de aceite e estado de cada função.
2. `docs/GUIA-RAPIDO.md`: linguagem que deve aparecer nas telas para quem não conhece Docker.
3. `README.md`: arquitetura e estado das integrações.
4. `docs/docker-executor.md` e `docs/domain-routing.md`: restrições de segurança e de ativação na VPS.

## Regras do projeto

- Sempre conferir os últimos commits da `main` antes de trabalhar; outras sessões podem estar alterando o código. Não sobrescrever alterações concorrentes.
- Usar português brasileiro simples nas telas. Termos de infraestrutura, quando necessários, ficam em “Configuração avançada”. A interface deve mostrar **o próximo passo**.
- Não afirmar que um domínio está público quando apenas foi reservado. Não afirmar que deploy ou saúde da VPS foi verificado com base apenas no CI.
- Manter os serviços internos da Softload separados dos containers de clientes; não usar labels, redes ou nomes de produção de maneira oportunista.
- Nunca remover limite de RAM/CPU/containers simplesmente para “escalar”. Escala exige quotas, isolamento, auditoria e monitoramento por servidor.
- O executor ainda tem acesso privilegiado ao Docker do host. Jamais expor comandos arbitrários, Docker socket ou tokens a clientes, frontend ou workflows não autorizados.
- O runner `softloadrunner` de Softloadv4 não tem acesso ao Docker/sudo por design. Não contornar essa restrição.
- Sem ordem explícita e mecanismo autorizado, **não tocar na VPS, DNS, Caddy de produção ou serviços em execução**. Documentar a pendência para o operador.
- Para novos arquivos frontend, usar TypeScript; `npm run build:frontend` recompila JS e `npm run check:js` valida scripts. Não publicar JS fora de sincronia.
- Rodar `npm run typecheck`, `npm test`, `npm run check:js`, `npm run build:frontend` e validação Compose pertinente.
- Após cada implementação atualizar `docs/TAREFAS-CODEX.md` com SHA e validações distintas: código criado, CI aprovado, frontend publicado e VPS validada.
- Escrever o resumo ao usuário assim: **o que ficou mais fácil**, **onde clicar**, **o que ainda falta**.

## Priorização

1. P0: implantação autorizada/rollback, publicação real de domínios, GitHub→deploy, isolamento multiusuário.
2. P1: tela única de sites, armazenamento/segredos, múltiplas VPS, backup, métricas.
3. P2: modelos de hospedagem, clientes, planos e testes de experiência.

O arquivo de tarefas documenta detalhes e aceites. Não substituir esse backlog por suposições.
