import test from 'node:test';
import assert from 'node:assert/strict';
import {ciStatus,deliveryStatus,statusIcon,vpsStatus,validRun} from '../angular/src/deployment-status.ts';
const sha='a'.repeat(40),other='b'.repeat(40),repo='Softdown-prog/Terrania',slug='terrania';
const run=(more={})=>({id:42,sha,status:'completed',conclusion:'success',...more});
test('CI approved is not VPS installed even for a green workflow',()=>{
  assert.deepEqual(ciStatus(run()),{label:'CI aprovado',tone:'success'});
  const status=vpsStatus(run(),repo,slug,{current:{state:'running',revision:other}},[]);
  assert.equal(status.tone,'warning');
  assert.match(status.label,/Outra revisão/);
});
test('VPS success requires exact SHA and running container',()=>{
  assert.equal(vpsStatus(run(),repo,slug,{current:{state:'running',revision:sha}},[]).tone,'success');
  assert.notEqual(vpsStatus(run(),repo,slug,{current:{state:'exited',revision:sha}},[]).tone,'success');
  assert.notEqual(vpsStatus(run(),repo,slug,null,[]).tone,'success');
  assert.notEqual(vpsStatus(run(),repo,null,{current:{state:'running',revision:sha}},[]).tone,'success');
});
test('incomplete and failed publications are not successful deployments',()=>{
  const history=[{repository:repo,slug,runId:42,phase:'completed'}];
  assert.equal(vpsStatus(run(),repo,slug,{current:{state:'exited',revision:other}},history).tone,'warning');
  history[0].phase='health';
  assert.equal(vpsStatus(run(),repo,slug,null,history).tone,'running');
  history[0].phase='attention';
  assert.equal(vpsStatus(run(),repo,slug,null,history).tone,'danger');
  history[0].phase='failed';
  assert.equal(vpsStatus(run(),repo,slug,null,history).tone,'danger');
});
test('unlinked projects and unavailable VPS remain unverified',()=>{
  assert.equal(vpsStatus(run(),repo,null,null,[]).label,'Sem vínculo com a VPS');
  assert.equal(vpsStatus(run(),repo,slug,null,[]).label,'VPS não verificada');
});
test('GitHub build failures and queue are kept separate from VPS status',()=>{
  assert.equal(ciStatus(run({status:'in_progress',conclusion:null})).tone,'running');
  assert.equal(ciStatus(run({conclusion:'failure'})).tone,'danger');
  assert.equal(ciStatus(run({conclusion:'cancelled'})).tone,'warning');
});
test('only coherent GitHub runs may be rendered',()=>{
  assert.equal(validRun(run()),true);
  assert.equal(validRun(run({id:0})),false);
  assert.equal(validRun(run({sha:'short'})),false);
  assert.equal(validRun(run({sha:other})),true);
});

test('pipeline differentiates GitHub completion from actual deployment',()=>{
  assert.equal(deliveryStatus(run({name:'Deploy VPS'}),vpsStatus(run(),repo,slug,null,[])).tone,'warning');
  assert.equal(deliveryStatus(run({name:'Deploy VPS'}),{tone:'success',label:'Installed'}).tone,'success');
  assert.equal(deliveryStatus(run({name:'Deploy VPS',conclusion:'failure'}),{tone:'muted',label:'Unknown'}).tone,'danger');
  assert.equal(deliveryStatus(run({name:'Build',status:'in_progress',conclusion:null}),{tone:'muted',label:'Unknown'}).tone,'running');
  assert.equal(statusIcon({tone:'success',label:'ok'}),'✓');
  assert.equal(statusIcon({tone:'danger',label:'error'}),'×');
});
