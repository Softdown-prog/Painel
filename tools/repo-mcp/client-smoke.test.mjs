import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMcpHttpServer} from './http-server.mjs';
import {verifyClient} from './client-smoke.mjs';

test('real MCP client runs initialize, tools/list, repo queries and negative security checks',async()=>{
 const root=await mkdtemp(join(tmpdir(),'code-mcp-client-'));
 const repo=join(root,'repos','Painel'),secret=join(root,'token'),registry=join(root,'registry.json');
 let app;
 try {
  await mkdir(repo,{recursive:true});
  await writeFile(join(repo,'executor.ts'),'export function managedExecutor() {}');
  await writeFile(secret,'a-temporary-mcp-test-token-with-safe-length');
  await writeFile(registry,JSON.stringify({repos:[{name:'Painel',path:repo}]}));
  app=await createMcpHttpServer({registryFile:registry,tokenFile:secret,repoRoot:join(root,'repos'),port:0});
  const address=await app.start();
  const result=await verifyClient({endpoint:'http://127.0.0.1:'+address.port+'/mcp',tokenFile:secret});
  assert.equal(result.ok,true);
  assert.equal(result.repos,1);
  assert.equal(result.indexedFiles,1);
  assert.equal(result.verifiedAuth,true);
  assert.equal(result.verifiedOrigin,true);
  await assert.rejects(verifyClient({endpoint:'http://example.com/mcp',tokenFile:secret}),/HTTPS/);
 }finally{
  if(app)await app.close();
  await rm(root,{recursive:true,force:true});
 }
});
