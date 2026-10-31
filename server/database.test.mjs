import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabaseStatus, createProjectDatabase, handleDatabaseRoute } from './database.ts';

function temporaryAdmin() {
  const dir = mkdtempSync(join(tmpdir(), 'panel-pg-project-'));
  const file = join(dir, 'admin-password');
  const password = 'a'.repeat(40);
  writeFileSync(file, password, { mode: 0o600 });
  const env = {
    PANEL_POSTGRES_ENABLED: '1', PANEL_POSTGRES_WRITE_ENABLED: '1',
    PANEL_POSTGRES_PASSWORD_FILE: file, PANEL_POSTGRES_HOST: 'vps-postgres'
  };
  return { dir, file, password, env, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
const hba = (auth_method) => [{ type: 'host', auth_method, error: null }];
test('disabled without explicit opt-in', async () => {
  const s = await getDatabaseStatus({});
  assert.equal(s.integration, 'not_configured');
  assert.equal(s.security.provisioningEnabled, false);
});
test('reads database inventory, login roles and unsafe trust policy without mutation', async () => {
  const queries = [];
  let closed = false;
  const client = {
    async connect() {},
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith('SET ')) return { rows: [] };
      if (sql.includes('current_setting')) return { rows: [{
        version: '18.6', database_count: 2, connections: 9, total_bytes: '2048'
      }] };
      if (sql.includes('pg_hba_file_rules')) return { rows: hba('trust') };
      if (sql.includes('pg_roles')) return { rows: [
        { name: 'postgres', can_login: true, superuser: true },
        { name: 'u_site_loja', can_login: true, superuser: false }
      ] };
      return { rows: [
        { name: 'postgres', owner: 'postgres', size_bytes: '1024' },
        { name: 'p_site_loja', owner: 'u_site_loja', size_bytes: '1024' }
      ] };
    },
    async end() { closed = true; }
  };
  const s = await getDatabaseStatus({ PANEL_POSTGRES_ENABLED: '1' }, () => client);
  assert.equal(s.integration, 'connected');
  assert.equal(s.metrics.databaseCount, 2);
  assert.deepEqual(s.databases.map(db => db.name), ['postgres', 'p_site_loja']);
  assert.equal(s.roles[1].name, 'u_site_loja');
  assert.equal(s.security.hostAuthentication, 'trust');
  assert.equal(s.security.provisioningEnabled, false);
  assert.ok(queries[0].includes('default_transaction_read_only = on'));
  assert.ok(queries.slice(1).every(sql => sql.startsWith('SELECT ')));
  assert.equal(closed, true);
});
test('connection failure is opaque to the browser', async () => {
  const s = await getDatabaseStatus({ PANEL_POSTGRES_ENABLED: '1' }, () => ({
    async connect() { throw new Error('secret password: leaked'); },
    async query() { throw new Error('not reached'); },
    async end() {}
  }));
  assert.equal(s.integration, 'unavailable');
  assert.equal(s.enabled, true);
  assert.equal(JSON.stringify(s).includes('leaked'), false);
});
test('creation denies trust, missing opt-in and unsafe input without DB writes', async () => {
  const tmp = temporaryAdmin();
  try {
    await assert.rejects(createProjectDatabase('site-loja', tmp.dir, {}), /não habilitada/);
    await assert.rejects(createProjectDatabase('drop;database', tmp.dir, tmp.env), /Use 2 a 30/);
    let writes = 0;
    const mock = () => ({
      async connect() {},
      async query(sql) {
        if (!sql.startsWith('SELECT')) writes++;
        return { rows: hba('trust') };
      },
      async end() {}
    });
    await assert.rejects(createProjectDatabase('teste-loja', tmp.dir, tmp.env, mock), /SCRAM não confirmada/);
    assert.equal(writes, 0);
  } finally { tmp.remove(); }
});
test('creation requires that the LIVE connection reject an incorrect password', async () => {
  const tmp = temporaryAdmin();
  try {
    let created = false;
    const mock = () => ({
      async connect() {},
      async query(sql) {
        if (sql.includes('pg_hba_file_rules')) return { rows: hba('scram-sha-256') };
        if (sql.startsWith('CREATE')) created = true;
        return { rows: [] };
      }, async end() {}
    });
    await assert.rejects(createProjectDatabase('teste-loja', tmp.dir, tmp.env, mock), /rejeita senha incorreta/);
    assert.equal(created, false);
  } finally { tmp.remove(); }
});
test('secure creation generates a private role, database and persisted 0600 secret without exposing password', async () => {
  const tmp = temporaryAdmin();
  try {
    const writes = [];
    const mock = options => ({
      async connect() {
        if (options.password !== tmp.password) throw Object.assign(new Error('bad password'), { code: '28P01' });
      },
      async query(sql) {
        writes.push(sql);
        if (sql.includes('pg_hba_file_rules')) return { rows: hba('scram-sha-256') };
        if (sql.includes('rolsuper AS')) return { rows: [{ superuser: true }] };
        if (sql.includes('database_exists')) return { rows: [{ databases: 0, database_exists: 0, role_exists: 0 }] };
        return { rows: [] };
      },
      async end() {}
    });
    const created = await createProjectDatabase('site-loja', tmp.dir, tmp.env, mock);
    assert.deepEqual(created, {
      project: 'site-loja', database: 'p_site_loja', username: 'u_site_loja', credentialsStored: true
    });
    const file = join(tmp.dir,'database-credentials','site-loja.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const secret = JSON.parse(readFileSync(file,'utf8'));
    assert.equal(secret.username, 'u_site_loja');
    assert.equal(secret.database, 'p_site_loja');
    assert.ok(secret.password.length >= 48);
    assert.ok(!JSON.stringify(created).includes(secret.password));
    assert.ok(writes.some(sql => sql.startsWith('CREATE ROLE u_site_loja LOGIN PASSWORD')));
    assert.ok(writes.includes('CREATE DATABASE p_site_loja OWNER u_site_loja'));
    assert.ok(writes.includes('REVOKE ALL ON DATABASE p_site_loja FROM PUBLIC'));
    await assert.rejects(createProjectDatabase('site-loja',tmp.dir,tmp.env,mock),/credenciais registradas/);
  } finally { tmp.remove(); }
});
test('status route and guarded create route are explicit and other mutations are disabled', async () => {
  const responses = [];
  const send = (_, status, value) => responses.push({ status, value });
  const loadStatus = async () => ({ engine: 'postgresql', integration: 'not_configured' });
  await handleDatabaseRoute({ url:'/database/status', method:'GET' }, {}, { send, loadStatus });
  await handleDatabaseRoute({ url:'/database/status', method:'POST' }, {}, { send, loadStatus });
  await handleDatabaseRoute({ url:'/database/projects', method:'POST' }, {}, {
    send, body: async () => ({ project: 'site-loja' }),
    create: async slug => ({ project: slug, database:'p_site_loja', username:'u_site_loja', credentialsStored:true })
  });
  await handleDatabaseRoute({ url:'/database/projects', method:'POST' }, {}, {
    send, body: async () => ({ project:'site-loja', sql:'DROP DATABASE postgres' }),
    create: async () => { throw Error('unexpected'); }
  });
  await handleDatabaseRoute({ url:'/database/query', method:'POST' }, {}, { send, loadStatus });
  assert.deepEqual(responses.map(x => x.status), [200,405,201,400,503]);
  assert.equal(responses[2].value.credentialsStored, true);
  assert.equal(JSON.stringify(responses).includes('password'), false);
});
