import test from 'node:test';
import assert from 'node:assert/strict';
import {classify,diagnose} from './public-diagnostics.mjs';
test('classifies real MCP origin response rather than attributing to Cloudflare',()=>{
 assert.equal(classify(403,'{"error":"origin rejected"}').classification,'mcp-origin-rejection');
 assert.equal(classify(401,'{"error":"unauthorized"}').classification,'mcp-bearer-auth');
 assert.equal(classify(403,'{"success":false,"errors":[{"code":1}]}').classification,'unexpected-json-403');
});
test('public diagnosis never sends a valid bearer token and records only sanitized response metadata',async()=>{
 const reqs=[];
 const result=await diagnose({fetcher:async (url,request)=>{
  reqs.push({url,method:request.method,auth:request.headers?.authorization});
  return new Response('{"error":"unauthorized"}',{status:401,headers:{'cf-ray':'sample','server':'cloudflare'}});
 }});
 assert.equal(result.probes.length,7);
 assert.equal(reqs.length,7);
 assert.equal(reqs.every(r=>!r.auth||r.auth.includes('invalid-diagnostic-token')),true);
 assert.equal(JSON.stringify(result).includes('Bearer '),false);
 assert.equal(result.probes.every(r=>r.status===401),true);
});