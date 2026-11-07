import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validPrompt,projects,createBridge} from './bridge.mjs';
test('isolates project folders from symlinks',()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-test-'));
 try{mkdirSync(join(root,'Painel'));mkdirSync(join(root,'.secret'));
  symlinkSync('/etc',join(root,'outside'));
  assert.deepEqual(projects(root),['Painel']);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('validates prompts and protects bridge secret',()=>{
 assert.equal(validPrompt('Corrija o compilador'),true);
 for(const s of ['', ' ', 'a'.repeat(4001), '\u0000', null])assert.equal(validPrompt(s),false);
 assert.throws(()=>createBridge({secret:'short',workspace:'/tmp',stateDir:'/tmp'}));
});
