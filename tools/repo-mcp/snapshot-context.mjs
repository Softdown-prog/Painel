#!/usr/bin/env node
/**
 * Build a bounded, text-only Code MCP snapshot from four authorized public
 * GitHub checkouts. Nothing is fetched, compiled, executed or deployed.
 * Reports are intentionally NOT packaged into the image.
 */
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir,lstat,realpath,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename,dirname,extname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

export const SNAPSHOT_PROJECTS=Object.freeze([
 {name:'Painel',repository:'Softdown-prog/Painel',source:'.'},
 {name:'Data_libray',repository:'Softdown-prog/Data_libray',source:'sources/Data_libray'},
 {name:'Terrania',repository:'Softdown-prog/Terrania',source:'sources/Terrania'},
 {name:'A7-forge-2D-',repository:'Softdown-prog/A7-forge-2D-',source:'sources/A7-forge-2D-'}
]);
const EXCLUDED=new Set(['.git','.repo-mcp','.secrets','.cloudflare','.wrangler',
 '.angular','node_modules','dist','build','coverage','__pycache__','.next',
 '.cache','vendor','target','.venv','venv','tmp','temp']);
const EXT=new Set(['.ts','.tsx','.js','.jsx','.mjs','.cjs','.mts','.cts',
 '.json','.jsonc','.md','.css','.scss','.html','.yml','.yaml','.toml',
 '.xml','.py','.go','.rs','.sh','.bash','.sql','.txt','.vue','.svelte',
 '.c','.cc','.cpp','.h','.hpp','.cs','.java','.rb','.php','.graphql','.proto']);
const SPECIAL=new Set(['Dockerfile','Makefile','Caddyfile','AGENTS.md']);
const SECRET=/(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx|crt)|.*(?:secret|credential|token|password).*\.json)$/i;
const PER_REPO_MAX=24*1024*1024, TOTAL_MAX=64*1024*1024, FILE_MAX=1024*1024, MAX_FILES=30000;
const invalid=()=>{throw Error('MCP snapshot source or output rejected');};
const git=(cwd,...args)=>{
 const p=spawnSync('git',args,{cwd,encoding:'utf8',shell:false,timeout:20000,
  maxBuffer:12*1024*1024,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1'}});
 if(p.error||p.status!==0||p.signal)invalid();
 return p.stdout.trim();
};
const allowed=filename=>{
 if(typeof filename!=='string'||filename.length>512||!filename||
  filename.includes('\\')||filename.includes('\0')||filename.startsWith('/')||
  filename.split('/').some(part=>!part||part==='.'||part==='..'||EXCLUDED.has(part)||
    (part.startsWith('.')&&part!=='.github')))return false;
 if(SECRET.test(filename))return false;
 return SPECIAL.has(basename(filename))||EXT.has(extname(filename));
};
const originMatches=(remote,expected)=>{
 const match=remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\s*$/i);
 return !!match&&match[1].toLowerCase()===expected.toLowerCase();
};
async function normalFile(root,rel){
 let current=root;
 for(const component of rel.split('/')){
  current=join(current,component);
  const st=await lstat(current);
  if(st.isSymbolicLink())return null;
 }
 const st=await lstat(current);
 return st.isFile()&&st.size>0&&st.size<=FILE_MAX?current:null;
}
export async function prepareMcpSnapshotContext({workspace,output}){
 if(typeof workspace!=='string'||typeof output!=='string'||!isAbsolute(output))invalid();
 const root=resolve(workspace),out=resolve(output);
 if(out===root||out.startsWith(root+sep))invalid();
 if(await realpath(root)!==root)invalid();
 let created=false;
 try{
  await mkdir(out);created=true;
  await mkdir(join(out,'repos'));
  await mkdir(join(out,'tools','repo-mcp'),{recursive:true});
  const repos=[];
  let total=0;
  for(const entry of SNAPSHOT_PROJECTS){
   const source=resolve(root,entry.source);
   if(source!==root&&!source.startsWith(root+sep))invalid();
   if(await realpath(source)!==source)invalid();
   if(resolve(git(source,'rev-parse','--show-toplevel'))!==source)invalid();
   if(!originMatches(git(source,'remote','get-url','origin'),entry.repository))invalid();
   const sha=git(source,'rev-parse','HEAD');
   if(!/^[a-f0-9]{40}$/.test(sha))invalid();
   // No tracked changes may be silently packaged instead of the proven SHA.
   const diff=spawnSync('git',['diff','--quiet','HEAD','--'],{
    cwd:source,timeout:20000,shell:false,stdio:'ignore'});
   if(diff.error||diff.status!==0)invalid();
   const tracked=git(source,'ls-files','-z','--cached').split('\0').filter(Boolean);
   if(tracked.length>MAX_FILES)invalid();
   let files=0,bytes=0,ignored=0;
   for(const filename of tracked){
    if(!allowed(filename)){ignored++;continue;}
    let full;
    try{full=await normalFile(source,filename);}catch(e){
     if(e?.code==='ENOENT'){ignored++;continue;}throw e;
    }
    if(!full){ignored++;continue;}
    const content=await readFile(full,{flag:'r'});
    if(content.includes(0)){ignored++;continue;}
    // Reject non-UTF8 snapshots rather than replacing bytes silently.
    try{new TextDecoder('utf-8',{fatal:true}).decode(content);}
    catch{ignored++;continue;}
    bytes+=content.length;total+=content.length;files++;
    if(bytes>PER_REPO_MAX||total>TOTAL_MAX)invalid();
    const dest=join(out,'repos',entry.name,filename);
    await mkdir(dirname(dest),{recursive:true});
    await writeFile(dest,content,{flag:'wx',mode:0o444});
   }
   if(files<1)invalid();
   repos.push({name:entry.name,repository:entry.repository,source_sha:sha,
    files,bytes,ignored});
  }
  for(const name of ['indexer.mjs','http-server.mjs','sac-report-router.mjs']){
   const source=join(root,'tools','repo-mcp',name);
   const content=await readFile(source);
   if(!content.length||content.length>FILE_MAX)invalid();
   await writeFile(join(out,'tools','repo-mcp',name),content,{flag:'wx',mode:0o444});
  }
  const registry={repos:repos.map(r=>({name:r.name,path:'/srv/repos/'+r.name}))};
  await writeFile(join(out,'registry.json'),JSON.stringify(registry)+'\n',{flag:'wx',mode:0o444});
  const provenance={schema_version:1,mode:'read-only-source-snapshots',
   reports_included:false,broker_required:false,deploy_authorized:false,
   repos,bytes:total};
  await writeFile(join(out,'snapshot-manifest.json'),
   JSON.stringify(provenance,null,2)+'\n',{flag:'wx',mode:0o444});
  return provenance;
 }catch(e){
  if(created)await rm(out,{recursive:true,force:true});
  throw e;
 }
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
 try{
  if(process.argv.length!==3)invalid();
  const report=await prepareMcpSnapshotContext({
   workspace:process.cwd(),output:process.argv[2]
  });
  // Public only: project names, exact SHA, file counts. No source text.
  process.stdout.write(JSON.stringify(report)+'\n');
 }catch{
  console.error('MCP snapshot preparation failed (no output published)');
  process.exitCode=1;
 }
}
