import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {readProjects} from './projects.ts';

export type InfrastructureKind='mcp'|'cluster';
export type InfrastructureTopology='single-node'|'regional';
export type InfrastructurePlan={
  id:string;projectSlug:string;name:string;kind:InfrastructureKind;
  replicas:number;topology:InfrastructureTopology;transport:'streamable-http'|null;
  exposure:'private';runtime:'not-provisioned';createdAt:string;updatedAt:string;
};
type Dependencies={
  dataDir:string;
  send:(res:ServerResponse,status:number,data:unknown)=>void;
  body:(req:IncomingMessage)=>Promise<Record<string,unknown>>;
};
const SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID=/^[a-z0-9]+(?:-[a-z0-9]+)*\.(?:mcp|cluster)\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PLANS=32;
const MAX_PER_PROJECT=8;
class RegistryError extends Error{
  readonly status:number;
  constructor(status:number,message:string){super(message);this.status=status;}
}
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const slug=(value:unknown):value is string=>typeof value==='string'&&value.length<=48&&SLUG.test(value);
const topology=(value:unknown):value is InfrastructureTopology=>value==='single-node'||value==='regional';
const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=1&&value<=8;
const revision=(value:unknown):value is string=>
  typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));
const knownFields=(data:Record<string,unknown>,allowed:string[]):boolean=>
  Object.keys(data).every(key=>allowed.includes(key));
function idOf(projectSlug:string,kind:InfrastructureKind,name:string):string{
  return projectSlug+'.'+kind+'.'+name;
}
function fileOf(dataDir:string):string{return join(dataDir,'infrastructure-plans.json');}
function validPlan(value:unknown):value is InfrastructurePlan{
  if(!record(value))return false;
  if(!slug(value['name'])||!slug(value['projectSlug'])||
     (value['kind']!=='mcp'&&value['kind']!=='cluster')||
     !count(value['replicas'])||!topology(value['topology'])||
     value['exposure']!=='private'||value['runtime']!=='not-provisioned'||
     typeof value['createdAt']!=='string'||!Number.isFinite(Date.parse(value['createdAt']))||
     typeof value['updatedAt']!=='string'||!Number.isFinite(Date.parse(value['updatedAt'])))return false;
  if(value['id']!==idOf(value['projectSlug'],value['kind'],value['name']))return false;
  if(value['kind']==='mcp')return value['transport']==='streamable-http'&&
     value['replicas']===1&&value['topology']==='single-node';
  return value['transport']===null;
}
export function readInfrastructurePlans(dataDir:string):InfrastructurePlan[]{
  const path=fileOf(dataDir);
  if(!existsSync(path))return [];
  let value:unknown;
  try{value=JSON.parse(readFileSync(path,'utf8')) as unknown;}
  catch{throw new RegistryError(502,'O cadastro de infraestrutura não pôde ser lido.');}
  if(!Array.isArray(value)||value.length>MAX_PLANS||!value.every(validPlan)||
     new Set(value.map((p:InfrastructurePlan)=>p.id)).size!==value.length)
    throw new RegistryError(502,'O cadastro de infraestrutura está inválido; nenhuma alteração foi feita.');
  return value;
}
function writePlans(dataDir:string,plans:InfrastructurePlan[]):void{
  const temp=join(dataDir,'.infra-'+process.pid+'-'+randomBytes(6).toString('hex')+'.tmp');
  writeFileSync(temp,JSON.stringify(plans,null,2)+'\n',{mode:0o600,flag:'wx'});
  renameSync(temp,fileOf(dataDir));
}
let queue=Promise.resolve();
async function exclusive<T>(work:()=>T|Promise<T>):Promise<T>{
  const prior=queue;
  let release!:()=>void;
  queue=new Promise<void>(resolve=>{release=resolve;});
  await prior;
  try{return await work();}finally{release();}
}
function validConfiguration(input:Record<string,unknown>,kind:InfrastructureKind):boolean{
  if(!count(input['replicas'])||!topology(input['topology']))return false;
  if(kind==='mcp')return input['replicas']===1&&input['topology']==='single-node'&&
    input['transport']==='streamable-http';
  return input['transport']===null;
}
function projectNames(dataDir:string):string[]{return readProjects(dataDir).map(p=>p.slug);}
export async function handleInfrastructureRoute(
  req:IncomingMessage,res:ServerResponse,deps:Dependencies
):Promise<boolean>{
  const path=new URL(req.url||'/','http://panel.local').pathname;
  if(path!=='/infrastructure'&&!path.startsWith('/infrastructure/'))return false;
  const send=(status:number,data:unknown):void=>deps.send(res,status,data);
  try{
    if(path==='/infrastructure'&&req.method==='GET'){
      const projects=projectNames(deps.dataDir);
      const plans=readInfrastructurePlans(deps.dataDir);
      send(200,{projects,plans:plans.map(p=>({...p,projectLinked:projects.includes(p.projectSlug)})),
        capabilities:{configuration:true,provisioning:false,healthMonitoring:false,lifecycle:false},
        limits:{total:MAX_PLANS,perProject:MAX_PER_PROJECT,maxClusterReplicas:8}});
      return true;
    }
    if(path==='/infrastructure'&&req.method==='POST'){
      const input=await deps.body(req);
      if(!record(input)||!knownFields(input,['kind','projectSlug','name','replicas','topology','transport'])||
        (input['kind']!=='mcp'&&input['kind']!=='cluster')||
        !slug(input['projectSlug'])||!slug(input['name'])||
        !validConfiguration(input,input['kind']))
        throw new RegistryError(400,'Configuração inválida. Use projeto vinculado, nome seguro e limites permitidos.');
      const item=await exclusive(()=>{
        const projects=projectNames(deps.dataDir);
        if(!projects.includes(input['projectSlug'] as string))
          throw new RegistryError(404,'Vincule primeiro o projeto no Painel.');
        const plans=readInfrastructurePlans(deps.dataDir);
        const id=idOf(input['projectSlug'] as string,input['kind'] as InfrastructureKind,input['name'] as string);
        if(plans.some(plan=>plan.id===id))throw new RegistryError(409,'Essa configuração já existe.');
        if(plans.length>=MAX_PLANS||plans.filter(plan=>plan.projectSlug===input['projectSlug']).length>=MAX_PER_PROJECT)
          throw new RegistryError(409,'Limite de configurações atingido.');
        const now=new Date().toISOString();
        const plan:InfrastructurePlan={
          id,name:input['name'] as string,kind:input['kind'] as InfrastructureKind,
          projectSlug:input['projectSlug'] as string,replicas:input['replicas'] as number,
          topology:input['topology'] as InfrastructureTopology,
          transport:input['kind']==='mcp'?'streamable-http':null,
          exposure:'private',runtime:'not-provisioned',createdAt:now,updatedAt:now
        };
        writePlans(deps.dataDir,[...plans,plan]);
        return plan;
      });
      send(201,{plan:item,message:'Configuração cadastrada. Nenhum serviço foi provisionado.'});
      return true;
    }
    const match=/^\/infrastructure\/([a-z0-9.-]+)$/.exec(path);
    if(!match||!ID.test(match[1]??''))throw new RegistryError(404,'Configuração não encontrada.');
    const id=match[1] as string;
    if(req.method==='PUT'){
      const input=await deps.body(req);
      if(!record(input)||!knownFields(input,['projectSlug','replicas','topology','transport','expectedUpdatedAt'])||
        !slug(input['projectSlug'])||!revision(input['expectedUpdatedAt']))
        throw new RegistryError(400,'Atualização inválida.');
      const updated=await exclusive(()=>{
        const plans=readInfrastructurePlans(deps.dataDir);
        const current=plans.find(p=>p.id===id);
        if(!current)throw new RegistryError(404,'Configuração não encontrada.');
        if(current.projectSlug!==input['projectSlug'])throw new RegistryError(409,'Projeto diferente do proprietário.');
        if(current.updatedAt!==input['expectedUpdatedAt'])
          throw new RegistryError(409,'Cadastro modificado por outra sessão. Atualize antes de editar.');
        if(!projectNames(deps.dataDir).includes(current.projectSlug))
          throw new RegistryError(409,'Projeto desvinculado. Refaça o vínculo antes de editar.');
        if(!validConfiguration(input,current.kind))throw new RegistryError(400,'Capacidade ou transporte inválido.');
        const plan:InfrastructurePlan={...current,
          replicas:input['replicas'] as number,topology:input['topology'] as InfrastructureTopology,
          // Keep the revision strictly increasing even for writes within one millisecond.
          updatedAt:new Date(Math.max(Date.now(),Date.parse(current.updatedAt)+1)).toISOString()};
        writePlans(deps.dataDir,plans.map(p=>p.id===id?plan:p));
        return plan;
      });
      send(200,{plan:updated,message:'Plano atualizado. Nenhuma alteração foi aplicada na VPS.'});
      return true;
    }
    if(req.method==='DELETE'){
      const input=await deps.body(req);
      if(!record(input)||!knownFields(input,['projectSlug','confirmId','expectedUpdatedAt'])||
         !slug(input['projectSlug'])||!revision(input['expectedUpdatedAt'])||input['confirmId']!==id)
        throw new RegistryError(400,'Digite o identificador completo e informe o projeto proprietário.');
      await exclusive(()=>{
        const plans=readInfrastructurePlans(deps.dataDir);
        const current=plans.find(p=>p.id===id);
        if(!current)throw new RegistryError(404,'Configuração não encontrada.');
        if(current.projectSlug!==input['projectSlug'])throw new RegistryError(409,'Projeto diferente do proprietário.');
        if(current.updatedAt!==input['expectedUpdatedAt'])
          throw new RegistryError(409,'Cadastro modificado por outra sessão. Atualize antes de remover.');
        writePlans(deps.dataDir,plans.filter(p=>p.id!==id));
      });
      send(200,{ok:true,message:'Somente o cadastro foi removido. Nenhum container foi tocado.'});
      return true;
    }
    throw new RegistryError(405,'Método não permitido.');
  }catch(error){
    if(error instanceof RegistryError)send(error.status,{error:error.message});
    else if(error instanceof SyntaxError)send(400,{error:'JSON inválido.'});
    else{
      console.error('Infrastructure registry error:',error instanceof Error?error.message:String(error));
      send(502,{error:'Falha ao acessar o cadastro de infraestrutura.'});
    }
    return true;
  }
}
