import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMcpHttpServer} from './http-server.mjs';

test('MCP HTTP requires token, rejects browser origins and selects only listed repositories', async()=>{
 const root=await mkdtemp(join(tmpdir(),'mcp-http-'));
 const repos=join(root,'repos'),a=join(repos,'Painel'),b=join(repos,'Terrania');
 await mkdir(a,{recursive:true});await mkdir(b,{recursive:true});
 await writeFile(join(a,'one.ts'),'export function sample() { return true; }\n');
 await writeFile(join(b,'two.ts'),'export class Ranger {}\n');
 const token='temporary-mcp-test-token-at-least-32-chars';
 const registry=join(root,'registry.json'),secret=join(root,'token');
 await writeFile(secret,token);
 await writeFile(registry,JSON.stringify({repos:[{name:'Painel',path:a},{name:'Terrania',path:b}]}));
 let app;
 try{
  app=await createMcpHttpServer({registryFile:registry,tokenFile:secret,repoRoot:repos,port:0});
  const address=await app.start(),url='http://127.0.0.1:'+address.port;
  const health=await fetch(url+'/health');
  assert.equal(health.status,200);
  assert.equal((await fetch(url+'/mcp',{method:'GET'})).status,401);
  assert.equal((await fetch(url+'/mcp',{headers:{authorization:'Bearer incorrect'},method:'GET'})).status,401);
  const headers={'authorization':'Bearer '+token,'accept':'application/json, text/event-stream','content-type':'application/json'};
  assert.equal((await fetch(url+'/mcp',{method:'POST',headers:{...headers,origin:'https://attacker.test'},body:'{}'})).status,403);
  const call=(id,method,params)=>fetch(url+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
  const init=await call(1,'initialize',{protocolVersion:'2025-11-25'});
  assert.equal((await init.json()).result.protocolVersion,'2025-11-25');
  const listed=await (await call(2,'tools/call',{name:'repo_list',arguments:{}})).json();
  assert.deepEqual(JSON.parse(listed.result.content[0].text),['Painel','Terrania']);
  const first=await (await call(3,'tools/call',{name:'repo_find_symbols',arguments:{repo:'Painel',query:'sample'}})).json();
  assert.equal(JSON.parse(first.result.content[0].text)[0].path,'one.ts');
  const second=await (await call(4,'tools/call',{name:'repo_find_symbols',arguments:{repo:'Terrania',query:'Ranger'}})).json();
  assert.equal(JSON.parse(second.result.content[0].text)[0].path,'two.ts');
  const cross=await (await call(5,'tools/call',{name:'repo_search_text',arguments:{repo:'Painel',query:'Ranger'}})).json();
  assert.deepEqual(JSON.parse(cross.result.content[0].text).matches,[]);
  const other=await (await call(6,'tools/call',{name:'repo_stats',arguments:{repo:'Unknown'}})).json();
  assert.equal(other.result.isError,true);
  const unsafe=await (await call(7,'tools/call',{name:'repo_read_file',arguments:{repo:'Painel',path:'../Terrania/two.ts'}})).json();
  assert.equal(unsafe.result.isError,true);
  const before=await (await call(8,'tools/list',{})).json();
  assert.equal(before.result.tools.some(x=>x.name==='repo_replace_text'),false);
  const notify=await fetch(url+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
  assert.equal(notify.status,202);
  assert.equal((await fetch(url+'/mcp',{method:'GET',headers})).status,405);
 }finally{if(app)await app.close();await rm(root,{recursive:true,force:true});}
});
test('invalid configuration blocks container bootstrap',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mcp-http-invalid-'));
 const repos=join(root,'repos');await mkdir(repos);
 const token=join(root,'token'),registry=join(root,'registry');
 await writeFile(token,'a-good-token-that-is-long-enough-for-test');
 await writeFile(registry,JSON.stringify({repos:[{name:'bad',path:'/etc'}]}));
 try{await assert.rejects(createMcpHttpServer({registryFile:registry,tokenFile:token,repoRoot:repos}),/registry/);}
 finally{await rm(root,{recursive:true,force:true});}
});
