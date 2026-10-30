# Compilador TypeScript 7.0.2 — migração isolada do Painel VPS

- `typescript@7.0.2` é usado no CLI de verificação e na geração de JS, sem bibliotecas novas no runtime da API.
- O processo legado `tsc <arquivos> --module none` não existe no TS7. `build:frontend` usa `--ignoreConfig` para compilar arquivos explícitos e `--module preserve --moduleResolution bundler` para scripts de navegador. A flag `--ignoreConfig` impede que o `tsconfig.json` da API com `noEmit` altere a emissão de JS.
- O `tsconfig.json` de backend permanece em NodeNext, com `types: ["node"]` explícitos.
- Rodar CI completo: typecheck, todos os testes, checks de JS, build frontend, checks dos JS gerados e configuração Docker Compose; comparar diffs dos JS antes de publicar.
- **Não instalar PostgreSQL, criar containers, editar Docker/Caddy, redes, segredos ou modificar VPS.** Esta migração altera apenas a ferramenta de compilação.
- Não mesclar caso a saída JS precise de ajustes não revisados ou qualquer teste falhe.
