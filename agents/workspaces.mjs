/** Trusted bridge import. No credentials, repo hooks, build or install scripts. */
import {mkdtempSync,readFileSync,writeFileSync,renameSync,existsSync,readdirSync,lstatSync,chmodSync,rmSync,createWriteStream} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
export const MAX_ARCHIVE=32*1024*1024,MAX_SOURCE=128*1024*1024;
const SLUG=/^gh_[1-9][0-9]{0,17}_[a-f0-9]{8}$/;
const REPO=/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
const REF=/^(?!\/|.*\.\.)(?!.*\/\/)[A-Za-z0-9_./-]{1,100}$/;
const gitEnv=()=>({PATH:process.env.PATH,LANG:'C.UTF-8',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'});
const run=(cmd,args,cwd)=>execFileSync(cmd,args,{cwd,env:gitEnv(),encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe']});
export function validateArchiveListing(names,verbose){
 const paths=names.trimEnd().split('\n'),rows=verbose.trimEnd().split('\n');
 if(!names||paths.length>8000||paths.length!==rows.length)throw Error('Arquivo grande ou inválido.');
 let prefix=null,total=0;const seen=new Set();
 for(let i=0;i<paths.length;i++){
  const path=paths[i].replace(/\/$/,'');const parts=path.split('/');
  if(!path||path.length>300||/[\\\x00-\x1f\x7f]/.test(path)||parts.some(x=>!x||x==='.'||x==='..'||x.toLowerCase()==='.git')||seen.has(path))throw Error('Caminho não autorizado.');
  seen.add(path);prefix??=parts[0];if(parts[0]!==prefix)throw Error('Raiz do arquivo inválida.');
  const row=/^([d-])[rwxStTs-]{9}\s+\d+\/\d+\s+(\d+)\s/.exec(rows[i]);
  if(!row)throw Error('Links e arquivos especiais não são aceitos.');
  const size=Number(row[2]);if(!Number.isSafeInteger(size)||size<0||(total+=size)>MAX_SOURCE)throw Error('Cópia excede 128 MiB.');
 }
 return {count:paths.length,bytes:total};
}
export class Workspaces {
 constructor(workspace,stateDir){this.workspace=workspace;this.stateDir=stateDir;this.file=join(stateDir,'workspace-origins.json');this.busy=false;}
 list(){return existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')):{};}
 origin(project){return this.list()[project];}
 async receive(stream,meta){
  if(this.busy)throw Error('Outra cópia está em preparação.');
  if(!SLUG.test(meta.project??'')||!REPO.test(meta.repository??'')||!REF.test(meta.branch??'')||meta.branch.endsWith('/')||!/^[a-f0-9]{40}$/.test(meta.sourceSha??''))throw Error('Origem inválida.');
  const destination=join(this.workspace,meta.project),origins=this.list();
  if(existsSync(destination))throw Error('Cópia existente preservada; use a conversa do projeto.');
  if(Object.keys(origins).length>=32)throw Error('Limite de 32 cópias atingido.');
  this.busy=true;let temp,staging,installed=false;
  try{
   temp=mkdtempSync(join(this.stateDir,'import-'));
   const archive=join(temp,'source.tgz');let bytes=0;
   const limit=new Transform({transform(chunk,_e,done){bytes+=chunk.length;done(bytes>MAX_ARCHIVE?Error('Arquivo excede 32 MiB.'):null,chunk);}});
   await pipeline(stream,limit,createWriteStream(archive,{mode:0o600,flags:'wx'}));
   const names=run('tar',['-tzf',archive,'--quoting-style=escape'],temp);
   const details=run('tar',['-tzvf',archive,'--numeric-owner','--quoting-style=escape'],temp);
   validateArchiveListing(names,details);
   // /state and /workspace are separate Docker mounts, even on the same host
   // disk. Stage beside the destination so the final rename remains atomic.
   // Dot-prefixed staging is not a registered project; model permissions deny
   // the workspace parent and allow only its selected project directory.
   const root=staging=mkdtempSync(join(this.workspace,'.import-'));
   run('tar',['-xzf',archive,'--strip-components=1','--no-same-owner','--no-same-permissions','-C',root],temp);
   function secure(dir){for(const item of readdirSync(dir,{withFileTypes:true})){
    const path=join(dir,item.name),stat=lstatSync(path);
    if(stat.isDirectory()){chmodSync(path,0o700);secure(path);}
    else if(stat.isFile())chmodSync(path,stat.mode&0o111?0o700:0o600);
    else throw Error('Arquivo especial recusado.');
   }}secure(root);
   const git=args=>run('git',['-c','core.hooksPath=/dev/null','-c','core.attributesFile=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgsign=false',...args],root);
   git(['init','--template=','--initial-branch=main']);
   git(['config','core.hooksPath','/dev/null']);git(['config','core.autocrlf','false']);
   git(['remote','add','origin','https://github.com/'+meta.repository+'.git']);
   git(['add','--all','--force']);git(['-c','user.name=Painel Codex','-c','user.email=codex@panel.invalid','commit','--allow-empty','-m','Snapshot autorizado '+meta.sourceSha]);
   const localBase=git(['rev-parse','HEAD']).trim();
   renameSync(root,destination);installed=true;
   origins[meta.project]={...meta,localBase};
   writeFileSync(this.file+'.tmp',JSON.stringify(origins),{mode:0o600});renameSync(this.file+'.tmp',this.file);
   return {project:meta.project,repository:meta.repository,branch:meta.branch,sourceSha:meta.sourceSha};
  }catch(error){if(installed)rmSync(destination,{recursive:true,force:true});throw error;}
  finally{this.busy=false;if(staging)rmSync(staging,{recursive:true,force:true});
   if(temp)rmSync(temp,{recursive:true,force:true});}
 }
}
