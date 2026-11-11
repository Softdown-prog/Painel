# Disposable local QA image for the entire Lan House Simulator.
# Build once on the VPS; each workspace test uses docker run --rm without apt.
FROM node:24-bookworm-slim
ARG PLAYWRIGHT_VERSION=1.56.1
ENV CI=1 \
    NG_CLI_ANALYTICS=false \
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npm install --global --no-audit --no-fund "playwright@${PLAYWRIGHT_VERSION}" \
    && playwright install --with-deps chromium \
    && chmod -R a+rX /opt/pw-browsers \
    && node --version \
    && playwright --version \
    && rm -rf /var/lib/apt/lists/* /root/.npm
WORKDIR /work
LABEL com.softdown.panel.workspace-build="lhs" \
      org.opencontainers.image.source="https://github.com/Softdown-prog/Painel"
