FROM rust:1.85.1-alpine AS native-build
WORKDIR /build
RUN apk add --no-cache musl-dev
COPY native-runtime/Cargo.toml native-runtime/Cargo.lock ./
COPY native-runtime/src ./src
RUN cargo test --locked --offline && cargo build --release --locked --offline

FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache openssh-client openssl
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY api.mjs github.ts apps.ts projects.ts hosted-projects.ts releases.ts image-import.ts domains.ts domain-publish.ts terminal-ssh.ts postgres-cert.ts revision-maintenance.ts publications.ts secrets.ts database.ts traffic.ts deploy-traffic.ts deploy-verification.mjs deploy-public-health.mjs legacy-softload-profile.ts host-metrics.ts resource-history.ts ./
# Authenticated administrative routes and their transitive SSH job manager dependencies.
COPY infrastructure.ts terminal-jobs.ts terminal-persistent.ts agents.ts ./
COPY check-api-connection.mjs ./
COPY native-runtime.mjs native-runtime-smoke.mjs ./
COPY --from=native-build --chmod=0555 /build/target/release/panel-runtime /usr/local/bin/panel-runtime
RUN node native-runtime-smoke.mjs
# The API runs as root with all Linux capabilities dropped. Its data volume must match the runtime UID.
RUN mkdir -p /data && chown 0:0 /data && chmod 0700 /data
ENV NODE_ENV=production PORT=8080 PANEL_NATIVE_RUNTIME=prefer
EXPOSE 8080
CMD ["node", "api.mjs"]
