import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const file = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('database navigation and settings shortcut lead to an accessible panel with real tabs', () => {
  const page = file('index.html');
  assert.match(page, /href="#database" data-view="database"/);
  assert.match(page, /id="database" data-title="Banco de Dados"/);
  assert.match(page, /href="#database">Abrir Banco de Dados/);
  assert.match(page, /src="database-ui.js"/);
  assert.match(page, /href="database.css"/);
  for (const section of ['Overview','Projects','Access','Data','Recovery','Monitor']) {
    assert.match(page, new RegExp('id="dbTab' + section + '"'));
    assert.match(page, new RegExp('id="dbPane' + section + '" role="tabpanel"'));
  }
  assert.match(file('script.js'), /refreshDatabasePanel/);
});

test('database creation is gated by backend security readiness and does not expose credentials', () => {
  const page = file('index.html');
  const view = page.split('id="database" data-title="Banco de Dados"')[1].split('id="settings" data-title=')[0];
  assert.ok(view.includes('id="dbRefresh"'));
  assert.match(view, /id="dbCreateForm"[^>]*hidden/);
  assert.match(view, /disabled id="dbCreate"[^>]*>\+ Criar banco/);
  assert.match(view, /disabled[^>]*>\+ Criar usuário/);
  assert.match(view, /disabled[^>]*>Restaurar banco/);
  assert.match(file('database-ui.ts'), /request<DatabaseStatus>/);
  const client = file('database-ui.js');
  assert.match(client, /panelApi\.request\("\/database\/status"\)/);
  assert.match(client, /provisioningEnabled === true/);
  assert.match(client, /method: "POST"/);
  assert.match(client, /"\/database\/projects"/);
  assert.doesNotMatch(client, /password\s*:/);
});

test('Docker Compose remains without database containers and no PostgreSQL dependencies were added', () => {
  const compose = file('server/compose.yaml');
  const dependencies = JSON.parse(file('package.json'));
  assert.doesNotMatch(compose, /postgres(?:ql)?:|pgadmin:|mariadb:/i);
  assert.equal(dependencies.dependencies?.pg, undefined);
  assert.equal(dependencies.dependencies?.postgres, undefined);
  assert.match(file('server/database.ts'), /integration: "not_configured"/);
  assert.match(file('server/database.ts'), /integration: "connected"/);
  assert.match(file('server/compose.postgres.yaml'), /vps_pg_private/);
});
