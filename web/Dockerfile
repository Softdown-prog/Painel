# Canonical Angular-only frontend. No duplicated root JS/CSS dashboard.
FROM node:24-alpine AS angular-builder
WORKDIR /angular
COPY angular/package.json angular/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY angular/angular.json angular/tsconfig.json angular/tsconfig.app.json ./
COPY angular/src/ ./src/
RUN npm run build && test -s dist/panel-angular/browser/index.html

FROM node:24-alpine
WORKDIR /app
COPY index.html /app/public/index.html
COPY --from=angular-builder /angular/dist/panel-angular/browser/ /app/public/angular/
COPY web/server.mjs /app/server.mjs
ENV PORT=8081 PANEL_STATIC_DIR=/app/public
LABEL org.opencontainers.image.title="VPS Panel Angular frontend"
EXPOSE 8081
CMD ["node", "server.mjs"]
