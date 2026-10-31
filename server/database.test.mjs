import test from 'node:test';
import assert from 'node:assert/strict';
import { getDatabaseStatus, handleDatabaseRoute } from './database.ts';

test('disabled without explicit opt-in', async () => {
  const s = await getDatabaseStatus({});
  assert.equal(s.integration, 'not_configured');
  assert.equal(s.enabled, false);
  assert.equal(s.databases, null);
});
test('reads version, real database inventory and metrics via fixed queries', async () => {
  const queries = [];
  let closed = false;
  const client = {
    async connect() {},
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith('SET ')) return { rows: [] };
      if (sql.includes('current_setting')) return { rows: [{
        version: '18.1', database_count: 2, connections: 4, total_bytes: '2048',
      }] };
      return { rows: [
        { name: 'postgres', owner: 'postgres', size_bytes: '1024' },
        { name: 'site_a', owner: 'site_user', size_bytes: '1024' },
      ] };
    },
    async end() { closed = true; },
  };
  const s = await getDatabaseStatus({ PANEL_POSTGRES_ENABLED: '1' }, () => client);
  assert.equal(s.integration, 'connected');
  assert.equal(s.metrics.databaseCount, 2);
  assert.equal(s.metrics.totalBytes, 2048);
  assert.deepEqual(s.databases.map(db => db.name), ['postgres', 'site_a']);
  assert.ok(queries[0].includes('default_transaction_read_only = on'));
  assert.ok(queries.slice(1).every(sql => sql.startsWith('SELECT ')));
  assert.equal(closed, true);
});
test('connection failure is opaque to the browser', async () => {
  const s = await getDatabaseStatus({ PANEL_POSTGRES_ENABLED: '1' }, () => ({
    async connect() { throw new Error('secret password: leaked'); },
    async query() { throw new Error('not reached'); },
    async end() {},
  }));
  assert.equal(s.integration, 'unavailable');
  assert.equal(s.enabled, true);
  assert.equal(JSON.stringify(s).includes('leaked'), false);
});
test('only status GET is permitted', async () => {
  const responses = [];
  const send = (_, status) => responses.push(status);
  const loadStatus = async () => ({ engine: 'postgresql', integration: 'not_configured' });
  await handleDatabaseRoute({ url:'/database/status', method:'GET' }, {}, { send, loadStatus });
  await handleDatabaseRoute({ url:'/database/status', method:'POST' }, {}, { send, loadStatus });
  await handleDatabaseRoute({ url:'/database/query', method:'POST' }, {}, { send, loadStatus });
  assert.deepEqual(responses, [200,405,503]);
});
