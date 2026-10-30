import test from 'node:test';
import assert from 'node:assert/strict';
import { legacySoftloadEntries, legacySoftloadEnabled, LEGACY_SOFTLOAD_SERVICES } from './legacy-softload-profile.ts';

test('legacy Softload profile is optional and does not define hosted projects', () => {
  assert.equal(legacySoftloadEnabled({}), false);
  assert.equal(legacySoftloadEnabled({PANEL_SOFTLOAD_LEGACY: '0'}), false);
  assert.equal(legacySoftloadEnabled({PANEL_SOFTLOAD_LEGACY: 'true'}), false);
  assert.equal(legacySoftloadEnabled({PANEL_SOFTLOAD_LEGACY: '1'}), true);
  assert.deepEqual(legacySoftloadEntries(false), []);
  assert.deepEqual(legacySoftloadEntries(true).map(([id]) => id), ['app', 'agent', 'caddy']);
  assert.equal(LEGACY_SOFTLOAD_SERVICES.caddy.controllable, false);
  assert.equal(Object.keys(LEGACY_SOFTLOAD_SERVICES).length, 3);
});
