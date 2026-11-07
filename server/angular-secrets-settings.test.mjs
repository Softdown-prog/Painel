import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {currentSecretIntent} from '../angular/src/secrets-confirmation.ts';
const get=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('secrets and settings are native Angular screens and deep links',()=>{
  const app=get('angular/src/app.component.ts'),html=get('angular/src/app.component.html'),root=get('index.html');
  for(const page of ['secrets','settings']){
    assert.ok(app.includes("hash === '"+page+"'"));
    assert.ok(html.includes("selectPage('"+page+"')"));
    assert.ok(root.includes("'"+page+"'"));
  }
  assert.match(html,/<panel-secrets\s*\/>/);assert.match(html,/<panel-settings \(signedOut\)="onPasswordChanged\(\)"\s*\/>/);
});
test('secret mutations require admin reauthentication, typed confirmation and never reveal values',()=>{
  const src=get('angular/src/secrets.component.ts'),html=get('angular/src/secrets.component.html');
  assert.match(src,/\/secrets/);assert.match(src,/this\.typedName\(\)!==action\.name/);
  assert.match(src,/value:this\.value\(\),password:this\.password\(\)/);
  assert.match(src,/this\.clearSensitive\(\);this\.working\.set\(false\)/);
  assert.match(src,/ngOnDestroy\(\):void\{[\s\S]*?this\.clearSensitive\(\);/);
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

test('secret confirmations are bound to inventory and edit generation without duplicating values',()=>{
 const entries=[{name:'cloudflare-dns'},{name:'postgres-cert'}];
 const save={kind:'save',name:'cloudflare-dns',replacement:true,revision:3};
 const create={kind:'save',name:'new-service',replacement:false,revision:3};
 const del={kind:'delete',name:'postgres-cert',replacement:false,revision:3};
 assert.equal(currentSecretIntent(save,3,entries,'cloudflare-dns'),true);
 assert.equal(currentSecretIntent(save,4,entries,'cloudflare-dns'),false);
 assert.equal(currentSecretIntent(save,3,entries,'postgres-cert'),false);
 assert.equal(currentSecretIntent(save,3,[], 'cloudflare-dns'),false);
 assert.equal(currentSecretIntent(create,3,entries,'new-service'),true);
 assert.equal(currentSecretIntent(create,3,[...entries,{name:'new-service'}],'new-service'),false);
 assert.equal(currentSecretIntent(del,3,entries,''),true);
 assert.equal(currentSecretIntent(del,3,[],' '),false);
 assert.equal(currentSecretIntent(null,3,entries,''),false);
 const src=get('angular/src/secrets.component.ts');
 const html=get('angular/src/secrets.component.html');
 assert.match(src,/this\.revision\+\+/);
 assert.match(src,/currentSecretIntent\(action,this\.revision/);
 assert.match(src,/this\.invalidatePrepared\(\);\s*this\.info\.set\(data\)/);
 assert.match(src,/if\(!this\.destroyed\)await this\.refresh\(\)/);
 for(const event of ['editName','editLabel','editCategory','editValue']){
   assert.match(html,new RegExp('\\('+ (event==='editCategory'?'change':'input') +'\\)="'+event+'\\('));
 }
 assert.doesNotMatch(get('angular/src/secrets-confirmation.ts'),/value:|password:|localStorage|sessionStorage/);
});
