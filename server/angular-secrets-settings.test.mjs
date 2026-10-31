import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const get=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('secrets and settings are native Angular screens and deep links',()=>{
  const app=get('angular/src/app.component.ts'),html=get('angular/src/app.component.html'),root=get('index.html');
  for(const page of ['secrets','settings']){
    assert.ok(app.includes("hash === '"+page+"'"));
    assert.ok(html.includes("selectPage('"+page+"')"));
    assert.ok(root.includes(page+":'"+page+"'"));
    assert.ok(root.includes("fragment === '"+page+"'"));
  }
  assert.match(html,/<panel-secrets\s*\/>/);assert.match(html,/<panel-settings \(signedOut\)="onPasswordChanged\(\)"\s*\/>/);
});
test('secret mutations require admin reauthentication, typed confirmation and never reveal values',()=>{
  const src=get('angular/src/secrets.component.ts'),html=get('angular/src/secrets.component.html');
  assert.match(src,/\/secrets/);assert.match(src,/this\.typedName\(\)!==action\.name/);
  assert.match(src,/value:this\.value\(\),password:this\.password\(\)/);
  assert.match(src,/this\.clearSensitive\(\);this\.working\.set\(false\)/);
  assert.match(src,/ngOnDestroy\(\):void\{this\.clearSensitive\(\);\}/);
  assert.match(html,/Confirmar exclusão/);assert.match(html,/Confirmar gravação/);
  assert.doesNotMatch(src+html,/localStorage|sessionStorage|console\.log|Bearer /);
});
test('admin setup is one-time and password rotation requires re-login',()=>{
  const app=get('angular/src/app.component.ts'),html=get('angular/src/app.component.html'),
    settings=get('angular/src/settings.component.ts');
  assert.match(app,/setupToken:this\.setupToken\(\)\.trim\(\)/);
  assert.match(app,/\/setup','POST'/);assert.match(app,/this\.cancelSetup\(\)/);
  assert.match(html,/Confirmar configuração inicial/);
  assert.match(settings,/\/api\/password/);
  assert.match(settings,/this\.confirmation\(\)!=='ALTERAR SENHA'/);
  assert.match(settings,/this\.signedOut\.emit\(\)/);
  assert.doesNotMatch(settings,/localStorage|sessionStorage|Bearer /);
});
test('secret and settings forms have full-width mobile layout and accessible controls',()=>{
 for(const p of ['angular/src/secrets.component.css','angular/src/settings.component.css']){
   const css=get(p);
   assert.match(css,/@media\(max-width:480px\)/);
   assert.match(css,/min-height:44px/);
 }
 assert.match(get('angular/src/secrets.component.html'),/role="alert"/);
 assert.match(get('angular/src/settings.component.html'),/role="group"/);
});
