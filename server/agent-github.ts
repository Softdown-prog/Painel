/** Account-wide repository discovery, separate from Docker/deploy permissions. */
import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {github,githubArchive,validRef} from './github.ts';
export const agentRepository=(s:unknown):s is string=>typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(s)&&!['.','..'].includes(s.split('/')[1]!);
type Scope={mode:'account';owner:string;userId:number};
type Deps={dataDir:string;git?:typeof github;archive?:typeof githubArchive;
 bridge:(path:string,method?:string,body?:object)=>Promise<any>;
 upload?:(response:Response,meta:Record<string,string>)=>Promise<any>};
export class AgentGitHub {
 private file:string;private busy=false;
 private readonly d:Deps;
 constructor(d:Deps){this.d=d;this.file=join(d.dataDir,'agent-github-scope.json');}
 private scope():Scope|null{return existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')):null;}
 allows(repository:string):boolean{const s=this.scope();return s?.mode==='account'&&agentRepository(repository)&&repository.split('/')[0]!.toLowerCase()===s.owner.toLowerCase();}
 async identity(){const user=await(this.d.git??github)('/user');
  if(!Number.isSafeInteger(user?.id)||user.id<1||!agentRepository(user.login+'/repo'))throw Error('Conta GitHub não confirmada.');
  return {owner:String(user.login),userId:Number(user.id)};
 }
 async check(){const user=await this.identity(),s=this.scope();
  return {mode:s?.mode??'registered',owner:user.owner,active:!!s&&s.userId===user.userId&&s.owner.toLowerCase()===user.owner.toLowerCase()};}
 async enable(input:Record<string,unknown>){
  if(Object.keys(input).join(',')!=='mode'||!['account','registered'].includes(String(input['mode'])))throw Error('Autorização inválida.');
  const user=await this.identity();
  const value=input['mode']==='account'?{mode:'account',...user}:{mode:'registered'};
  writeFileSync(this.file+'.tmp',JSON.stringify(value),{mode:0o600});renameSync(this.file+'.tmp',this.file);
  return this.check();
 }
 async assertAccount(){if(!(await this.check()).active)throw Error('Autorize a conta GitHub conectada primeiro.');}
 async list(page=1){
  if(!Number.isInteger(page)||page<1||page>50)throw Error('Página inválida.');
  await this.assertAccount();const data=await(this.d.git??github)('/user/repos?affiliation=owner&sort=full_name&per_page=100&page='+page);
  if(!Array.isArray(data))throw Error('Resposta GitHub inválida.');
  const repositories=data.filter(r=>agentRepository(r.full_name)&&this.allows(r.full_name)&&validRef(r.default_branch)).map(r=>({
   fullName:r.full_name,branch:r.default_branch,private:r.private===true,readOnly:r.permissions?.push!==true}));
  return {repositories,page,hasMore:data.length===100};
 }
 async resolve(repository:unknown){
  if(!agentRepository(repository)||!this.allows(repository))throw Error('Repositório fora da conta autorizada.');
  await this.assertAccount();const repo=await(this.d.git??github)('/repos/'+repository);
  if(!agentRepository(repo?.full_name)||!this.allows(repo.full_name)||repo.full_name.toLowerCase()!==repository.toLowerCase()||!Number.isSafeInteger(repo.id)||repo.id<1||!validRef(repo.default_branch))throw Error('Repositório indisponível.');
  return repo;
 }
 async prepare(input:Record<string,unknown>){
  if(Object.keys(input).some(k=>!['repository','branch'].includes(k)))throw Error('Seleção inválida.');
  if(this.busy)throw Error('Outra cópia está em preparação.');this.busy=true;
  try{
   const repo=await this.resolve(input['repository']),branch=input['branch']??repo.default_branch;
   if(!validRef(branch))throw Error('Branch inválida.');
   const project='gh_'+repo.id+'_'+createHash('sha256').update(branch).digest('hex').slice(0,8);
   const existing=(await this.d.bridge('/workspaces')).workspaces?.[project];
   if(existing){if(existing.repository!==repo.full_name||existing.branch!==branch)throw Error('Cópia divergente.');return {...existing,project,reused:true};}
   const commit=await(this.d.git??github)('/repos/'+repo.full_name+'/commits/'+encodeURIComponent(branch));
   if(!/^[a-f0-9]{40}$/.test(commit?.sha))throw Error('Revisão não confirmada.');
   const archive=await(this.d.archive??githubArchive)(repo.full_name,commit.sha);
   if(!this.d.upload){await archive.body?.cancel();throw Error('Importação ainda não disponível.');}
   const meta={project,repository:repo.full_name,branch,sourceSha:commit.sha};
   return {...await this.d.upload(archive,meta),...meta,reused:false};
  }finally{this.busy=false;}
 }
}
