import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
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
  assert.deepEqual(paths, [
    '/containers/softload-vps-app-1/json',
    '/containers/softload-vps-agent-1/json'
  ]);
  assert.deepEqual(Object.keys(runtime.services), ['app', 'agent']);
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

test('deploy history frontend never treats configured .env SHA alone as active',()=>{
  const source=readFileSync(new URL('../script.js',import.meta.url),'utf8');
  const start=source.indexOf('const deployStatusLabels = Object.freeze(');
  const end=source.indexOf('function renderDeployRuntime(',start);
  assert.ok(start>0&&end>start);
  const { deployState, deployLabel }=runInNewContext(source.slice(start,end)+';({deployState,deployLabel})');
  const recorded={app:{status:'unconfirmed',revision:null},configuredSha:current};
  assert.equal(deployState(run(current),recorded),'unconfirmed');
  assert.match(deployLabel(run(current),recorded),/NÃO CONFIRMADA/);
  const verified={app:{status:'verified',revision:current},configuredSha:old};
  assert.equal(deployState(run(current),verified),'active');
  assert.equal(deployState(run(old),verified),'superseded');
  assert.equal(deployState(run(current,'failure'),verified),'failed');
});
test('VPS API image contains module needed by the deployment-status endpoint',()=>{
  const dockerfile=readFileSync(new URL('Dockerfile',import.meta.url),'utf8');
  assert.match(dockerfile,/COPY .*deploy-verification\.mjs/);
});

test('public HTTPS/Docker disagreement is visible but never counted as successful publication',()=>{
  const runtime={app:{status:'verified',revision:current}};
  const matching={status:'matched',revision:current,comparedTo:current};
  const different={status:'different',revision:old,comparedTo:current};
  assert.equal(runDeploymentStatus(run(current),runtime,matching),'published');
  assert.equal(runDeploymentStatus(run(current),runtime,different),'public-mismatch');
  assert.equal(runDeploymentStatus(run(current),runtime,{status:'unavailable'}),'active');
  assert.equal(runDeploymentStatus(run(old),runtime,matching),'superseded');
  assert.equal(runDeploymentStatus(run(current,'failure'),runtime,matching),'failed');
  const source=readFileSync(new URL('../script.js',import.meta.url),'utf8');
  const start=source.indexOf('const deployStatusLabels = Object.freeze(');
  const end=source.indexOf('function renderDeployRuntime(',start);
  const {deployState,deployLabel}=runInNewContext(source.slice(start,end)+';({deployState,deployLabel})');
  assert.equal(deployState(run(current),runtime,matching),'published');
  assert.equal(deployState(run(current),runtime,different),'public-mismatch');
  assert.match(deployLabel(run(current),runtime,different),/SITE DIVERGENTE/);
  assert.equal(deployState(run(current),runtime,{status:'unavailable'}),'active');
});
test('production API and image include public HTTPS verification',()=>{
  const dockerfile=readFileSync(new URL('Dockerfile',import.meta.url),'utf8');
  const api=readFileSync(new URL('api.mjs',import.meta.url),'utf8');
  assert.ok(dockerfile.includes('deploy-public-health.mjs'));
  assert.ok(api.includes('cachedPublicHealth(runtime.app?.revision)'));
  assert.ok(api.includes('runDeploymentStatus(run, runtime, publicHealth)'));
});
