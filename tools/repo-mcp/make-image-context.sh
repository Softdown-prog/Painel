#!/usr/bin/env bash
# Build context from committed code only; local untracked secrets not packaged.
set -euo pipefail
[[ $# -eq 1 && -n "${GITHUB_SHA:-}" ]] || { echo 'Usage: make-image-context.sh <output-folder> with GITHUB_SHA' >&2; exit 2; }
dest="$1"
mkdir -p "$dest/repos/Painel" "$dest/tools/repo-mcp"
git archive "$GITHUB_SHA" | tar -xf - -C "$dest/repos/Painel"
cp tools/repo-mcp/indexer.mjs tools/repo-mcp/http-server.mjs tools/repo-mcp/sac-report-router.mjs "$dest/tools/repo-mcp/"
printf '%s\n' '{"repos":[{"name":"Painel","path":"/srv/repos/Painel"}]}' > "$dest/registry.json"
