// Real pinned app-server tests against synthetic files only. No model/auth/API.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createServer,connect} from 'node:net';
import {once} from 'node:events';
import {codexArguments,permissionName} from './bridge.mjs';

for(const p of ['/workspace/Geral','/workspace/Painel','/workspace/Other','/home/node/.codex','/state'])
 mkdirSync(p,{recursive:true});
writeFileSync('/workspace/Painel/input.txt','allowed-fixture');
writeFileSync('/workspace/Other/private.txt','other-fixture');
writeFileSync('/home/node/.codex/private-canary.txt','fake-credential-fixture');
writeFileSync('/state/private.txt','private-state-fixture');
assert.equal(readFileSync('/run/secrets/panel-agent-key','utf8'),'fake-bridge-key');
const listener=createServer(s=>s.end('fixture'));
listener.listen(23456,'127.0.0.1');await once(listener,'listening');
const reachable=connect(23456,'127.0.0.1');await once(reachable,'connect');reachable.end();
const proc=spawn('codex',codexArguments('/workspace',['Geral','Painel','Other']),
 {cwd:'/workspace/Painel',stdio:['pipe','pipe','pipe']});
let seq=0,stderr='';const pending=new Map();
proc.stderr.on('data',data=>{stderr=(stderr+data).slice(-3000);});
createInterface({input:proc.stdout}).on('line',line=>{
 const r=JSON.parse(line);if(!pending.has(r.id))return;
 const q=pending.get(r.id);pending.delete(r.id);clearTimeout(q.timer);
 r.error?q.reject(Error(JSON.stringify(r.error))):q.resolve(r.result);
});
function rpc(method,params){const id=++seq;return new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout: '+stderr));},25000);
 pending.set(id,{resolve,reject,timer});proc.stdin.write(JSON.stringify({id,method,params})+'\n');
});}
const command=(project,argv)=>rpc('command/exec',{command:argv,cwd:'/workspace/'+project,
 permissionProfile:permissionName(project),timeoutMs:10000,outputBytesCap:2048});
const results=[];
try{
 await rpc('initialize',{clientInfo:{name:'panel_sandbox_test',version:'1.0'},capabilities:{experimentalApi:true}});
 proc.stdin.write('{"method":"initialized","params":{}}\n');
 const allowed=await command('Painel',['cat','/workspace/Painel/input.txt']);
 assert.equal(allowed.exitCode,0);assert.match(allowed.stdout,/allowed-fixture/);results.push('project-read');
 const write=await command('Painel',['sh','-c','printf ok > /workspace/Painel/output.txt']);
 assert.equal(write.exitCode,0);assert.equal(readFileSync('/workspace/Painel/output.txt','utf8'),'ok');results.push('project-write');
 for(const [name,file] of [['other-project','/workspace/Other/private.txt'],
  ['credentials','/home/node/.codex/private-canary.txt'],['bridge-key','/run/secrets/panel-agent-key'],
  ['bridge-state','/state/private.txt']]){
  const denied=await command('Painel',['cat',file]);assert.notEqual(denied.exitCode,0,name);
  assert.doesNotMatch(denied.stdout,/other-fixture|fake-credential-fixture|fake-bridge-key|private-state-fixture/);
  results.push(name+'-denied');
 }
 const general=await command('Geral',['sh','-c','printf no > /workspace/Geral/forbidden.txt']);
 assert.notEqual(general.exitCode,0);assert.equal(existsSync('/workspace/Geral/forbidden.txt'),false);results.push('general-read-only');
 const cross=await command('Geral',['cat','/workspace/Painel/input.txt']);
 assert.notEqual(cross.exitCode,0);results.push('general-project-isolation');
 const network=await command('Painel',['node','-e',
  "const s=require('net').connect(23456,'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(7));setTimeout(()=>process.exit(8),1000)"]);
 assert.notEqual(network.exitCode,0);results.push('tool-network-denied');
 console.log(JSON.stringify({passed:true,checks:results,modelRequests:0}));
}catch(error){console.error(error.message);console.error(stderr);process.exitCode=1;}
finally{proc.kill('SIGTERM');listener.close();for(const q of pending.values())clearTimeout(q.timer);}
