// Read-only, allowlisted HTTPS check: never accepts a URL from the browser.
// The application /health endpoint reports deploy.gitSha; it is separate evidence from Docker.
const HEALTH_ORIGIN='https://softload.analysepro.com';
const MAX_BODY=16*1024;
const FULL_SHA=/^[a-f0-9]{40}$/;
const PUBLIC_SHA=/^[a-f0-9]{7,40}$/;

async function boundedJson(response){
  const declared=Number(response.headers?.get?.('content-length')||0);
  if(declared>MAX_BODY)throw new Error('Public health response too large');
  const parts=[];
  let total=0;
  if(!response.body)throw new Error('Public health response empty');
  for await(const part of response.body){
    const chunk=typeof part==='string'?Buffer.from(part):Buffer.from(part);
    total+=chunk.length;
    if(total>MAX_BODY)throw new Error('Public health response too large');
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
export async function inspectPublicHealth(fetcher=fetch, expectedSha=null, now=Date.now()){
  const checkedAt=new Date(now).toISOString();
  const comparedTo=FULL_SHA.test(expectedSha||'')?expectedSha:null;
  const unavailable={status:'unavailable',revision:null,comparedTo,checkedAt};
  try{
    const url=new URL('/health',HEALTH_ORIGIN);
    // Avoid serving an old cached response during a redeploy.
    url.searchParams.set('deploy_sha',comparedTo||'panel-unknown');
    url.searchParams.set('panel_check',String(Math.floor(now/30000)));
    const response=await fetcher(url.toString(),{
      method:'GET',
      redirect:'error',
      headers:{'accept':'application/json','cache-control':'no-cache','user-agent':'softload-panel-health'},
      signal:AbortSignal.timeout(5000)
    });
    if(!response.ok||response.status!==200)return unavailable;
    const payload=await boundedJson(response);
    const revision=payload?.deploy?.gitSha;
    if(typeof revision!=='string'||!PUBLIC_SHA.test(revision))return unavailable;
    return {status:!comparedTo?'observed':comparedTo.startsWith(revision)?'matched':'different',
      revision,comparedTo,checkedAt};
  }catch{return unavailable;}
}
let previous=null;
let inflight=null;
export async function cachedPublicHealth(expectedSha=null,now=Date.now(),fetcher=fetch){
  const sha=FULL_SHA.test(expectedSha||'')?expectedSha:null;
  if(previous&&previous.sha===sha&&now-previous.time<25000)return previous.result;
  if(inflight&&inflight.sha===sha)return inflight.promise;
  const promise=inspectPublicHealth(fetcher,sha,now).then(result=>{
    previous={sha,time:now,result};
    return result;
  }).finally(()=>{if(inflight?.promise===promise)inflight=null;});
  inflight={sha,promise};
  return promise;
}
