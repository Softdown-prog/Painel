import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPublicHealth, cachedPublicHealth } from './deploy-public-health.mjs';

const sha='a'.repeat(40),other='b'.repeat(40);
const valid=revision=>new Response(JSON.stringify({deploy:{gitSha:revision},token:'SHOULD_NOT_LEAK'}),{
  status:200,headers:{'content-type':'application/json'}
});
test('public /health confirms the running Docker SHA without accepting a user-supplied URL',async()=>{
 let requested;
 const fetcher=async(url,options)=>{requested={url,options};return valid(sha);};
 const result=await inspectPublicHealth(fetcher,sha,Date.parse('2026-10-26T13:00:00Z'));
 assert.equal(result.status,'matched');
 assert.equal(result.revision,sha);
 assert.ok(requested.url.startsWith('https://softload.analysepro.com/health?'));
 assert.equal(requested.options.redirect,'error');
 assert.ok(!JSON.stringify(result).includes('SHOULD_NOT_LEAK'));
 assert.equal(Object.keys(result).length,4);
});
test('public revision differing from Docker SHA must not be declared published',async()=>{
 const result=await inspectPublicHealth(async()=>valid(other),sha);
 assert.equal(result.status,'different');
 assert.equal(result.revision,other);
 assert.equal(result.comparedTo,sha);
});
test('short valid public SHA is recognized only as prefix of the full Docker revision',async()=>{
 assert.equal((await inspectPublicHealth(async()=>valid(sha.slice(0,10)),sha)).status,'matched');
 assert.equal((await inspectPublicHealth(async()=>valid(other.slice(0,10)),sha)).status,'different');
});
test('public response without Docker evidence is observed but cannot assert the release is live',async()=>{
 const result=await inspectPublicHealth(async()=>valid(sha));
 assert.equal(result.status,'observed');
 assert.equal(result.comparedTo,null);
});
test('bad HTTP status, empty JSON, invalid SHA, network error and oversized body are inconclusive',async()=>{
 const cases=[
  async()=>new Response('{}',{status:502}),
  async()=>new Response(JSON.stringify({deploy:{gitSha:'not-a-sha'}}),{status:200}),
  async()=>new Response(JSON.stringify({deploy:{gitSha:'a'.repeat(6)}}),{status:200}),
  async()=>{throw Error('network offline');},
  async()=>new Response('x'.repeat(18000),{status:200})
 ];
 for(const fake of cases){
  const result=await inspectPublicHealth(fake,sha);
  assert.equal(result.status,'unavailable');
  assert.equal(result.revision,null);
 }
});
test('health request caches repeated checks for same app SHA without polling public site every refresh',async()=>{
 let count=0;const expected='d'.repeat(40),base=Date.parse('2026-10-26T15:00:00Z');
 const fetcher=async()=>{count++;return valid(expected);};
 const first=await cachedPublicHealth(expected,base,fetcher);
 const second=await cachedPublicHealth(expected,base+1000,fetcher);
 assert.equal(count,1);
 assert.equal(first.status,'matched');
 assert.deepEqual(first,second);
 await cachedPublicHealth(expected,base+30000,fetcher);
 assert.equal(count,2);
});
