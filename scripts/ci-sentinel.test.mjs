import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isFailure,clean,mark,rows,mergeRows,issueBody,scan,client} from './ci-sentinel.mjs';
const NOW=new Date('2026-11-08T14:00:00Z');
function run(id,{conclusion='failure',attempt=1,updated='2026-11-08T13:30:00Z'}={}){
  return {id,run_attempt:attempt,conclusion,workflow_id:5,name:'CI principal',
    head_branch:'fix/issue',head_sha:'1234abcd',
    created_at:'2026-11-08T13:00:00Z',updated_at:updated};
}
function mock({runs=[],repos=['Terrania'],issues=[],attempts={},jobs=[{name:'build',
  conclusion:'failure',steps:[{name:'test',conclusion:'failure'}]}]}={}){
  const storage=[...issues],calls=[];
  const api=async(path,{method='GET',body}={})=>{
    calls.push({path,method,body});
    if(path.startsWith('/users/'))return repos.map(name=>({name,owner:{login:'Softdown-prog'},visibility:'public'}));
    if(path.includes('/actions/runs?'))return {workflow_runs:runs};
    if(path.includes('/actions/runs/')&&path.includes('/attempts/')&&!path.includes('/jobs?')){
      return attempts[path.match(/\/attempts\/(\d+)/)[1]];
    }
    if(path.includes('/actions/runs/')&&path.includes('/jobs?'))return {jobs};
    if(path.includes('/issues?'))return storage;
    if(method==='POST'&&path.endsWith('/issues')){
      const newIssue={number:storage.length+1,...body};storage.push(newIssue);return newIssue;
    }
    if(method==='PATCH'){
      const item=storage.find(x=>path.endsWith('/'+x.number));item.body=body.body;return item;
    }
    throw Error('Unexpected API '+method+' '+path);
  };
  return {api,storage,calls};
}
const silent={log(){},error(){}};
test('only actual unsuccessful completed statuses trigger',()=>{
  assert.equal(isFailure('failure'),true);
  assert.equal(isFailure('timed_out'),true);
  assert.equal(isFailure('success'),false);
  assert.equal(isFailure('cancelled'),false);
  assert.equal(isFailure(null),false);
  assert.ok(!/[<>\[\]`]/.test(clean('<script>[evil]</script>')));
});
test('stable markers dedupe attempts, preserve historical records',()=>{
  const a='- old '+mark(11,1),b='- new '+mark(11,2);
  assert.deepEqual(mergeRows([a],[b,a]),[b,a]);
  assert.deepEqual(rows(issueBody('Softdown-prog/Terrania',[a,b])),[a,b]);
});
test('one inbox issue for distinct red commits; no repeated notifications',async()=>{
  const m=mock({runs:[run(12),run(11)]});
  const first=await scan({api:m.api,now:NOW,logger:silent});
  assert.equal(first.created,1);
  assert.equal(first.records,2);
  assert.match(m.storage[0].body,/12:1/);
  assert.match(m.storage[0].body,/11:1/);
  const second=await scan({api:m.api,now:NOW,logger:silent});
  assert.equal(second.records,0);
  assert.equal(m.calls.filter(x=>x.method==='POST').length,1);
});
test('failed attempt remains logged after successful rerun',async()=>{
  const last=run(77,{conclusion:'success',attempt:2,updated:'2026-11-08T13:55:00Z'});
  const previous=run(77,{updated:'2026-11-08T13:20:00Z'});
  const m=mock({runs:[last],attempts:{1:previous}});
  const result=await scan({api:m.api,now:NOW,logger:silent});
  assert.equal(result.created,1);
  assert.match(m.storage[0].body,/77:1/);
  assert.match(m.storage[0].body,/recuperado/);
});
test('green, cancelled and in-progress runs do not open inbox',async()=>{
  const m=mock({runs:[run(1,{conclusion:'success'}),run(2,{conclusion:'cancelled'}),run(3,{conclusion:null})]});
  const result=await scan({api:m.api,now:NOW,logger:silent});
  assert.equal(result.created,0);
});
test('existing issue gets updated only for new failure',async()=>{
  const prior=issueBody('Softdown-prog/Terrania',['- prior '+mark(1,1)]);
  const m=mock({runs:[run(2)],issues:[{number:7,title:'[CI Sentinel] Softdown-prog/Terrania',body:prior}]});
  const result=await scan({api:m.api,now:NOW,logger:silent});
  assert.equal(result.updated,1);
  assert.match(m.storage[0].body,/2:1/);
  assert.match(m.storage[0].body,/1:1/);
});
test('rate-limit/permission errors cannot be silent success',async()=>{
  assert.throws(()=>client({token:''}),/required/);
  const api=client({token:'test',fetchImpl:async()=>({ok:false,status:403})});
  await assert.rejects(api('/users/Softdown-prog/repos'),/403/);
});
