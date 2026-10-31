FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache openssh-client openssl
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY api.mjs github.ts apps.ts projects.ts hosted-projects.ts releases.ts image-import.ts domains.ts domain-publish.ts terminal-ssh.ts postgres-cert.ts revision-maintenance.ts publications.ts secrets.ts database.ts traffic.ts deploy-traffic.ts deploy-verification.mjs deploy-public-health.mjs legacy-softload-profile.ts host-metrics.ts resource-history.ts ./
COPY check-api-connection.mjs ./
# The API runs as root with all Linux capabilities dropped. Its data volume must match the runtime UID.
RUN mkdir -p /data && chown 0:0 /data && chmod 0700 /data
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "api.mjs"]
