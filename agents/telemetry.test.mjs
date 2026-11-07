import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeModels,validSelection,normalizeRateLimits,normalizeUsage,
 normalizeThreadTokens,safeTitle} from './telemetry.mjs';
test('model catalog uses only server-provided models and supported efforts',()=>{
 const models=normalizeModels({data:[
  {model:'gpt-6.1-sol',displayName:'GPT-6.1 Sol',
   supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],defaultReasoningEffort:'high',isDefault:true},
  {model:'gpt-hidden',hidden:true},{model:'../../etc/passwd'},
  {model:'gpt-6.1-sol',displayName:'duplicate'}
 ]});
 assert.deepEqual(models,[{id:'gpt-6.1-sol',label:'GPT-6.1 Sol',
  efforts:['low','high'],defaultEffort:'high',isDefault:true}]);
 assert.equal(validSelection(models,'gpt-6.1-sol','high'),true);
 assert.equal(validSelection(models,'gpt-6.1-sol','max'),false);
 assert.equal(validSelection(models,'other','high'),false);
 assert.equal(validSelection(models,null,null),true);
 assert.equal(validSelection(models,null,'medium'),false);
});
test('quota windows keep server values and never invent weekly limits',()=>{
 const result=normalizeRateLimits({rateLimitsByLimitId:{codex:{
  limitId:'codex',primary:{usedPercent:12,windowDurationMins:300,resetsAt:1780000000},
  secondary:{usedPercent:66,windowDurationMins:10080,resetsAt:1780100000}
 }},account:{email:'no-leak'},credits:{secret:'no'}});
 assert.deepEqual(result.buckets[0].secondary,{usedPercent:66,windowDurationMins:10080,resetsAt:1780100000});
 assert.equal(JSON.stringify(result).includes('no-leak'),false);
 assert.deepEqual(normalizeRateLimits({}),{
  available:false,buckets:[],resetCreditsAvailable:null,ordinaryUsageAllowed:null
 });
 const credits=normalizeRateLimits({
  rateLimits:{limitId:'codex',primary:{usedPercent:0,windowDurationMins:300,resetsAt:1780000000}},
  rateLimitResetCredits:{availableCount:2,credits:[{id:'private-provider-id',status:'available'}]},
  ordinaryUsageAllowed:false
 });
 assert.equal(credits.resetCreditsAvailable,2);
 assert.equal(credits.ordinaryUsageAllowed,false);
 assert.equal(JSON.stringify(credits).includes('private-provider-id'),false);
 assert.equal(normalizeRateLimits({rateLimitResetCredits:{availableCount:0}}).resetCreditsAvailable,0);
});
test('token activity and missing values differ from zero',()=>{
 assert.deepEqual(normalizeUsage({}),{available:false,lifetimeTokens:null,daily:[]});
 assert.deepEqual(normalizeUsage({summary:{lifetimeTokens:0},dailyUsageBuckets:[]}),
  {available:true,lifetimeTokens:0,daily:[]});
 assert.deepEqual(normalizeThreadTokens({tokenUsage:{total:{inputTokens:5,outputTokens:9,totalTokens:14}}}),
  {inputTokens:5,cachedInputTokens:null,outputTokens:9,totalTokens:14});
 assert.equal(normalizeThreadTokens({}),null);
});
test('titles are safe and bounded',()=>{
 assert.equal(safeTitle('  Corrigir o Painel  '),'Corrigir o Painel');
 assert.equal(safeTitle(''),null);
 assert.equal(safeTitle('a'.repeat(81)),null);
 assert.equal(safeTitle('x\nx'),null);
});
