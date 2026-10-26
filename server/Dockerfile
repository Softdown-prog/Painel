FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache openssh-client
COPY api.mjs github.ts apps.ts projects.ts releases.ts image-import.ts domains.ts terminal-ssh.ts revision-maintenance.ts publications.ts secrets.ts deploy-verification.mjs ./
# The API runs as root with all Linux capabilities dropped. Its data volume must match the runtime UID.
RUN mkdir -p /data && chown 0:0 /data && chmod 0700 /data
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "api.mjs"]
