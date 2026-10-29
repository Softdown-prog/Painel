FROM node:24-alpine
WORKDIR /app
COPY executor.mjs executor-policy.ts container-inventory.ts legacy-softload-profile.ts ./
ENV NODE_ENV=production PANEL_EXECUTOR_SOCKET=/run/panel-executor/docker.sock
CMD ["node", "executor.mjs"]
