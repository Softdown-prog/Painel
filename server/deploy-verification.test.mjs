import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectDeployedServices, revisionFromImage, runDeploymentStatus } from './deploy-verification.mjs';

const current = 'a'.repeat(40);
const old = 'b'.repeat(40);
function fakeDocker(records = {}) {
  const paths=[];
  const docker=async path=>{
    paths.push(path);
    const id=path.split('/')[2];
    const entry=records[id];
    if (!entry) return {status:404,buffer:Buffer.from('{}')};
    if (entry === 'error') throw Error('executor unavailable');
    if (entry === 'forbidden') return {status:403,buffer:Buffer.from('{}')};
    return {status:200,buffer:Buffer.from(JSON.stringify(entry))};
  };
  return {docker,paths};
}
function instance(name, image, running = true) {
  return {Name:'/'+name, Config:{Image:image, Env:['SECRET_TOKEN=must-not-leak']},
    State:{Running:running,Status:running?'running':'exited'}};
}
function run(sha=current, conclusion='success',status='completed') {
  return {sha,conclusion,status};
}
test('running app Docker image confirms deployment, not the environment variable',async()=>{
  const {docker,paths}=fakeDocker({
    'softload-vps-app-1': instance('softload-vps-app-1','softload-app:'+current),
    'softload-vps-agent-1': instance('softload-vps-agent-1','softload-agent:'+old),
    'softload-vps-sandbox-1': instance('softload-vps-sandbox-1','softload-sandbox:'+old),
    'softload-vps-embeddings-1': instance('softload-vps-embeddings-1','softload-embeddings:'+old)
  });
  const runtime=await inspectDeployedServices(docker,old);
  assert.deepEqual(runtime.app,{status:'verified',running:true,revision:current,image:'softload-app:'+current});
  assert.equal(runtime.configuredSha,old);
  assert.equal(runtime.configuredMatchesRunning,false);
  assert.equal(runDeploymentStatus(run(current),runtime),'active');
  assert.equal(runDeploymentStatus(run(old),runtime),'superseded');
  assert.equal(runtime.services.agent.revision,old,'Other services may legitimately retain older images');
  assert.equal(paths.length,4);
  assert.ok(paths.every(p=>p.endsWith('/json')));
  assert.ok(!JSON.stringify(runtime).includes('SECRET_TOKEN'));
});
test('unavailable, stopped, wrong-name and ambiguous images never falsely confirm active release',async()=>{
  const scenarios=[
    instance('softload-vps-app-1','softload-app:'+current,false),
    instance('impostor','softload-app:'+current),
    instance('softload-vps-app-1','softload-app:latest'),
    instance('softload-vps-app-1','sha256:'+old.repeat(2).slice(0,64)),
    'error','forbidden'
  ];
  for(const scenario of scenarios){
    const runtime=await inspectDeployedServices(fakeDocker({'softload-vps-app-1':scenario}).docker,current);
    assert.notEqual(runtime.app.status,'verified',String(scenario));
    assert.equal(runDeploymentStatus(run(current),runtime),'unconfirmed');
  }
});
test('labels require real successful completed workflow before active can be displayed',async()=>{
  const runtime=await inspectDeployedServices(fakeDocker({
    'softload-vps-app-1':instance('softload-vps-app-1','softload-app:'+current)
  }).docker,current);
  assert.equal(runDeploymentStatus(run(current,'failure','completed'),runtime),'failed');
  assert.equal(runDeploymentStatus(run(current,null,'in_progress'),runtime),'building');
  assert.equal(runDeploymentStatus(run(current,null,'queued'),runtime),'queued');
  assert.equal(runDeploymentStatus(run(current,'cancelled','completed'),runtime),'cancelled');
  assert.equal(runDeploymentStatus(run(current,'success','completed'),runtime),'active');
  assert.equal(runDeploymentStatus(run(old,'success','completed'),runtime),'superseded');
});
test('wrong repository, partial hashes and digest-only references are not mistaken for actual image revisions',()=>{
  assert.equal(revisionFromImage('attacker/app:'+current,'app'),null);
  assert.equal(revisionFromImage('softload-app:'+current.slice(0,12),'app'),null);
  assert.equal(revisionFromImage('softload-app@sha256:'+old.repeat(2).slice(0,64),'app'),null);
  assert.equal(revisionFromImage('ghcr.io/softdown-prog/softload-app:'+current,'app'),current);
  assert.equal(revisionFromImage('softload-agent:'+current,'app'),null);
});
