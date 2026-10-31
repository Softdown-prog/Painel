FROM node:24-alpine
LABEL org.opencontainers.image.source="https://github.com/Softdown-prog/Painel"
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision="${SOURCE_REVISION}"
WORKDIR /srv
COPY --chown=65534:65534 tools/repo-mcp/ /srv/tools/repo-mcp/
COPY --chown=65534:65534 repos/ /srv/repos/
COPY --chown=65534:65534 registry.json /srv/registry.json
ENV PORT=8789 HOST=0.0.0.0 REPO_MCP_REGISTRY_FILE=/srv/registry.json REPO_MCP_TOKEN_FILE=/run/secrets/code-mcp-token
USER 65534:65534
EXPOSE 8789
HEALTHCHECK --interval=20s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:8789/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","/srv/tools/repo-mcp/http-server.mjs"]
