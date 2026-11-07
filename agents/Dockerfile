FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ARG CODEX_NPM_VERSION=0.167.0
RUN npm install --global --no-audit --no-fund "@openai/codex@${CODEX_NPM_VERSION}" && npm cache clean --force
RUN groupmod --gid 61110 node && usermod --uid 61110 --gid 61110 node && chown -R 61110:61110 /home/node
RUN mkdir /workspace-general && chown 61110:61110 /workspace-general && chmod 700 /workspace-general
RUN mkdir /workspace-admin && chown 61110:61110 /workspace-admin && chmod 700 /workspace-admin
WORKDIR /app
COPY bridge.mjs operations.mjs telemetry.mjs ./
USER node
ENV NODE_ENV=production CODEX_HOME=/home/node/.codex PORT=8091
CMD ["node", "bridge.mjs"]
