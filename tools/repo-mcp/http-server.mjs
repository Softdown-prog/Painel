import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {timingSafeEqual} from 'node:crypto';
import {resolve,sep} from 'node:path';
import {RepoNavigator} from './indexer.mjs';
import {registerSacRoutes,readSacReport} from './sac-report-router.mjs';

const DEFAULT_PORT=8789;
const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const repo={type:'string',minLength:1,maxLength:72};
const path={type:'string',minLength:1,maxLength:512};
const query={type:'string',minLength:1,maxLength:200};
const prefix={type:'string',maxLength:250};
const jobId={type:'string',minLength:7,maxLength:32};
const limit={type:'integer',minimum:1,maximum:100};
const catalog=[
 {name:'repo_list',description:'List repositories authorized for this MCP client',inputSchema:schema({})},
 {name:'sac_job_report',description:'Route to a pre-existing, validated technical SAC job report in one registered project (read-only; no broker).',inputSchema:schema({repo,jobId},['repo','jobId'])},
 {name:'repo_stats',description:'Index statistics (read-only)',inputSchema:schema({repo},['repo'])},
 {name:'repo_find_files',description:'Find files by path segment',inputSchema:schema({repo,query:{type:'string',maxLength:160},prefix,limit},['repo'])},
 {name:'repo_find_symbols',description:'Find function/class/type declarations',inputSchema:schema({repo,query,prefix,limit},['repo','query'])},
 {name:'repo_dependencies',description:'Find local imports and importers',inputSchema:schema({repo,path},['repo','path'])},
 {name:'repo_read_file',description:'Read numbered lines with SHA256',inputSchema:schema({repo,path,startLine:{type:'integer',minimum:1},endLine:{type:'integer',minimum:0}},['repo','path'])},
 {name:'repo_search_text',description:'Bounded text search',inputSchema:schema({repo,query,prefix,limit,caseSensitive:{type:'boolean'}},['repo','query'])},
 {name:'repo_reindex',description:'Refresh in-memory read-only index',inputSchema:schema({repo},['repo'])}
];
function validateArgs(input,descriptor){
 if(!input||typeof input!=='object'||Array.isArray(input))return false;
 const properties=descriptor.inputSchema.properties;
 if(Object.keys(input).some(k=>!Object.hasOwn(properties,k)))return false;
 if(descriptor.inputSchema.required.some(k=>!Object.hasOwn(input,k)))return false;
 return Object.entries(input).every(([key,value])=>{
  const p=properties[key];
  if(p.type==='string')return typeof value==='string'&&value.length>=(p.minLength??0)&&value.length<=(p.maxLength??Infinity);
  if(p.type==='boolean')return typeof value==='boolean';
  if(p.type==='integer')return Number.isSafeInteger(value)&&value>=(p.minimum??0)&&value<=(p.maximum??Infinity);
  return false;
 });
}
const answer=(data,isError=false)=>({content:[{type:'text',text:JSON.stringify(data)}],isError});
const rpc=(id,result)=>({jsonrpc:'2.0',id,result});
const error=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});

export async function createMcpHttpServer({registryFile,tokenFile,port=DEFAULT_PORT,hostname='127.0.0.1',repoRoot='/srv/repos',reportsRoot='/srv/sac-reports'}={}){
 if(!registryFile||!tokenFile)throw Error('MCP registry and token file are required');
 const raw=JSON.parse(await readFile(registryFile,'utf8'));
 if(!Array.isArray(raw.repos)||raw.repos.length<1||raw.repos.length>50)throw Error('Repository registry must contain 1-50 repositories');
 const repositories=new Map();
 for(const entry of raw.repos){
  if(!entry||!/^[-A-Za-z0-9_.]{2,72}$/.test(entry.name)||!entry.path||
    !resolve(entry.path).startsWith(resolve(repoRoot)+sep))
   throw Error('Invalid fixed repository registry entry');
  if(repositories.has(entry.name))throw Error('Duplicate repository');
  const navigator=new RepoNavigator(entry.path,{writable:false});
  // Build only in memory: mounted code remains read-only.
  await navigator.buildIndex({write:false});
  repositories.set(entry.name,navigator);
 }
 const reportRoutes=await registerSacRoutes(raw.repos,reportsRoot);
 const token=(await readFile(tokenFile,'utf8')).trim();
 if(token.length<32||token.length>512)throw Error('MCP token must be at least 32 characters');
 const validToken=Buffer.from(token);
 const authorized=header=>{
  if(typeof header!=='string'||!header.startsWith('Bearer '))return false;
  const candidate=Buffer.from(header.slice(7));
  return candidate.length===validToken.length&&timingSafeEqual(candidate,validToken);
 };
 const server=createServer(async (req,res)=>{
  const write=(status,data,extra={})=>{
   res.writeHead(status,{'cache-control':'no-store','content-type':'application/json; charset=utf-8','x-content-type-options':'nosniff',...extra});
   res.end(JSON.stringify(data));
  };
  if(req.url==='/health'&&req.method==='GET'){write(200,{ok:true,service:'code-mcp'});return;}
  if(req.url!=='/mcp'){write(404,{error:'not found'});return;}
  if(req.headers.origin){write(403,{error:'origin rejected'});return;} // deny browser origins / DNS rebinding
  if(!authorized(req.headers.authorization)){write(401,{error:'unauthorized'},{'www-authenticate':'Bearer realm="code-mcp"'});return;}
  if(req.method!=='POST'){write(405,{error:'method not allowed'},{allow:'POST'});return;}
  const accept=req.headers.accept??'';
  if(!accept.includes('application/json')||!accept.includes('text/event-stream')){
   write(406,{error:'MCP Accept must support JSON and SSE'});return;
  }
  if(!req.headers['content-type']?.startsWith('application/json')){write(415,{error:'expected application/json'});return;}
  const version=req.headers['mcp-protocol-version'];
  if(version&&version!=='2025-11-25'){write(400,{error:'unsupported MCP protocol version'});return;}
  let chunks=[],size=0;
  try{
   for await (const chunk of req){
    size+=chunk.length;
    if(size>65536){write(413,{error:'request too large'});return;}
    chunks.push(chunk);
   }
  }catch{write(400,{error:'invalid body'});return;}
  let body;
  try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{write(400,{error:'invalid JSON'});return;}
  if(!body||body.jsonrpc!=='2.0'||typeof body.method!=='string'||Array.isArray(body)){
   write(400,error(body?.id??null,-32600,'Invalid request'));return;
  }
  if(!Object.hasOwn(body,'id')){res.writeHead(202,{'cache-control':'no-store'});res.end();return;}
  const id=body.id;
  if(typeof id!=='string'&&typeof id!=='number'){write(400,error(null,-32600,'Invalid id'));return;}
  try{
   if(body.method==='initialize'){
    write(200,rpc(id,{protocolVersion:'2025-11-25',capabilities:{tools:{listChanged:false}},
     serverInfo:{name:'multi-repo-code-mcp',version:'1.0.0'},
     instructions:'Source snapshot; read-only. Choose repo from repo_list; no shell, git mutations or deploy.'}));
    return;
   }
   if(body.method==='ping'){write(200,rpc(id,{}));return;}
   if(body.method==='tools/list'){write(200,rpc(id,{tools:catalog}));return;}
   if(body.method!=='tools/call'){write(200,error(id,-32601,'Method not found'));return;}
   const descriptor=catalog.find(t=>t.name===body.params?.name),args=body.params?.arguments??{};
   if(!descriptor){write(200,error(id,-32602,'Unknown tool'));return;}
   if(!validateArgs(args,descriptor)){write(200,rpc(id,answer({error:'Invalid arguments'},true)));return;}
   if(descriptor.name==='repo_list'){
    write(200,rpc(id,answer([...repositories.keys()])));return;
   }
   const navigator=repositories.get(args.repo);
   if(!navigator){write(200,rpc(id,answer({error:'Repository not allowed'},true)));return;}
   if(descriptor.name==='sac_job_report'){
    const report=await readSacReport(reportRoutes,args.repo,args.jobId);
    write(200,rpc(id,answer(report)));return;
   }
   let result;
   switch(descriptor.name){
    case 'repo_stats':result=await navigator.stats();break;
    case 'repo_find_files':result=await navigator.find(args);break;
    case 'repo_find_symbols':result=await navigator.symbols(args);break;
    case 'repo_dependencies':result=await navigator.dependencies(args);break;
    case 'repo_read_file':result=await navigator.read(args);break;
    case 'repo_search_text':result=await navigator.search(args);break;
    case 'repo_reindex':result=(await navigator.buildIndex({write:false})).summary;break;
    default:throw Error('Unknown tool');
   }
   write(200,rpc(id,answer(result)));
  }catch(e){write(200,rpc(id,answer({error:e instanceof Error?e.message:'internal tool error'},true)));}
 });
 return {server,start:()=>new Promise((yes,no)=>{
   server.once('error',no);server.listen(port,hostname,()=>{server.removeListener('error',no);yes(server.address());});
  }),close:()=>new Promise((yes,no)=>server.close(e=>e?no(e):yes()))};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 const instance=await createMcpHttpServer({registryFile:process.env.REPO_MCP_REGISTRY_FILE,tokenFile:process.env.REPO_MCP_TOKEN_FILE,
  port:Number(process.env.PORT||DEFAULT_PORT),hostname:process.env.HOST||'0.0.0.0',
  reportsRoot:process.env.REPO_MCP_REPORTS_ROOT||'/srv/sac-reports'});
 await instance.start();
 process.stderr.write('Authenticated code MCP listening (read-only)\n');
}
