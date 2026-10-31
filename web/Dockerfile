# Build the existing TypeScript frontend without moving backend/API code.
FROM node:24-alpine AS builder
WORKDIR /build
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY *.ts *.js *.css index.html ./
COPY scripts/version-pages-assets.mjs ./scripts/version-pages-assets.mjs
RUN npm run build:frontend
ARG PANEL_WEB_REVISION=0000000000000000000000000000000000000000
RUN echo "$PANEL_WEB_REVISION" | grep -Eq '^[a-f0-9]{40}$' \
    && mkdir -p /build/dist \
    && cp index.html *.css *.js /build/dist/ \
    && GITHUB_SHA="$PANEL_WEB_REVISION" PAGES_DIST_DIR=/build/dist node scripts/version-pages-assets.mjs \
    && grep -q 'terminal-ui.js?v=' /build/dist/index.html

FROM node:24-alpine
WORKDIR /app
COPY --from=builder /build/dist/ /app/public/
COPY web/server.mjs /app/server.mjs
ENV PORT=8081 PANEL_STATIC_DIR=/app/public
LABEL org.opencontainers.image.title="VPS Panel web frontend"
EXPOSE 8081
CMD ["node", "server.mjs"]
