import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
import {confirmedTerminalCommand,validTerminalCommand,MAX_TERMINAL_COMMAND_BYTES} from '../angular/src/terminal-command.ts';
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

test('SSH terminal requires the exact confirmed command, including multiline whitespace',()=>{
 const reviewed='  echo revisão\n\techo fim\n';
 assert.equal(validTerminalCommand(reviewed),true);
 assert.equal(confirmedTerminalCommand(reviewed,reviewed,true,true,true),true);
 for(const candidate of ['echo revisão\n\techo fim\n',reviewed+' ',reviewed+'; rm -rf /tmp/x']){
   assert.equal(confirmedTerminalCommand(reviewed,candidate,true,true,true),false);
 }
 assert.equal(confirmedTerminalCommand(null,reviewed,true,true,true),false);
 assert.equal(confirmedTerminalCommand(reviewed,reviewed,true,true,false),false);
 assert.equal(confirmedTerminalCommand(reviewed,reviewed,false,true,true),false);
 assert.equal(confirmedTerminalCommand(reviewed,reviewed,true,false,true),false);
 for(const bad of ['','   ','echo ok\u0000','echo ok\u001b','x'.repeat(MAX_TERMINAL_COMMAND_BYTES+1)]){
   assert.equal(validTerminalCommand(bad),false);
 }
 const src=read('angular/src/terminal.component.ts');
 const template=read('angular/src/terminal.component.html');
 assert.match(src,/this\.preparedCommand=value;/);
 assert.match(src,/confirmedTerminalCommand\(this\.preparedCommand,value/);
 assert.match(src,/this\.cancel\(\);\s*this\.busy\.set\(true\)/);
 assert.match(src,/ngOnDestroy\(\):void/);
 assert.match(template,/\(input\)="updateCommand\(\$event\)"/);
 assert.doesNotMatch(src+template,/localStorage|sessionStorage/);
});
