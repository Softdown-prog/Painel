FROM node:24-bookworm-slim
ARG CODEX_NPM_VERSION=latest
RUN npm install --global --no-audit --no-fund "@openai/codex@${CODEX_NPM_VERSION}"
WORKDIR /app
COPY bridge.mjs ./
USER node
ENV NODE_ENV=production CODEX_HOME=/home/node/.codex PORT=8091
CMD ["node", "bridge.mjs"]
