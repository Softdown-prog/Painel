/** CI integration: /state and /workspace MUST be distinct Docker mounts. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,renameSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {Workspaces} from './workspaces.mjs';
import {projects} from './bridge.mjs';

const workspace=mkdtempSync('/workspace/.mount-test-');
const state=mkdtempSync('/state/mount-test-');
try{
 const source=join(state,'source');mkdirSync(source);writeFileSync(join(source,'hello.txt'),'repository fixture\n');
 const crossMount=join(state,'cross-mount');mkdirSync(crossMount);
 assert.throws(()=>renameSync(crossMount,join(workspace,'unexpected')),e=>e.code==='EXDEV',
  'test requires the separate mounts used in production');
 const archive=execFileSync('tar',['-czf','-','-C',state,'source']);
 const store=new Workspaces(workspace,state);
 const meta={project:'gh_123_01234567',repository:'Example/Repo',branch:'main',sourceSha:'a'.repeat(40)};
 assert.deepEqual(await store.receive(Readable.from(archive),meta),meta);
 assert.equal(readFileSync(join(workspace,meta.project,'hello.txt'),'utf8'),'repository fixture\n');
 assert.equal(store.origin(meta.project).sourceSha,meta.sourceSha);
 assert.deepEqual(projects(workspace),[meta.project]);
 assert.ok(!readdirSync(workspace).some(p=>p.startsWith('.import-')),'staging must be cleaned');
 assert.ok(!readdirSync(state).some(p=>p.startsWith('import-')),'archive staging must be cleaned');
 writeFileSync(join(workspace,meta.project,'hello.txt'),'preserve local work\n');
 await assert.rejects(store.receive(Readable.from(archive),meta),/existente/);
 assert.equal(readFileSync(join(workspace,meta.project,'hello.txt'),'utf8'),'preserve local work\n');
 const bad={...meta,project:'gh_456_01234567'};
 await assert.rejects(store.receive(Readable.from('invalid archive'),bad));
 assert.equal(existsSync(join(workspace,bad.project)),false);
 assert.ok(!readdirSync(workspace).some(p=>p.startsWith('.import-')));
 console.log('PASS: isolated import across production-style mounts; baseline and local changes preserved');
}finally{
 rmSync(workspace,{recursive:true,force:true});rmSync(state,{recursive:true,force:true});
}
