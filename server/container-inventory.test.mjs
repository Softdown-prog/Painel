import test from 'node:test';
import assert from 'node:assert/strict';
import { hostContainerInventory } from './container-inventory.ts';

test('inventory discovers Compose containers without giving them management rights', () => {
  const result = hostContainerInventory([
    { Names: ['/terrania-origins-multiplayer-1'], Image: 'terrania:0.3',
      State: 'running', Status: 'Up 2 hours', Labels: {
        'com.docker.compose.project': 'terrania-origins',
        PASSWORD: 'do-not-expose',
        'com.softload.panel.managed': 'false' },
      Ports: [{ PublicPort: 8787 }], HostConfig: { Binds: ['/:/host'] } },
    { Names: ['/softload-vps-app-1'], Image: 'softload:4', State: 'running', Status: 'Up',
      Labels: { 'com.docker.compose.project': 'softload-vps' } },
    { Names: ['/softload-app-shop'], Image: 'shop:2', State: 'exited', Status: 'Stopped',
      Labels: { 'com.softload.panel.managed': 'true', 'com.softload.panel.slug': 'shop' } }
  ]);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.containers.map(item => item.name), [
    'softload-app-shop', 'softload-vps-app-1', 'terrania-origins-multiplayer-1'
  ]);
  assert.equal(result.containers[2].project, 'terrania-origins');
  assert.equal(result.containers[2].ownership, 'external');
  assert.equal(result.containers[1].ownership, 'softload');
  assert.equal(result.containers[0].ownership, 'managed');
  assert.doesNotMatch(JSON.stringify(result), /do-not-expose|PublicPort|Binds|PASSWORD/);
  assert.equal('controllable' in result.containers[2], false);
});

test('inventory rejects malformed results and caps large lists', () => {
  assert.throws(() => hostContainerInventory({ error: 'not an array' }), /inválida/);
  const list = Array.from({ length: 502 }, (_, n) => ({
    Names: ['/website-' + String(n)], State: 'running'
  }));
  const result = hostContainerInventory(list);
  assert.equal(result.containers.length, 500);
  assert.equal(result.truncated, true);
  assert.deepEqual(hostContainerInventory([
    { Names: ['../../etc/passwd'], Labels: { 'com.docker.compose.project': 'bad' } },
    { Names: null },
    null
  ]).containers, []);
});
