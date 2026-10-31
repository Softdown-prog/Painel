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

# Angular uses TypeScript 6 in an isolated workspace; the existing backend keeps TypeScript 7.
FROM node:24-alpine AS angular-builder
WORKDIR /angular
COPY angular/package.json angular/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY angular/angular.json angular/tsconfig.json angular/tsconfig.app.json ./
COPY angular/src/ ./src/
RUN npm run build && test -s dist/panel-angular/browser/index.html

FROM node:24-alpine
WORKDIR /app
COPY --from=builder /build/dist/ /app/public/
COPY --from=angular-builder /angular/dist/panel-angular/browser/ /app/public/angular/
COPY web/server.mjs /app/server.mjs
ENV PORT=8081 PANEL_STATIC_DIR=/app/public
LABEL org.opencontainers.image.title="VPS Panel web frontend"
EXPOSE 8081
CMD ["node", "server.mjs"]
