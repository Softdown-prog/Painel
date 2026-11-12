# Softdown Dev Toolbox: opt-in, disposable multi-stack developer image.
# The always-on Codex/MCP service keeps its small image; this is not a replacement.
# Upstream tags are deliberately documented as version FAMILY pins until their
# content digests are verified in CI and frozen for the VPS.
ARG NODE_REF=node:24-bookworm-slim
ARG PYTHON_REF=python:3.13-slim-bookworm
ARG GO_REF=golang:1.26-bookworm
ARG RUST_REF=rust:1.97-slim-bookworm
FROM ${NODE_REF} AS upstream-node
FROM ${PYTHON_REF} AS upstream-python
FROM ${GO_REF} AS upstream-go
FROM ${RUST_REF} AS upstream-rust

FROM ubuntu:24.04 AS core
ARG DEBIAN_FRONTEND=noninteractive
ENV CI=1 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    HOME=/tmp \
    PATH=/usr/local/bin:/usr/bin:/bin
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl wget git gh gnupg openssh-client jq ripgrep \
      unzip zip xz-utils file make gcc g++ cmake pkg-config \
      libssl3t64 libffi8 libsqlite3-0 libbz2-1.0 liblzma5 \
      libreadline8 libgdbm6t64 libncursesw6 zlib1g \
      postgresql-client redis-tools \
    && rm -rf /var/lib/apt/lists/*
# Keep Python and Node binaries at the paths their official images expect.
COPY --from=upstream-python /usr/local/ /usr/local/
COPY --from=upstream-node /usr/local/bin/ /usr/local/bin/
COPY --from=upstream-node /usr/local/lib/node_modules/ /usr/local/lib/node_modules/
COPY --from=upstream-node /usr/local/include/node/ /usr/local/include/node/
ARG PNPM_VERSION=10.0.0
ARG YARN_VERSION=1.22.22
ARG TS_VERSION=7.0.2
ARG TSX_VERSION=4.20.0
ARG TS_NODE_VERSION=10.9.2
RUN npm install --global --no-audit --no-fund \
      "pnpm@${PNPM_VERSION}" "yarn@${YARN_VERSION}" \
      "typescript@${TS_VERSION}" "tsx@${TSX_VERSION}" "ts-node@${TS_NODE_VERSION}" \
    && npm cache clean --force \
    && node --version && python3 --version && npm --version \
    && pnpm --version && yarn --version
LABEL org.opencontainers.image.source="https://github.com/Softdown-prog/Painel" \
      com.softdown.panel.toolbox="core"
WORKDIR /work
CMD ["bash"]

# Multi-language compiler target; only pull/build when a project requires it.
FROM core AS languages
RUN apt-get update && apt-get install -y --no-install-recommends \
      openjdk-21-jdk-headless ruby-full php-cli php-mbstring \
    && rm -rf /var/lib/apt/lists/*
COPY --from=upstream-go /usr/local/go/ /usr/local/go/
COPY --from=upstream-rust /usr/local/cargo/ /usr/local/cargo/
COPY --from=upstream-rust /usr/local/rustup/ /usr/local/rustup/
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/work/.cargo \
    PATH=/usr/local/go/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin
RUN go version && rustc --version && cargo --version && java -version \
    && ruby --version && php --version
LABEL com.softdown.panel.toolbox="languages"

# Project-browser target: use the SAME Playwright version as LHS/Terrania lockfiles.
FROM languages AS browser
ARG PLAYWRIGHT_VERSION=1.56.1
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    PUPPETEER_SKIP_DOWNLOAD=1
RUN npm install --global --no-audit --no-fund "playwright@${PLAYWRIGHT_VERSION}" \
    && playwright install --with-deps chromium \
    && chmod -R a+rX /opt/pw-browsers \
    && playwright --version \
    && rm -rf /var/lib/apt/lists/* /root/.npm
LABEL com.softdown.panel.toolbox="browser"

# Optional complete toolbox: large data-science, documents and media layer.
# Never run it continuously as the Panel API, the Codex agent or a web service.
FROM browser AS full
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress \
      pandoc qpdf ffmpeg imagemagick tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*
COPY dev-toolbox/python-requirements.in /tmp/dev-toolbox-python-requirements.in
RUN python3 -m pip install --no-cache-dir -r /tmp/dev-toolbox-python-requirements.in \
    && python3 -c 'import numpy,pandas,scipy,sklearn,PIL,cv2,pytest,docx,pptx,pypdf'
ARG BUN_VERSION=1.4.0
RUN npm install --global --no-audit --no-fund \
      "bun@${BUN_VERSION}" \
      docx pptxgenjs pdf-lib pdfjs-dist sharp \
      marked markdownlint-cli remark-cli \
    && npm cache clean --force
LABEL com.softdown.panel.toolbox="full"
