import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {RepoNavigator} from './indexer.mjs';
const sha=data=>createHash('sha256').update(data).digest('hex');
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'painel-repo-mcp-'));
 await mkdir(join(root,'src'),{recursive:true});
 await mkdir(join(root,'.github','workflows'),{recursive:true});
 await mkdir(join(root,'node_modules'),{recursive:true});
 await writeFile(join(root,'src','alpha.ts'),"export function launch() { return 'ok'; }\nimport {helper} from './beta';\n");
 await writeFile(join(root,'src','beta.ts'),"export const helper = 42;\n");
 await writeFile(join(root,'src','foreign.pem'),'TOP-SECRET');
 await writeFile(join(root,'.env.production'),'TOKEN=private');
 await writeFile(join(root,'node_modules','ignored.ts'),'export function noop() {}');
 await writeFile(join(root,'.github','workflows','build.yml'),'name: Build\n');
 await symlink(join(root,'src','alpha.ts'),join(root,'src','linked.ts'));
 return root;
}
test('index includes files and symbols/imports, excluding secrets and symlinks',async()=>{
 const root=await fixture();
 try{
  const nav=new RepoNavigator(root),idx=await nav.buildIndex();
  assert.deepEqual(idx.files.map(f=>f.path),['.github/workflows/build.yml','src/alpha.ts','src/beta.ts']);
  assert.equal(idx.summary.fileCount,3);
  assert.deepEqual((await nav.symbols({query:'launch'})).map(s=>s.path),['src/alpha.ts']);
  assert.equal((await nav.dependencies({path:'src/alpha.ts'})).localReferences[0].target,'src/beta.ts');
  assert.deepEqual((await nav.dependencies({path:'src/beta.ts'})).incoming,['src/alpha.ts']);
  assert.equal((await nav.search({query:'launch'})).matches[0].line,1);
  const reading=await nav.read({path:'src/alpha.ts',startLine:1,endLine:2});
  assert.match(reading.text,/^\s*1 export function/);
  assert.match(reading.sha256,/^[a-f0-9]{64}$/);
  assert.equal((await readFile(join(root,'.repo-mcp','index.json'),'utf8')).includes('TOP-SECRET'),false);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('safe paths block traversal, symlinks and sensitive files',async()=>{
 const root=await fixture();
 try{
  const nav=new RepoNavigator(root);
  for(const path of ['../.env.production','/etc/passwd','src/../src/alpha.ts','src\\alpha.ts','.env.production','src/linked.ts','src/foreign.pem'])
   await assert.rejects(nav.read({path}));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('edits default to preview, require opt-in and compare file hashes',async()=>{
 const root=await fixture();
 try{
  const path='src/alpha.ts',full=join(root,path);
  const original=await readFile(full,'utf8'),expectedSha256=sha(original);
  const nav=new RepoNavigator(root);
  const args={path,expectedSha256,oldText:'launch',newText:'start'};
  const preview=await nav.replace(args);
  assert.equal(preview.changed,true);assert.equal(preview.dryRun,true);
  assert.equal(await readFile(full,'utf8'),original);
  await assert.rejects(nav.replace({...args,dryRun:false}),/Escrita desabilitada/);
  const writer=new RepoNavigator(root,{writable:true});
  await assert.rejects(writer.replace({...args,expectedSha256:'0'.repeat(64),dryRun:false}),/mudou/);
  const result=await writer.replace({...args,dryRun:false});
  assert.equal(result.dryRun,false);
  assert.ok((await readFile(full,'utf8')).includes('function start'));
  await assert.rejects(writer.replace({...args,dryRun:false}),/mudou/);
  await assert.rejects(writer.replace({path:'.github/workflows/build.yml',expectedSha256:sha('name: Build\n'),
    oldText:'Build',newText:'Attack',dryRun:false}),/não são permitidas/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('MCP stdio initialize, discover and call tools; cannot write with default settings',async()=>{
 const root=await fixture();
 const child=spawn(process.execPath,['tools/repo-mcp/server.mjs'],{
  cwd:new URL('../..',import.meta.url).pathname,
  env:{...process.env,REPO_MCP_ROOT:root,REPO_MCP_ALLOW_WRITE:'0'},stdio:['pipe','pipe','pipe']
 });
 let out='',stderr='';
 child.stdout.on('data',chunk=>{out+=chunk.toString();});
 child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
 const send=(id,method,params)=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
 const until=async n=>{
  for(let i=0;i<125;i++){
   const lines=out.trim().split('\n').filter(Boolean);
   if(lines.length>=n)return lines.map(s=>JSON.parse(s));
   await new Promise(r=>setTimeout(r,20));
  }
  throw Error('MCP did not answer: '+stderr);
 };
 try{
  send(1,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1.0'}});
  send(2,'tools/list',{});
  send(3,'tools/call',{name:'repo_find_symbols',arguments:{query:'launch'}});
  send(4,'tools/call',{name:'repo_replace_text',arguments:{
   path:'src/alpha.ts',expectedSha256:sha(await readFile(join(root,'src','alpha.ts'))),
   oldText:'launch',newText:'start',dryRun:false
  }});
  const results=await until(4),byId=id=>results.find(x=>x.id===id);
  assert.equal(byId(1).result.protocolVersion,'2025-11-25');
  assert.ok(byId(2).result.tools.some(x=>x.name==='repo_search_text'));
  assert.ok(byId(3).result.content[0].text.includes('launch'));
  assert.equal(byId(4).result.isError,true);
  assert.ok((await readFile(join(root,'src','alpha.ts'),'utf8')).includes('launch'));
 }finally{child.stdin.end();child.kill();await rm(root,{recursive:true,force:true});}
});
test('workflow read-only, index artifact, no deployment',async()=>{
 const raw=await readFile(new URL('../../.github/workflows/repo-mcp-index.yml',import.meta.url),'utf8');
 assert.match(raw,/permissions:\s*\n\s*contents: read/);
 assert.match(raw,/feat\/angular-complete-migration/);
 assert.doesNotMatch(raw,/contents: write|pull_request_target|deploy-vps|workflow_run|docker\.sock/);
 assert.match(raw,/upload-artifact@v4/);
});
