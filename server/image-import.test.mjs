import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleImageImportRoute, readImports } from './image-import.ts';

const name = 'Softdown-prog/sample';
const sha = 'a'.repeat(40);
const digest = 'sha256:' + 'b'.repeat(64);
const imageId = 'sha256:' + 'c'.repeat(64);
const imageRef = 'ghcr.io/softdown-prog/sample@' + digest;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'panel-ghcr-'));
  writeFileSync(join(dir, 'projects.json'), JSON.stringify([{ slug: 'demo', repository: name,
    connectedAt: '2026-10-25T00:00:00Z' }]));
  return dir;
}
const approved = {
  head_sha: sha, status: 'completed', conclusion: 'success', head_branch: 'main',
  path: '.github/workflows/panel-app-build.yml',
  repository: { full_name: name }, head_repository: { full_name: name }, event: 'workflow_dispatch'
};
const response = (code, data) => ({ status: code, buffer: Buffer.from(JSON.stringify(data)) });
async function request(dir, url, method = 'GET', input = {}, overrides = {}) {
  let value;
  const config = {
    dataDir: dir, enabled: true, body: async () => input,
    repositories: () => [{ fullName: name, branch: 'main', workflow: 'panel-app-build.yml' }],
    githubRequest: async path => {
      assert.equal(path, '/repos/' + name + '/actions/runs/42');
      return approved;
    },
    resolveDigest: async (repository, revision) => {
      assert.equal(repository, name);
      assert.equal(revision, sha);
      return digest;
    },
    pull: async ref => { assert.equal(ref, imageRef); },
    docker: async path => {
      assert.equal(path, '/images/' + encodeURIComponent(imageRef) + '/json');
      return response(200, { Id: imageId, RepoDigests: [imageRef], Config: {
        Labels: {
          'org.opencontainers.image.source': 'https://github.com/' + name,
          'org.opencontainers.image.revision': sha
        }, Healthcheck: { Test: ['CMD', '/healthcheck'] }
      } });
    },
    send: (_res, status, data) => { value = { status, data }; },
    ...overrides
  };
  assert.equal(await handleImageImportRoute({ url, method }, {}, config), true);
  return value;
}
async function waitForJob(dir) {
  for (let i = 0; i < 20; i++) {
    const result = await request(dir, '/projects/demo/images/import');
    if (result.data.job?.status !== 'running') return result;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Import did not settle');
}
test('GHCR image import pins remote digest and persists verified local image without changing containers', async () => {
  const dir = fixture();
  try {
    assert.equal((await request(dir, '/projects/demo/images/import', 'POST', { runId: 42 }, { enabled: false })).status, 403);
    assert.equal((await request(dir, '/projects/demo/images/import', 'POST', { runId: 42, name: 'other' })).status, 400);
    const result = await request(dir, '/projects/demo/images/import', 'POST', { runId: 42 });
    assert.equal(result.status, 202);
    assert.equal(result.data.digest, digest);
    const done = await waitForJob(dir);
    assert.equal(done.data.job.status, 'success');
    assert.equal(readImports(dir)[0].digest, digest);
    assert.equal(readImports(dir)[0].imageId, imageId);
    assert.equal((await request(dir, '/projects/demo/images/import')).data.imported.revision, sha);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('failed GitHub run or invalid image digest cannot start an import', async () => {
  const dir = fixture();
  try {
    assert.equal((await request(dir, '/projects/demo/images/import', 'POST', { runId: 42 }, {
      githubRequest: async () => ({ ...approved, conclusion: 'failure' }),
      pull: async () => { throw new Error('must not pull'); }
    })).status, 422);
    assert.equal((await request(dir, '/projects/demo/images/import', 'POST', { runId: 42 }, {
      resolveDigest: async () => 'sha256:invalid', pull: async () => { throw new Error('must not pull'); }
    })).status, 502);
    assert.deepEqual(readImports(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('import does not record a local image lacking exact RepoDigests pin', async () => {
  const dir = fixture();
  try {
    assert.equal((await request(dir, '/projects/demo/images/import', 'POST', { runId: 42 }, {
      docker: async () => response(200, { Id: imageId, RepoDigests: ['ghcr.io/someone/else@' + digest],
        Config: { Labels: {
          'org.opencontainers.image.source': 'https://github.com/' + name,
          'org.opencontainers.image.revision': sha
        }, Healthcheck: { Test: ['CMD', 'check'] } }
      })
    })).status, 202);
    const done = await waitForJob(dir);
    assert.equal(done.data.job.status, 'error');
    assert.deepEqual(readImports(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
