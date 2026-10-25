FROM node:24-alpine
WORKDIR /app
COPY api.mjs github.ts apps.ts ./
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "api.mjs"]
