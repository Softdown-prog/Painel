import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('Angular migration stays isolated and cannot deploy on feature pushes',()=>{
 const ci=read('.github/workflows/ci.yml');
 const deploy=read('.github/workflows/deploy-pages.yml');
 const vps=read('.github/workflows/deploy-vps.yml');
 const web=read('.github/workflows/deploy-panel-web.yml');
 assert.match(ci,/feat\/angular-complete-migration/);
 for(const s of [deploy,vps,web]){
   assert.match(s,/branches:\s*\[main\]/);
   assert.doesNotMatch(s,/feat\/angular-complete-migration/);
 }
 assert.match(read('docs/ANGULAR-COMPLETE-MIGRATION.md'),/Não abrir PR, não fazer merge/);
});
test('Angular terminal uses only existing authenticated SSH endpoints and confirmation',()=>{
 const code=read('angular/src/terminal.component.ts');
 const html=read('angular/src/terminal.component.html');
 assert.match(code,/\/terminal\/ssh\/status/);
 assert.match(code,/\/terminal\/ssh\/exec/);
 assert.match(code,/this\.pending\(\)/);
 assert.match(html,/Confirmar execução/);
 assert.match(html,/\(click\)="execute\(\)"/);
 assert.match(code,/credentials:'same-origin'/);
 assert.doesNotMatch(code,/localStorage|sessionStorage|x-panel-edge-key/);
});
test('Revisions restrict cleanup to known API with explicit typing confirmation',()=>{
 const code=read('angular/src/revisions.component.ts');
 const html=read('angular/src/revisions.component.html');
 assert.match(code,/\/maintenance\/revisions\/cleanup/);
 assert.match(code,/LIMPAR_REVISOES_ANTIGAS/);
 assert.match(code,/confirmText\(\)!=='LIMPAR'/);
 assert.match(html,/Confirmar remoção/);
 assert.match(html,/\[disabled\]="working\(\)\|\|!r.enabled\|\|r.oldCount===0"/);
});
