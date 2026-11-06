import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,symlink,rm,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {prepareMcpSnapshotContext,SNAPSHOT_PROJECTS} from './snapshot-context.mjs';
function git(cwd,...args){
 const result=spawnSync('git',args,{cwd,encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);
 return result.stdout.trim();
}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'mcp-source-snapshots-'));
 const workspace=join(root,'workspace'),parent=join(root,'output');
 await mkdir(workspace);await mkdir(parent);
 for(const entry of SNAPSHOT_PROJECTS){
  const source=join(workspace,entry.source);
  await mkdir(join(source,'src'),{recursive:true});
  await writeFile(join(source,'src','main.ts'),
   'export function project() { return '+JSON.stringify(entry.name)+'; }\n');
  await writeFile(join(source,'src','private.pem'),'PRIVATE_CERT_DATA');
  await writeFile(join(source,'.env'),'PASSWORD=do-not-copy');
  await writeFile(join(source,'src','binary.json'),Buffer.from([2,0,5]));
  await symlink('main.ts',join(source,'src','shortcut.ts'));
  if(entry.name==='Painel'){
   await mkdir(join(source,'tools','repo-mcp'),{recursive:true});
   for(const f of ['indexer.mjs','http-server.mjs','sac-report-router.mjs'])
    await writeFile(join(source,'tools','repo-mcp',f),
     '// trusted MCP fixture module\nexport const ok = true;\n');
  }
  git(source,'init','-q');
  git(source,'remote','add','origin','https://github.com/'+entry.repository+'.git');
  git(source,'add','src/main.ts','src/private.pem','.env','src/binary.json','src/shortcut.ts');
  if(entry.name==='Painel')git(source,'add','tools/repo-mcp');
  git(source,'-c','user.name=MCP Fixture','-c','user.email=fixture@example.test',
      'commit','-qm','test: fixture');
 }
 return {root,workspace,parent};
}
test('four real repository names yield isolated immutable SHAs and sanitized snapshots',async()=>{
 const f=await fixture();
 try{
  const output=join(f.parent,'context');
  const report=await prepareMcpSnapshotContext({workspace:f.workspace,output});
  assert.equal(report.repos.length,4);
  assert.deepEqual(report.repos.map(x=>x.name),SNAPSHOT_PROJECTS.map(x=>x.name));
  assert.equal(report.reports_included,false);
  assert.equal(report.broker_required,false);
  assert.equal(report.deploy_authorized,false);
  const registry=JSON.parse(await readFile(join(output,'registry.json'),'utf8'));
  assert.equal(registry.repos.length,4);
  for(const entry of report.repos){
   assert.match(entry.source_sha,/^[0-9a-f]{40}$/);
   assert.ok(entry.files>=1&&entry.bytes>0);
   assert.ok(entry.ignored>=4);
   const dest=join(output,'repos',entry.name,'src');
   assert.match(await readFile(join(dest,'main.ts'),'utf8'),/project/);
   assert.deepEqual(await readdir(dest),['main.ts']);
   const mode=(await stat(join(dest,'main.ts'))).mode&0o222;
   assert.equal(mode,0);
  }
  assert.equal(JSON.stringify(registry).includes('reportsPath'),false);
  assert.equal(JSON.stringify(report).includes('PASSWORD'),false);
  const imageModules=await readdir(join(output,'tools','repo-mcp'));
  assert.deepEqual(imageModules,['http-server.mjs','indexer.mjs','sac-report-router.mjs']);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('wrong GitHub origin fails closed and never leaves a partial output',async()=>{
 const f=await fixture();
 try{
  const source=join(f.workspace,'sources','Terrania');
  git(source,'remote','set-url','origin','https://github.com/attacker/wrong.git');
  const output=join(f.parent,'bad');
  await assert.rejects(prepareMcpSnapshotContext({
   workspace:f.workspace,output
  }),/rejected/);
  await assert.rejects(stat(output),{code:'ENOENT'});
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('modified tracked source is never disguised as a pinned commit',async()=>{
 const f=await fixture();
 try{
  await writeFile(join(f.workspace,'sources','Data_libray','src','main.ts'),'unsaved change');
  await assert.rejects(prepareMcpSnapshotContext({
   workspace:f.workspace,output:join(f.parent,'dirty')
  }),/rejected/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('snapshot output must be outside the repository checkout',async()=>{
 const f=await fixture();
 try{
  await assert.rejects(prepareMcpSnapshotContext({
   workspace:f.workspace,output:join(f.workspace,'unsafe')
  }),/rejected/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
