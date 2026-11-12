# Softdown Dev Toolbox — multi-stack development image (opt-in)

## Purpose and current status

A reproducible **toolbox candidate** alongside the Panel's existing, tested
`operations/workspace-build.Dockerfile` (Node 24 + Playwright 1.56.1 QA).
The permanent `vps-panel-codex` container remains lightweight and unchanged.
The new image is stored in Docker and is started **only on demand**.

**Important:** building this image is not a connection to ChatGPT, is not a
substitute for Codex/MCP authentication and does not silently enable agent
execution. Existing `lhs-precommit` and `terrania-precommit` continue using
their original QA image until an explicit, tested profile migration.

## Image targets

| Target | Tools | Typical use |
|---|---|---|
| `core` | Ubuntu 24.04, Node 24, Python 3.13, npm, pnpm 10, Yarn 1.22, TypeScript 7, tsx, ts-node, Git/gh, gcc/g++, CMake, jq, ripgrep, SSH, PostgreSQL and Redis clients | Fast web/TypeScript checks |
| `languages` | Core + Go 1.26, Rust 1.97/Cargo, Java 21, Ruby and PHP | Backend and cross-language validation |
| `browser` | Languages + Playwright 1.56.1 with real Chromium | Canvas, visual and mobile-browser QA |
| `full` | Browser + LibreOffice, Pandoc, qpdf, FFmpeg, ImageMagick, Tesseract, Bun 1.4, Python science/document packages and npm document/markdown packages | Optional heavy data/doc/media work |

The Dockerfile defaults to the final `full` target if no target is supplied.
**In production, always specify an explicit target** so no large image is built
by accident. Browser tests are real, not screenshots generated from text.

Project-level `package-lock.json` and Python lockfiles take precedence over
global tools. For example LHS and Terrania both use Playwright 1.56.1; the
other agent's Playwright 1.63 and Chrome for Testing 153 are **not** silently
substituted. The additional Chrome for Testing binary and `@playwright/mcp`
are not included in this first revision. The connected MCP service remains
a separate authenticated component.

### Version pinning policy

The image's *families* are declared, but upstream base tags (e.g.
`node:24-bookworm-slim`, `python:3.13-slim-bookworm`,
`ubuntu:24.04`) can move when new patches are published. The optional full
Python requirements use bounded ranges; optional npm media packages are
also not yet hash locked. Do **not** claim bit-for-bit reproducibility.
Before production installation, record and pin the audited image digests
and resolve complete Python/npm dependency locks. Updating one version
requires rerunning the full QA matrix and retaining the resulting image ID.

### Isolated validation

```sh
docker build --target core -f operations/dev-toolbox.Dockerfile -t panel-dev-toolbox:core operations/
docker build --target browser -f operations/dev-toolbox.Dockerfile -t panel-dev-toolbox:browser operations/

# Offline, read-only, with an unprivileged user.
docker run --rm --init --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 128 \
  --memory 2048m --memory-swap 2048m --cpus 2 \
  --shm-size 384m --user 61110:61110 \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m \
  -v "$PWD/operations/dev-toolbox/smoke.sh:/smoke.sh:ro" \
  panel-dev-toolbox:browser sh /smoke.sh browser
```

Build steps necessarily require external apt/npm download access; the
GitHub-hosted CI run is **not** an outbound-network allowlist. For the VPS,
use a dedicated filtered build network or pre-build and verify images in
trusted CI before pulling by digest. When executing code in the work
container, use `--network none`, never mount `docker.sock` or production
volumes and never provide root credentials or host secrets.

## Optional installation on the VPS — not performed by this branch

Only an authorized administrator of the host, after reviewing CI and the
exact checkout, can run:

```sh
sudo bash operations/install-dev-toolbox-vps.sh check /reviewed/Painel/checkout browser
sudo bash operations/install-dev-toolbox-vps.sh apply /reviewed/Painel/checkout browser
```

`check` reads host prerequisites and changes nothing. `apply` builds a
**new** `panel-dev-toolbox:browser` image and smoke-tests it; it never changes
Compose or replaces `panel-lhs-qa:node24-pw1.56.1`. `full` is deliberately
a separate, larger choice and has its own manually invoked CI validation.
The installer refuses low memory/disk resources and dirty tracked files.

For the VPS's limited RAM, build/install one image at a time, inspect actual
image sizes and prune **only specifically identified unused toolbox images**
if needed. Never run `docker system prune` as a generic cleanup.

## What remains before agent adoption

1. All CI contracts and real browser image checks must be green. Full image
   requires an explicit manual CI build and a reviewed dependency lock.
2. Record fixed image digests, scan licenses/vulnerabilities and test available
   RAM, disk and browser stability on a maintenance-safe VPS window.
3. Build a separately reviewed allowlisted execution route from the Panel's
   approved Codex tool calls to an ephemeral toolbox process. The agent must
   never gain the Docker socket or arbitrary host-shell access.
4. Retain existing LHS/Terrania QA gates, project-specific test scripts and
   one active branch; keep commits, PRs and merges user-authorized.

No code in this branch installs services, creates PRs, deploys or merges.
