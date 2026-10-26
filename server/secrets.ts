import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

type Item = { name: string; category: 'sistema' | 'aplicacao'; label: string; createdAt: string; updatedAt: string };
type Deps = {
  send:(res:ServerResponse,status:number,data:unknown)=>void;
  body:(req:IncomingMessage)=>Promise<Record<string,unknown>>;
  verifyPassword:(password:string)=>boolean;
  enabled?:boolean;
  directory?:string;
};
const NAME=/^[a-z][a-z0-9-]{1,47}$/;
const INDEX='.panel-secret-index.json';
const LIMIT=80;
class SecretError extends Error {
  readonly status:number;
  constructor(status:number,message:string){super(message);this.status=status;}
}
function configured(deps:Deps):boolean {
  return deps.enabled ?? process.env.PANEL_SECRETS_ENABLED==='1';
}
function directory(deps:Deps):string {
  const value=deps.directory ?? process.env.PANEL_SECRETS_DIR ?? '/run/panel-managed-secrets';
  if(!value.startsWith('/run/panel-managed-secrets') && !deps.directory)
    throw new SecretError(503,'Pasta de chaves fora do local reservado do Painel.');
  return value;
}
function checkedDir(deps:Deps):string {
  const dir=directory(deps);
  if(!existsSync(dir))throw new SecretError(503,'A pasta de chaves ainda não foi instalada na VPS.');
  const info=lstatSync(dir);
  if(!info.isDirectory() || info.isSymbolicLink() || (info.mode&0o077)!==0)
    throw new SecretError(503,'A pasta de chaves precisa ser privada (permissão 700).');
  return dir;
}
function readIndex(dir:string):Item[]{
  const path=join(dir,INDEX);
  if(!existsSync(path))return [];
  const f=lstatSync(path);
  if(!f.isFile()||f.isSymbolicLink()||(f.mode&0o077)!==0)throw new SecretError(503,'Índice das chaves com permissões incorretas.');
  const v:unknown=JSON.parse(readFileSync(path,'utf8'));
  if(!Array.isArray(v)||v.length>LIMIT||!v.every((x:unknown)=>{
    if(!x||typeof x!=='object')return false;
    const a=x as Item;
    return NAME.test(a.name)&&['sistema','aplicacao'].includes(a.category)&&
      typeof a.label==='string'&&a.label.length<=80&&
      typeof a.createdAt==='string'&&typeof a.updatedAt==='string';
  }))throw new SecretError(503,'Índice de chaves inválido; verifique antes de alterar.');
  return v as Item[];
}
function atomic(dir:string,name:string,value:string):void {
  const target=join(dir,name);
  const tmp=join(dir,'.panel-tmp-'+randomBytes(12).toString('hex'));
  let fd:number|undefined;
  try{
    fd=openSync(tmp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    writeSync(fd,value);fsyncSync(fd);closeSync(fd);fd=undefined;
    renameSync(tmp,target);
  }finally{
    if(fd!==undefined)closeSync(fd);
    if(existsSync(tmp))unlinkSync(tmp);
  }
}
function list(dir:string):Array<Item & {installed:boolean;sizeBytes:number}>{
  const index=readIndex(dir);
  const map=new Map(index.map(e=>[e.name,e]));
  const names=readdirSync(dir).filter(x=>NAME.test(x)&&x!==INDEX);
  const all=new Set([...names,...map.keys()]);
  return [...all].sort().map(name=>{
    const path=join(dir,name);
    let installed=false,sizeBytes=0;
    if(existsSync(path)){
      const data=lstatSync(path);
      if(data.isSymbolicLink()||!data.isFile()||(data.mode&0o077)!==0)
        throw new SecretError(503,'Um arquivo de chave tem permissões incorretas. Corrija na VPS.');
      installed=true;sizeBytes=data.size;
    }
    const item=map.get(name)||{
      name,category:'sistema' as const,label:name,createdAt:'',updatedAt:''
    };
    return {...item,installed,sizeBytes};
  });
}
const validValue=(x:unknown):x is string=>typeof x==='string' && x.length>=4 &&
  Buffer.byteLength(x,'utf8')<=8192 && !/[\u0000-\u001f\u007f]/.test(x) &&
  x.trim()===x;
export async function handleSecretsRoute(req:IncomingMessage,res:ServerResponse,deps:Deps):Promise<boolean>{
  const path=new URL(req.url||'/','http://panel.local').pathname;
  const match=/^\/secrets(?:\/([a-z0-9-]+))?$/.exec(path);
  if(!match)return false;
  const send=(status:number,value:unknown)=>deps.send(res,status,value);
  const enabled=configured(deps);
  try{
    if(req.method==='GET' && !match[1]){
      if(!enabled)return send(200,{enabled:false,entries:[],connections:[]}),true;
      const dir=checkedDir(deps);
      const registered=list(dir);
      const paths=[
        {id:'github',label:'GitHub (builds)',file:process.env.PANEL_GITHUB_TOKEN_FILE},
        {id:'ghcr',label:'GHCR (imagens privadas)',file:process.env.PANEL_GHCR_TOKEN_FILE}
      ];
      const connections=paths.map(x=>({
        id:x.id,label:x.label,
        configured:typeof x.file==='string'&&x.file.length>0&&existsSync(x.file),
        managed:typeof x.file==='string'&&x.file.startsWith(dir+'/')
      }));
      return send(200,{enabled:true,entries:registered,connections,
        note:'Chaves cadastradas ficam em arquivos privados na VPS; a aplicação precisa apontar para o arquivo e recarregar a configuração para usá-lo.'}),true;
    }
    if(!enabled)throw new SecretError(403,'Gerenciamento de chaves ainda não habilitado na VPS.');
    const dir=checkedDir(deps);
    if(req.method==='POST'&&!match[1]){
      const value=await deps.body(req);
      if(Object.keys(value).sort().join(',')!=='category,label,name,password,value'||
        typeof value.name!=='string'||!NAME.test(value.name)||value.name.startsWith('panel-')||
        !['sistema','aplicacao'].includes(String(value.category))||
        typeof value.label!=='string'||value.label.trim().length<2||value.label.length>80||
        !validValue(value.value))
        throw new SecretError(400,'Informe nome, categoria, descrição e chave válidos. A chave não pode conter quebra de linha.');
      if(typeof value.password!=='string'||value.password.length>256||!deps.verifyPassword(value.password))
        throw new SecretError(403,'Senha administrativa inválida ou acesso temporariamente bloqueado.');
      const name=value.name, entries=readIndex(dir);
      const old=list(dir).find(e=>e.name===name);
      if(!old&&list(dir).length>=LIMIT)throw new SecretError(409,'Limite de chaves atingido.');
      const file=join(dir,name);
      if(existsSync(file)){
        const existing=lstatSync(file);
        if(!existing.isFile()||existing.isSymbolicLink()||(existing.mode&0o077)!==0)
          throw new SecretError(409,'Arquivo já existe, mas suas permissões não permitem atualização.');
      }
      const now=new Date().toISOString();
      const item:Item={name,category:value.category as Item['category'],
        label:value.label.trim(),createdAt:old?.createdAt||now,updatedAt:now};
      // The file is placed directly in the host-mounted folder, never in GitHub or frontend storage.
      atomic(dir,name,value.value);
      atomic(dir,INDEX,JSON.stringify([...entries.filter(x=>x.name!==name),item],null,2)+'\n');
      console.log(JSON.stringify({event:old?'panel_secret_rotated':'panel_secret_created',name,at:now}));
      return send(old?200:201,{ok:true,name,updatedAt:now,
        message:'Chave gravada na VPS. Para usá-la, conecte o arquivo ao serviço desejado e recarregue esse serviço.'}),true;
    }
    if(req.method==='DELETE'&&match[1]&&NAME.test(match[1])){
      const input=await deps.body(req);
      if(Object.keys(input).sort().join(',')!=='confirm,password'||
        input.confirm!==match[1]||typeof input.password!=='string'||
        input.password.length>256||!deps.verifyPassword(input.password))
        throw new SecretError(403,'Confirme o nome da chave e sua senha administrativa.');
      const names=list(dir);
      if(!names.some(x=>x.name===match[1]))throw new SecretError(404,'Chave não encontrada.');
      const file=join(dir,match[1]);
      if(existsSync(file))unlinkSync(file);
      atomic(dir,INDEX,JSON.stringify(readIndex(dir).filter(x=>x.name!==match[1]),null,2)+'\n');
      console.log(JSON.stringify({event:'panel_secret_removed',name:match[1],at:new Date().toISOString()}));
      return send(200,{ok:true,message:'Arquivo da chave removido na VPS. Serviços que já carregaram a chave podem precisar ser reiniciados.'}),true;
    }
    throw new SecretError(405,'Método não permitido.');
  }catch(e){
    if(e instanceof SecretError)return send(e.status,{error:e.message}),true;
    console.error('Panel key manager operation failed:',e instanceof Error?e.name:'unknown');
    return send(503,{error:'Não foi possível consultar ou alterar os arquivos de chaves na VPS.'}),true;
  }
}
