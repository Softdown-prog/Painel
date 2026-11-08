import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const file = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('database uses one Angular page with native navigation and views',()=>{
 const root=file('index.html'),shell=file('angular/src/app.component.html');
 const ts=file('angular/src/postgres.component.ts'),tpl=file('angular/src/postgres.component.html');
 assert.ok(root.includes("'database'"));
 assert.ok(root.includes("location.replace('/angular/#'"));
 assert.match(shell,/selectPage\('database'\)/);
 assert.match(shell,/<panel-postgres\s*\/>/);
 assert.match(ts,/view=signal<'databases'\|'roles'\|'backups'>/);
 assert.match(tpl,/dbProject/);
 assert.doesNotMatch(root,/src="database-ui\.js"|href="database\.css"/);
});
test('Angular database provisioning requires server readiness and typed confirmation',()=>{
 const ts=file('angular/src/postgres.component.ts'),tpl=file('angular/src/postgres.component.html');
 assert.match(ts,/provisioningEnabled===true/);
 assert.match(ts,/hostAuthentication==='cert'/);
 assert.match(ts,/this\.confirmation\(\)!==slug/);
 assert.match(ts,/\/database\/projects/);
 assert.match(tpl,/Preparar criação/);
 assert.doesNotMatch(tpl,/type="password"|CREATE ROLE|CREATE DATABASE/);
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
