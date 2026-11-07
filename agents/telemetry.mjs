/**
 * Read-only, bounded Codex app-server metadata suitable for an administrative UI.
 * Never copy OAuth, account ids, provider metadata, file paths, or raw RPC errors.
 */
const MODEL=/^[a-z0-9][a-z0-9._-]{0,79}$/i;
const EFFORTS=new Set(['none','minimal','low','medium','high','xhigh','max']);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const safeInt=(v,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=0&&v<=max?v:null;
export function normalizeModels(result){
 const data=Array.isArray(result?.data)?result.data:[];
 const models=[];const seen=new Set();
 for(const entry of data.slice(0,100)){
  const id=typeof entry?.model==='string'?entry.model:entry?.id;
  if(typeof id!=='string'||!MODEL.test(id)||entry.hidden===true||seen.has(id))continue;
  seen.add(id);
  const efforts=Array.isArray(entry.supportedReasoningEfforts)?
   entry.supportedReasoningEfforts.map(x=>typeof x==='string'?x:x?.reasoningEffort)
   .filter(x=>EFFORTS.has(x)):[];
  const defaultEffort=EFFORTS.has(entry.defaultReasoningEffort)?entry.defaultReasoningEffort:null;
  models.push({id,label:typeof entry.displayName==='string'&&entry.displayName.length<=100?
   entry.displayName:id,efforts:[...new Set(efforts)],defaultEffort,isDefault:entry.isDefault===true});
 }
 return models;
}
export function validSelection(models,model,effort){
 if(model===null&&effort===null)return true;
 if(typeof model!=='string')return false;
 const available=models.find(x=>x.id===model);
 return !!available&&(effort===null||(typeof effort==='string'&&available.efforts.includes(effort)));
}
function windowData(source){
 if(!plain(source))return null;
 const percent=typeof source.usedPercent==='number'&&Number.isFinite(source.usedPercent)&&
  source.usedPercent>=0&&source.usedPercent<=100?source.usedPercent:null;
 const mins=safeInt(source.windowDurationMins,60*24*60);
 const reset=safeInt(source.resetsAt,4_102_444_800);
 return percent===null&&mins===null&&reset===null?null:
  {usedPercent:percent,windowDurationMins:mins,resetsAt:reset};
}
export function normalizeRateLimits(raw){
 if(!plain(raw))return {available:false,buckets:[],resetCreditsAvailable:null,ordinaryUsageAllowed:null};
 const by=plain(raw.rateLimitsByLimitId)?Object.values(raw.rateLimitsByLimitId):
  plain(raw.rateLimits)?[raw.rateLimits]:[];
 const buckets=[];
 for(const value of by.slice(0,20)){
  if(!plain(value))continue;
  const id=typeof value.limitId==='string'&&MODEL.test(value.limitId)?value.limitId:'codex';
  const primary=windowData(value.primary),secondary=windowData(value.secondary);
  if(!primary&&!secondary)continue;
  buckets.push({id,label:typeof value.limitName==='string'&&value.limitName.length<=80?
   value.limitName:id,primary,secondary});
 }
 const creditCount=safeInt(raw.rateLimitResetCredits?.availableCount,1000000);
 const ordinaryUsageAllowed=typeof raw.ordinaryUsageAllowed==='boolean'?
  raw.ordinaryUsageAllowed:null;
 return {available:buckets.length>0,buckets,resetCreditsAvailable:creditCount,ordinaryUsageAllowed};
}
export function normalizeUsage(raw){
 if(!plain(raw)||!plain(raw.summary)&&!Array.isArray(raw.dailyUsageBuckets))
  return {available:false,lifetimeTokens:null,daily:[]};
 const summary=plain(raw.summary)?raw.summary:{};
 const daily=[];
 for(const row of (Array.isArray(raw.dailyUsageBuckets)?raw.dailyUsageBuckets:[]).slice(-90)){
  if(!plain(row)||typeof row.startDate!=='string'||
   !/^\d{4}-\d{2}-\d{2}$/.test(row.startDate))continue;
  const tokens=safeInt(row.tokens);
  if(tokens!==null)daily.push({date:row.startDate,tokens});
 }
 return {available:daily.length>0||safeInt(summary.lifetimeTokens)!==null,
  lifetimeTokens:safeInt(summary.lifetimeTokens),daily};
}
export function normalizeThreadTokens(params){
 const usage=params?.tokenUsage??params?.usage;
 const source=plain(usage?.total)?usage.total:plain(usage)?usage:null;
 if(!source)return null;
 const inputTokens=safeInt(source.inputTokens);
 const cachedInputTokens=safeInt(source.cachedInputTokens);
 const outputTokens=safeInt(source.outputTokens);
 const totalTokens=safeInt(source.totalTokens);
 if([inputTokens,cachedInputTokens,outputTokens,totalTokens].every(x=>x===null))return null;
 return {inputTokens,cachedInputTokens,outputTokens,totalTokens};
}
export function safeTitle(value){
 if(typeof value!=='string')return null;
 const text=value.trim();
 if(!text||text.length>80||/[\u0000-\u001f\u007f]/.test(text))return null;
 return text;
}
