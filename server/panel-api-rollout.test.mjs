import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
test('rollout is not hardcoded to a stale image and handles 13 or 14 Compose files', () => {
  const deploy = read('./deploy-panel-api-postgres-vps.sh');
  assert.match(deploy, /SHA="\$\{1:-\}"/);
  assert.match(deploy, /postgres_count/);
  assert.match(deploy, /\$postgres_count -eq 0/);
  assert.match(deploy, /compose\.postgres\.yaml/);
  assert.doesNotMatch(deploy, /\$\{#FILES\[@\]\} -eq 13/);
  assert.match(deploy, /--force-recreate api/);
  assert.match(deploy, /rollback\(\)/);
  assert.match(deploy, /getDatabaseStatus/);
  assert.doesNotMatch(deploy, /docker system prune|down -v|docker compose .* down/);
});
test('release build is SHA-labeled, pinned and does not restart production', () => {
  const build = read('./build-panel-api-release-vps.sh');
  assert.match(build, /org\.opencontainers\.image\.revision=\$SHA/);
  assert.match(build, /codeload\.github\.com\/Softdown-prog\/Painel\/tar\.gz\/\$SHA/);
  assert.match(build, /vps-panel-api:\$SHA/);
  assert.doesNotMatch(build, /up -d|docker restart|docker system prune/);
});
test('production diagnosis compares GitHub main to real running image and is read-only', () => {
  const diagnose = read('./panel-api-deploy-check-vps.sh');
  assert.match(diagnose, /docker inspect softload-panel-api/);
  assert.match(diagnose, /api\.github\.com\/repos\/Softdown-prog\/Painel\/commits\/main/);
  assert.match(diagnose, /PENDENTE: a API instalada/);
  assert.doesNotMatch(diagnose, /docker stop|docker restart|up -d|docker build|docker system prune/);
});
