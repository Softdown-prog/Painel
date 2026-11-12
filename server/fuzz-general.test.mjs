import test from 'node:test';
import assert from 'node:assert/strict';
import {identifier, confirmation, editRow} from './database-admin.ts';
import {validLimits, validCreate, authorize} from './executor-policy.ts';
import {managedContainerSpec} from './apps.ts';
import {validJobCommand} from './terminal-jobs.ts';
import {validSha} from './releases.ts';
import {initialInsertValues} from '../angular/src/database-row-values.ts';
import {validateArchiveListing} from '../agents/workspaces.mjs';

// Deterministic, offline property/mutation fuzz. Replay with FUZZ_SEED and FUZZ_CASES.
const SEED = (Number(process.env.FUZZ_SEED ?? 20261110) >>> 0) || 1;
const CASES = Math.min(10000, Math.max(1, Number(process.env.FUZZ_CASES ?? 2000) | 0));
let state=SEED;
function next(){state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;}
function pick(items){return items[next()%items.length];}
function randomText(length,alphabet='abcXYZ0123456789_" /-'){
 let result='';for(let i=0;i<length;i++)result+=alphabet[next()%alphabet.length];
 return result;
}
const context=(surface,i)=>surface+' seed='+SEED+' case='+i;
console.log('General fuzz replay: FUZZ_SEED='+SEED+' FUZZ_CASES='+CASES);

test('fuzz identifier quoting and invalid byte/control boundaries',()=>{
 for(let i=0;i<CASES;i++){
   const value=randomText(1+next()%48);
   assert.equal(identifier(value),'"'+value.replaceAll('"','""')+'"',context('identifier',i));
   const invalid=pick([value+'\0','x\n'+value,value+'\x7f','A'.repeat(64+next()%80)]);
   assert.throws(()=>identifier(invalid),undefined,context('invalid identifier',i));
 }
 for(const value of [null,undefined,1,{},[],false,''])assert.throws(()=>identifier(value));
});

test('fuzz confirmed database target and exact SHA forms',()=>{
 for(let i=0;i<CASES;i++){
   const value=randomText(1+next()%24,'abcd0123_-');
   confirmation({confirmation:value},value);
   assert.throws(()=>confirmation({confirmation:value+'x'},value),undefined,context('confirmation',i));
   const good=randomText(40,'0123456789abcdef');
   assert.equal(validSha(good),true,context('sha valid',i));
   assert.equal(validSha(good.slice(0,39)+'G'),false,context('sha invalid',i));
 }
});

test('fuzz PostgreSQL inserts parameterize attacker-controlled values and preserve defaults',async()=>{
 for(let i=0;i<CASES;i++){
   const value=randomText(next()%140) + "'; DROP TABLE users; --";
   const columns=[
     {name:'ref',generated:false,primary:true,nullable:false,defaulted:false},
     {name:'created_at',generated:false,primary:false,nullable:false,defaulted:true},
     {name:'id',generated:true,primary:false,nullable:false,defaulted:false}
   ];
   const calls=[];
   const client={async query(sql,values){
     calls.push({sql,values});
     return sql.startsWith('SELECT a.attname')?{rows:columns}:{rowCount:1,rows:[]};
   }};
   await editRow(client,'public','items',{action:'insert',values:{ref:value}});
   assert.equal(calls.length,2,context('insert queries',i));
   assert.equal(calls[1].values[0],value,context('bound insert',i));
   assert.ok(!calls[1].sql.includes(value),context('SQL injection',i));
   assert.ok(!calls[1].sql.includes('created_at'),context('preserve default',i));
 }
});

test('fuzz Angular insert form respects generated/defaulted/nullability and unusual column names',()=>{
 const names=['id','ref','__proto__','constructor','hasOwnProperty','created_at','nome'];
 for(let i=0;i<CASES;i++){
   const columns=names.map(name=>({name,generated:next()%2===0,
     defaulted:next()%2===0,nullable:next()%2===0}));
   const got=initialInsertValues(columns);
   for(const col of columns){
     const expected=!col.generated&&!col.defaulted&&!col.nullable;
     assert.equal(Object.hasOwn(got,col.name),expected,context('insert field '+col.name,i));
     if(expected)assert.equal(got[col.name],null);
   }
 }
});

test('fuzz executor resource limits and reject extraneous/privileged Docker create fields',()=>{
 const rams=[128,256,512,768,1024].map(n=>n*1048576);
 const cpus=[250000000,500000000,1000000000,2000000000];
 const modifiers=[
   s=>({...s,Privileged:true}),
   s=>({...s,User:'0:0'}),
   s=>({...s,HostConfig:{...s.HostConfig,Binds:['/:/mnt']}}),
   s=>({...s,HostConfig:{...s.HostConfig,NetworkMode:'host'}}),
   s=>({...s,HostConfig:{...s.HostConfig,MemorySwap:0}}),
   s=>({...s,HostConfig:{...s.HostConfig,CapDrop:[]}}),
   s=>({...s,HostConfig:{...s.HostConfig,SecurityOpt:['seccomp=unconfined']}}),
   s=>({...s,HostConfig:{...s.HostConfig,PublishAllPorts:true}}),
   s=>({...s,Labels:{...s.Labels,'com.softload.panel.slug':'foreign'}}),
   s=>({...s,Image:'attacker:latest'})
 ];
 for(let i=0;i<CASES;i++){
   const memory=pick(rams),cpu=pick(cpus);
   const limits={Memory:memory,MemorySwap:memory*2,NanoCpus:cpu};
   assert.equal(validLimits(limits),true,context('valid limits',i));
   assert.equal(validLimits(pick([
     {...limits,MemorySwap:memory*2+1},{...limits,Memory:'512'},
     {...limits,NanoCpus:0},{...limits,Privileged:true},
     {...limits,Memory:-1},{...limits,MemorySwap:Infinity}
   ])),false,context('limits mutation',i));
   const safe=managedContainerSpec('fuzz','test:1',{},{
     ramMb:memory/1048576,cpuCores:cpu/1000000000
   });
   assert.equal(validCreate('softload-app-fuzz',safe,['test:1']),true,context('valid Docker create',i));
   assert.equal(validCreate('softload-app-fuzz',pick(modifiers)(safe),['test:1']),false,context('mutated Docker create',i));
 }
});

test('fuzz Docker policy fails closed on unexpected endpoints and duplicate query values',async()=>{
 const id='softload-app-fuzz';
 const inspect=async target=>target===id?{Id:'f'.repeat(32),Name:'/'+id,
   Config:{Labels:{'com.softload.panel.managed':'true','com.softload.panel.slug':'fuzz'}},
   State:{Running:true,Status:'running'}}:null;
 const check=(method,url)=>authorize({method,url,inspect,legacyEnabled:false});
 const duplicate=[
   ['GET','/v1.45/containers/json?all=1&size=1&size=0'],
   ['GET','/v1.45/containers/json?all=1&all=0'],
   ['POST','/v1.45/containers/'+id+'/restart?t=10&t=999'],
   ['GET','/v1.45/containers/'+id+'/logs?tail=30&tail=900']
 ];
 for(const [method,url] of duplicate){
   assert.equal((await check(method,url)).ok,false,'duplicate query parameter '+url);
 }
 for(let i=0;i<CASES;i++){
   const token=randomText(1+next()%25,'abcdefghijklmnopqrstuvwxyz0123456789_-');
   const method=pick(['GET','POST','DELETE','PUT','PATCH']);
   const url=pick([
     '/v1.45/containers/'+id+'/exec?'+token+'=1',
     '/v1.45/volumes/'+token,
     '/v1.45/containers/'+token+'/archive',
     '/v1.45/networks/'+token,
     '/v1.45/containers/'+id+'/json?'+token+'=1',
     '/v1.45/containers/json?all=1&unknown='+token
   ]);
   const result=await check(method,url);
   assert.equal(result.ok,false,context('unauthorized Docker operation '+method+' '+url,i));
 }
});

test('fuzz bounded SSH command validation without opening any SSH connection',()=>{
 for(let i=0;i<CASES;i++){
   const value=randomText(1+next()%90,'abcZ09-_; \n\t');
   assert.equal(validJobCommand({command:value}),value.trim().length>0,context('valid command',i));
   assert.equal(validJobCommand({command:value+'\0'}),false,context('NUL',i));
   assert.equal(validJobCommand({command:value,unknown:true}),false,context('extra field',i));
 }
 for(const bad of [null,undefined,0,3,false,[],['ls'],{},'ls',{command:0},{command:''},{command:'\x1b[31m'}]){
   assert.equal(validJobCommand(bad),false,'unexpected request body '+String(bad));
 }
 assert.equal(validJobCommand({command:'a'.repeat(4*1024*1024)}),true);
 assert.equal(validJobCommand({command:'a'.repeat(4*1024*1024+1)}),false);
});

test('fuzz archive import path traversal and file-type limits without extraction',()=>{
 const row=(path,size)=>'-rw-r--r-- 0/0 '+size+' 2026-11-10 00:00 '+path+'\n';
 for(let i=0;i<CASES;i++){
   const leaf=randomText(1+next()%28,'abcdefghijklmnopqrstuvwxyz0123456789-_.');
   // Dots in the leaf are okay unless they form a forbidden component.
   const safe=['.','..','.git'].includes(leaf.toLowerCase()) ? 'safe'+i : leaf;
   const path='repo/'+safe;
   const size=next()%4096;
   assert.deepEqual(validateArchiveListing(path+'\n',row(path,size)),{count:1,bytes:size},context('valid archive',i));
   const bad=pick(['repo/../'+safe,'repo/./'+safe,'repo//'+safe,
     'repo/.git/'+safe,'repo/.GIT/'+safe,'/repo/'+safe,'repo/'+safe+'\\evil','repo/'+safe+'\0']);
   assert.throws(()=>validateArchiveListing(bad+'\n',row(bad,size)),undefined,context('traversal',i));
 }
 assert.throws(()=>validateArchiveListing('repo/file\n','lrwxrwxrwx 0/0 1 2026-11-10 00:00 repo/file -> /etc/passwd\n'));
});
