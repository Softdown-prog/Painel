import test from 'node:test';
import assert from 'node:assert/strict';
import {canCreateApp,canOperate,diskMb,validAppDraft,validAppSlug,validSnapshot} from '../angular/src/apps-policy.ts';
const app={slug:'minha-loja',name:'softload-app-minha-loja',image:'example:1',
  state:'created',status:'Created',ramMb:256,cpuCores:0.5,diskUsedBytes:null,idleMinutes:0};
const data={enabled:true,allowedImages:['example:1'],maxApps:8,
  ramChoices:[128,256,512,768,1024],cpuChoices:[0.25,0.5,1,2],idleChoices:[0,15,30,60,120,240],
  applications:[app]};
test('accepts only the existing GET /apps list contract',()=>{
  assert.equal(validSnapshot(data),true);
  assert.equal(validSnapshot({...data,applications:[{slug:'../host'}]}),false);
  assert.equal(validSnapshot({...data,applications:'fake'}),false);
});
test('new apps require a safe slug, allowlisted image and resource quotas',()=>{
  assert.equal(canCreateApp(data,'nova-loja','example:1',256,0.5),true);
  for(const slug of ['../host','UPPER','x','-x','a'.repeat(41),'minha-loja'])
    assert.equal(canCreateApp(data,slug,'example:1',256,0.5),false);
  assert.equal(canCreateApp(data,'nova-loja','unapproved:latest',256,0.5),false);
  assert.equal(canCreateApp(data,'nova-loja','example:1',4096,0.5),false);
  assert.equal(canCreateApp({...data,enabled:false},'nova-loja','example:1',256,0.5),false);
  assert.equal(canCreateApp({...data,maxApps:1},'nova-loja','example:1',256,0.5),false);
});
test('all lifecycle operations remain restricted to managed apps in the API response',()=>{
  assert.equal(canOperate(data,app,'start'),true);
  assert.equal(canOperate(data,app,'stop'),false);
  assert.equal(canOperate(data,app,'restart'),false);
  assert.equal(canOperate(data,app,'remove'),true);
  const running={...app,state:'running'};
  assert.equal(canOperate({...data,applications:[running]},running,'stop'),true);
  assert.equal(canOperate({...data,applications:[running]},running,'restart'),true);
  assert.equal(canOperate({...data,applications:[running]},running,'remove'),false);
  assert.equal(canOperate(data,{...app,slug:'external'},'start'),false);
  assert.equal(canOperate({...data,enabled:false},app,'start'),false);
});
test('settings and disk formats are based on API values, never invented usage',()=>{
  assert.equal(validAppDraft(data,{ramMb:512,cpuCores:1,idleMinutes:30}),true);
  assert.equal(validAppDraft(data,{ramMb:2048,cpuCores:1,idleMinutes:30}),false);
  assert.equal(validAppDraft(data,{ramMb:512,cpuCores:1,idleMinutes:999}),false);
  assert.equal(diskMb(null),'Não informado');
  assert.equal(diskMb(1048576),'1,0 MB');
  assert.equal(validAppSlug('loja-1'),true);
});
