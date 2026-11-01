import {writeFile} from 'node:fs/promises';
const ENDPOINT='https://mcp.analysepro.com';
const MAX_BODY=4096;
const cases=[
 {label:'health GET',method:'GET',path:'/health'},
 {label:'mcp unauthenticated GET',method:'GET',path:'/mcp'},
 {label:'mcp invalid bearer GET',method:'GET',path:'/mcp',headers:{authorization:'Bearer invalid-diagnostic-token-not-a-secret'}},
 {label:'mcp invalid bearer POST initialize',method:'POST',path:'/mcp',headers:{authorization:'Bearer invalid-diagnostic-token-not-a-secret',
  accept:'application/json, text/event-stream','content-type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},
   clientInfo:{name:'github-actions-anonymous-diagnostic',version:'1.0.0'}}})},
 {label:'mcp unauthenticated POST',method:'POST',path:'/mcp',headers:{accept:'application/json, text/event-stream','content-type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:2,method:'ping'})},
 {label:'mcp invalid bearer POST with Origin',method:'POST',path:'/mcp',
  headers:{origin:'https://diagnostic-invalid-origin.example',authorization:'Bearer invalid-diagnostic-token-not-a-secret',
    accept:'application/json, text/event-stream','content-type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:3,method:'ping'})},
 {label:'unknown path',method:'GET',path:'/__mcp_diagnostic_not_found_7f5d'},
];
export function classify(status,body){
 let parsed;
 try{parsed=JSON.parse(body);}catch{return {format:'non-json',classification:status===403?'possible-edge-rule-or-html-block':'non-json-reply'};}
 const keys=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?Object.keys(parsed).filter(k=>['error','jsonrpc','ok','service','success','message','errors','result'].includes(k)):[];
 const errorText=typeof parsed.error==='string'?parsed.error:typeof parsed.error?.message==='string'?parsed.error.message:'';
 return {format:'json',keys,classification:
  status===403&&errorText==='origin rejected'?'mcp-origin-rejection':
  status===401&&errorText==='unauthorized'?'mcp-bearer-auth':
  status===404&&errorText==='not found'?'mcp-404':
  status===200&&parsed.service==='code-mcp'?'mcp-health':
  status===403?'unexpected-json-403':'other'};
}
export async function diagnose({fetcher=fetch}={}){
 const out=[];
 for(const item of cases){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),12000);
  try{
   const res=await fetcher(ENDPOINT+item.path,{method:item.method,headers:item.headers??{},
    body:item.body,redirect:'manual',signal:controller.signal});
   const data=(await res.text()).slice(0,MAX_BODY);
   const result={label:item.label,status:res.status,server:res.headers.get('server')??'',
     cfRay:res.headers.get('cf-ray')??'',contentType:res.headers.get('content-type')??'',
     wwwAuthenticate:res.headers.has('www-authenticate'),
     ...classify(res.status,data)};
   out.push(result);
  }catch(e){out.push({label:item.label,networkError:e instanceof Error?e.name:'unknown'});}
  finally{clearTimeout(timer);}
 }
 return {target:ENDPOINT+'/mcp',probes:out,
    note:'No valid token, credentials, secrets or request body are printed/stored. GitHub runner cannot test host-only bearer.'};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 const output=await diagnose();
 process.stdout.write(JSON.stringify(output,null,2)+'\n');
 if(process.env.GITHUB_WORKSPACE)await writeFile('mcp-public-diagnostic.json',JSON.stringify(output,null,2)+'\n');
 const bad=output.probes.filter(x=>x.networkError);
 if(bad.length)process.exitCode=1;
}