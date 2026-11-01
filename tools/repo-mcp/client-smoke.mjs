#!/usr/bin/env node
// MCP client smoke test: local loopback or approved HTTPS endpoint.
// Bearer token read from file, never logged or placed on command line.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export async function verifyClient({endpoint,tokenFile,fetcher=fetch}){
 const parsed=new URL(endpoint);
 if(!(parsed.protocol==='https:' || (parsed.protocol==='http:' && ['127.0.0.1','localhost'].includes(parsed.hostname))))
   throw Error('Remote MCP verification requires HTTPS');
 if(parsed.pathname!=='/mcp'||parsed.username||parsed.password||parsed.search||parsed.hash)
   throw Error('Exact MCP endpoint path required');
 const token=(await readFile(tokenFile,'utf8')).trim();
 if(token.length<32||token.length>512)throw Error('Token file invalid');
 const req=async(method,body,headers={})=>{
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),12000);
  try {
   return await fetcher(endpoint,{method,headers,body:body===undefined?undefined:JSON.stringify(body),
     signal:controller.signal,redirect:'error'});
  }finally{clearTimeout(timeout);}
 };
 const missing=await req('GET');
 if(missing.status!==401)throw Error('Unauthorized requests were not rejected');
 const bogus=await req('GET',undefined,{authorization:'Bearer not-the-token'});
 if(bogus.status!==401)throw Error('Wrong token accepted or front proxy interfering');
 const headers={'authorization':'Bearer '+token,'accept':'application/json, text/event-stream',
   'content-type':'application/json','mcp-protocol-version':'2025-11-25'};
 const origin=await req('POST',{jsonrpc:'2.0',id:1,method:'ping'}, {...headers,origin:'https://untrusted.example'});
 if(origin.status!==403)throw Error('Untrusted Origin not denied');
 const rpc=async(id,method,params={})=>{
  const response=await req('POST',{jsonrpc:'2.0',id,method,params},headers);
  if(response.status!==200)throw Error('MCP '+method+' HTTP '+response.status);
  const raw=await response.text();
  if(raw.length>500000)throw Error('Oversized MCP reply');
  const result=JSON.parse(raw);
  if(result.id!==id||result.error)throw Error('Invalid MCP '+method+' JSON-RPC result');
  return result.result;
 };
 const init=await rpc(2,'initialize',{protocolVersion:'2025-11-25',capabilities:{},
   clientInfo:{name:'vps-code-mcp-smoke',version:'1.0.0'}});
 if(init.protocolVersion!=='2025-11-25')throw Error('Unexpected negotiated MCP version');
 const listed=await rpc(3,'tools/list');
 const tools=listed.tools.map(t=>t.name);
 for(const expected of ['repo_list','repo_stats','repo_find_files','repo_find_symbols','repo_read_file','repo_search_text']){
  if(!tools.includes(expected))throw Error('Missing MCP tool: '+expected);
 }
 const read=async(id,name,args={})=>{
  const result=await rpc(id,'tools/call',{name,arguments:args});
  if(result.isError)throw Error('MCP read tool failed: '+name);
  return JSON.parse(result.content[0].text);
 };
 const repos=await read(4,'repo_list');
 if(!Array.isArray(repos)||!repos.includes('Painel'))throw Error('Painel repo missing from MCP');
 const stats=await read(5,'repo_stats',{repo:'Painel'});
 if(typeof stats.fileCount!=='number'||stats.fileCount<1)throw Error('Empty source index');
 const files=await read(6,'repo_find_files',{repo:'Painel',query:'executor',limit:5});
 if(!Array.isArray(files))throw Error('Invalid repo_find_files payload');
 return {ok:true,protocolVersion:init.protocolVersion,tools:tools.length,
   repos:repos.length,indexedFiles:stats.fileCount,matchedFiles:files.length,
   verifiedAuth:true,verifiedOrigin:true,verifiedReadTools:true};
}
const invoked=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked){
 const [endpoint='http://127.0.0.1:8789/mcp',tokenFile='/etc/vps-operations/code-mcp-token']=process.argv.slice(2);
 try{process.stdout.write(JSON.stringify(await verifyClient({endpoint,tokenFile}),null,2)+'\n');}
 catch(e){process.stderr.write('MCP verification FAILED: '+e.message+'\n');process.exitCode=1;}
}
