import {fileURLToPath} from 'node:url';

const OWNER='Softdown-prog';
const INBOX='Painel';
const LOOKBACK=3*60*60*1000;
const BAD=new Set(['failure','timed_out','startup_failure','action_required']);
const OWN_WORKFLOW='CI Sentinel - todos os repositórios';

export const isFailure=(status)=>BAD.has(status);
export const mark=(id,attempt)=>`<!-- ci-sentinel:${id}:${attempt} -->`;
export const clean=(value,max=100)=>String(value??'')
  .replace(/[\r\n\t]+/g,' ').replace(/[<>|\[\]()`\\]/g,' ')
  .replace(/\s+/g,' ').trim().slice(0,max);

// Public opaque correlation hint, NEVER a ChatGPT URL, conversation ID,
// access token or identity. A GitHub PR can forge this marker: it must never
// authorize actions or imply that a notification reached a conversation.
export function parseOrigin(value){
  const source=String(value??'');
  const tags=[
    ...source.matchAll(/(?:^|\n)<!-- ci-sentinel-origin:v1:([a-f0-9]{32}) -->(?=\r?\n|$)/g),
    ...source.matchAll(/(?:^|\n)CI-Sentinel-Origin: v1:([a-f0-9]{32})(?=\r?\n|$)/g)
  ];
  const ids=new Set(tags.map(match=>match[1]));
  return ids.size===1?'v1:'+Array.from(ids)[0]:null;
}

// Only resolve origin metadata for an already failed run. The association
// comes from GitHub's run.pull_requests or the exact run.head_sha, never from
// the branch name, the file content, or a user-supplied network address.
export async function originForRun(api,name,run,cache=new Map()){
  const id=String(run.id??'')+':'+String(run.head_sha??'');
  if(cache.has(id))return cache.get(id);
  const numbers=[...new Set((Array.isArray(run.pull_requests)?run.pull_requests:[])
    .map(pr=>pr?.number).filter(n=>Number.isInteger(n)&&n>0))].slice(0,3);
  const candidates=new Set();
  for(const number of numbers){
    try{
      const pr=await api('/repos/'+name+'/pulls/'+number);
      const parsed=parseOrigin(pr?.body);
      if(parsed)candidates.add(parsed);
    }catch(error){
      if(![403,404].includes(error.status))throw error;
    }
  }
  let result=candidates.size===1?[...candidates][0]:null;
  if(!result&&candidates.size===0&&/^[0-9a-f]{40}$/.test(run.head_sha??'')){
    try{
      const commit=await api('/repos/'+name+'/commits/'+run.head_sha);
      result=parseOrigin(commit?.commit?.message);
    }catch(error){
      if(![403,404].includes(error.status))throw error;
    }
  }
  cache.set(id,result);
  return result;
}

export function rows(body){
  return String(body??'').split('\n').filter(line=>line.startsWith('- ')&&
    /<!-- ci-sentinel:\d+:\d+ -->/.test(line));
}
export function mergeRows(existing,fresh){
  const seen=new Set(),result=[];
  for(const row of [...fresh,...existing]){
    const match=row.match(/<!-- ci-sentinel:(\d+):(\d+) -->/);
    if(!match||seen.has(match[0]))continue;
    result.push(row);seen.add(match[0]);
    if(result.length>=100)break;
  }
  return result;
}
export function issueBody(name,items){
  return [
    `# Falhas GitHub Actions — ${name}`,'',
    'Registro automático: cada tentativa vermelha permanece identificada mesmo',
    'quando o commit seguinte passa. Não há merge, execução de código de PR,',
    'reexecução de deploy ou correção automática neste coletor.','',
    `<!-- ci-sentinel-repo:${name} -->`,'',
    '## Execuções (mais recentes primeiro)','',...items,''
  ].join('\n');
}

async function paginate(api,path,pick,maxPages=5){
  const result=[];
  for(let page=1;page<=maxPages;page++){
    const data=await api(path+(path.includes('?')?'&':'?')+`per_page=100&page=${page}`);
    const items=pick(data);
    if(!Array.isArray(items))throw Error('Invalid GitHub API page: '+path);
    result.push(...items);
    if(items.length<100)break;
  }
  return result;
}
async function listRepos(api,owner){
  const items=await paginate(api,`/users/${encodeURIComponent(owner)}/repos?type=owner`,x=>x);
  return items.filter(x=>x?.owner?.login?.toLowerCase()===owner.toLowerCase()&&
    !x.archived&&!x.disabled&&x.visibility!=='private'&&typeof x.name==='string');
}
async function recentRuns(api,name,now){
  const since=now.getTime()-LOOKBACK,output=[];
  for(let page=1;page<=5;page++){
    const result=await api(`/repos/${name}/actions/runs?per_page=100&page=${page}`);
    const list=result.workflow_runs;
    if(!Array.isArray(list))throw Error('Invalid workflow runs for '+name);
    for(const x of list){
      if(Date.parse(x.created_at)>=since||Date.parse(x.updated_at)>=since)
        output.push(x);
    }
    if(list.length<100||list.every(x=>Date.parse(x.created_at)<since))break;
  }
  return output.filter(x=>x.name!==OWN_WORKFLOW);
}
async function getAttempts(api,name,run){
  const result=[],latest=Math.max(1,Math.min(Number(run.run_attempt)||1,5));
  for(let a=1;a<=latest;a++){
    let entry=run;
    if(a!==Number(run.run_attempt||1)){
      try{entry=await api(`/repos/${name}/actions/runs/${run.id}/attempts/${a}`);}
      catch(e){if(e.status===404)continue;throw e;}
    }
    if(entry&&isFailure(entry.conclusion))result.push({entry,attempt:a});
  }
  return result;
}
async function failingJobs(api,name,runId,attempt,latest){
  const suffix=attempt===latest?`/jobs?per_page=100`:
    `/attempts/${attempt}/jobs?per_page=100`;
  const result=await api(`/repos/${name}/actions/runs/${runId}${suffix}`);
  const items=result.jobs;
  if(!Array.isArray(items))throw Error('Could not inspect failed jobs');
  const lines=items.filter(j=>isFailure(j.conclusion)).flatMap(j=>{
    const steps=(j.steps??[]).filter(s=>isFailure(s.conclusion));
    return steps.length?steps.map(s=>`${clean(j.name,40)} / ${clean(s.name,70)}`):
      [clean(j.name,90)];
  });
  return clean(lines.slice(0,4).join('; ')||'logs precisam de inspeção',250);
}
export async function scan({api,owner=OWNER,inbox=INBOX,now=new Date(),logger=console}={}){
  const repositories=await listRepos(api,owner);
  const inboxPath=`/repos/${owner}/${inbox}/issues`;
  const issues=await paginate(api,inboxPath+'?state=open',x=>x);
  const existing=new Map(issues.filter(x=>x.title?.startsWith('[CI Sentinel] ')&&
    !x.pull_request).map(x=>[x.title.slice('[CI Sentinel] '.length),x]));
  const summary={repositories:repositories.length,created:0,updated:0,records:0,correlated:0,errors:[]};
  // Four simultaneous repositories minimize rate pressure on public Actions APIs.
  for(let offset=0;offset<repositories.length;offset+=4){
    await Promise.all(repositories.slice(offset,offset+4).map(async repository=>{
      const name=`${owner}/${repository.name}`;
      try{
        const runs=await recentRuns(api,name,now);
        const issue=existing.get(name);
        const prior=rows(issue?.body);
        const seen=new Set(prior.map(row=>row.match(/<!-- ci-sentinel:\d+:\d+ -->/)?.[0]));
        const fresh=[];
        const originCache=new Map();
        for(const run of runs){
          if(!run.id||(!isFailure(run.conclusion)&&Number(run.run_attempt||1)<=1))continue;
          const attempts=await getAttempts(api,name,run);
          // Existing records must never get a second origin tag appended.
          const unseen=attempts.filter(({attempt})=>!seen.has(mark(run.id,attempt)));
          if(unseen.length===0)continue;
          const origin=await originForRun(api,name,run,originCache);
          for(const {entry,attempt} of unseen){
            const id=mark(run.id,attempt);
            if(seen.has(id))continue;
            const job=await failingJobs(api,name,run.id,attempt,Number(run.run_attempt)||1);
            const recovered=run.conclusion==='success'&&attempt<Number(run.run_attempt||1)||
              runs.some(r=>r.id!==run.id&&r.conclusion==='success'&&
                r.workflow_id===run.workflow_id&&r.head_branch===run.head_branch&&
                Date.parse(r.updated_at)>Date.parse(entry.updated_at));
            const url=`https://github.com/${name}/actions/runs/${run.id}/attempts/${attempt}`;
            fresh.push(`- ${clean(entry.updated_at??run.updated_at,30)} · `+
              `[${clean(run.name,80)} — ${run.id}/${attempt}](${url}) · `+
              `${clean(run.head_branch,50)} · ${clean(run.head_sha,12)} · `+
              `${recovered?'recuperado':'falha'} · ${job}`+
              (origin?' · origem '+origin:'')+' '+id);
            if(origin)summary.correlated++;
          }
        }
        if(!fresh.length)return;
        const body=issueBody(name,mergeRows(prior,fresh));
        if(issue){
          await api(`${inboxPath}/${issue.number}`,{method:'PATCH',body:{body}});
          summary.updated++;
        }else{
          await api(inboxPath,{method:'POST',body:{title:`[CI Sentinel] ${name}`,body}});
          summary.created++;
        }
        summary.records+=fresh.length;
        logger.log(`CI Sentinel: ${name}, novas falhas: ${fresh.length}`);
      }catch(error){
        const message=clean(error.message,180);
        summary.errors.push({repo:name,message});
        logger.error(`CI Sentinel: ${name}: ${message}`);
      }
    }));
  }
  return summary;
}
export function client({token,fetchImpl=globalThis.fetch}={}){
  if(!token)throw Error('GITHUB_TOKEN is required');
  return async(path,{method='GET',body}={})=>{
    const response=await fetchImpl('https://api.github.com'+path,{
      method,headers:{
        accept:'application/vnd.github+json',
        authorization:'Bearer '+token,
        'x-github-api-version':'2022-11-28',
        ...(body?{'content-type':'application/json'}:{})
      },...(body?{body:JSON.stringify(body)}:{})
    });
    if(!response.ok){
      const error=Error(`GitHub API ${response.status} ${method} ${path}`);
      error.status=response.status;throw error;
    }
    return response.status===204?null:response.json();
  };
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  const result=await scan({api:client({token:process.env.GITHUB_TOKEN})});
  console.log('CI Sentinel:',JSON.stringify(result));
  if(result.errors.length)process.exitCode=1;
}
