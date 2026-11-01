#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import {RepoNavigator} from './indexer.mjs';

const navigator=new RepoNavigator(resolve(process.env.REPO_MCP_ROOT||process.cwd()),{
 writable:process.env.REPO_MCP_ALLOW_WRITE==='1'
});
const object={type:'object',additionalProperties:false};
const schema=(properties,required=[])=>({...object,properties,required});
const pathProp={type:'string',minLength:1,maxLength:512,description:'Caminho relativo à raiz do repositório'};
const queryProp={type:'string',minLength:1,maxLength:200};
const prefixProp={type:'string',maxLength:250};
const limitProp={type:'integer',minimum:1,maximum:100,default:40};
const tools=[
 {name:'repo_stats',description:'Resumo do índice, quantidade de arquivos/símbolos e política de escrita.',
  inputSchema:schema({})},
 {name:'repo_reindex',description:'Atualiza índice local de código (sem commits nem deploy).',
  inputSchema:schema({})},
 {name:'repo_find_files',description:'Encontra arquivos por trecho do caminho e prefixo de pasta.',
  inputSchema:schema({query:{type:'string',maxLength:160},prefix:prefixProp,limit:limitProp})},
 {name:'repo_find_symbols',description:'Busca declarações de funções, classes, tipos e outras definições com linha.',
  inputSchema:schema({query:queryProp,prefix:prefixProp,limit:limitProp},['query'])},
 {name:'repo_dependencies',description:'Exibe imports, dependências locais e importadores de um arquivo.',
  inputSchema:schema({path:pathProp},['path'])},
 {name:'repo_read_file',description:'Lê trecho numerado com SHA-256 para edições sem sobrescrever trabalho alheio.',
  inputSchema:schema({path:pathProp,startLine:{type:'integer',minimum:1},endLine:{type:'integer',minimum:0}},['path'])},
 {name:'repo_search_text',description:'Procura texto em arquivos indexados, limita resultados e volume de leitura.',
  inputSchema:schema({query:queryProp,prefix:prefixProp,caseSensitive:{type:'boolean'},limit:limitProp},['query'])},
 {name:'repo_replace_text',description:'Prévia ou substituição com SHA-256 prévio; escrita exige opt-in explícito fora do Actions. Não faz commit.',
  inputSchema:schema({
    path:pathProp,expectedSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},
    oldText:{type:'string',minLength:1,maxLength:20000},newText:{type:'string',maxLength:20000},
    replaceAll:{type:'boolean',default:false},dryRun:{type:'boolean',default:true}
  },['path','expectedSha256','oldText','newText'])}
];
const handlers={
 repo_stats:()=>navigator.stats(),
 repo_reindex:async()=>{const i=await navigator.buildIndex();return {summary:i.summary,generatedAt:i.generatedAt};},
 repo_find_files:a=>navigator.find(a),
 repo_find_symbols:a=>navigator.symbols(a),
 repo_dependencies:a=>navigator.dependencies(a),
 repo_read_file:a=>navigator.read(a),
 repo_search_text:a=>navigator.search(a),
 repo_replace_text:a=>navigator.replace(a)
};
function argumentsValid(input,descriptor){
 if(input===undefined)return descriptor.inputSchema.required.length===0;
 if(!input||typeof input!=='object'||Array.isArray(input))return false;
 const properties=descriptor.inputSchema.properties,keys=Object.keys(input);
 if(keys.some(k=>!(k in properties)))return false;
 for(const k of descriptor.inputSchema.required)if(!(k in input))return false;
 for(const k of keys){
   const v=input[k],p=properties[k];
   if(p.type==='string'&&(typeof v!=='string'||v.length<(p.minLength??0)||v.length>(p.maxLength??Infinity)||p.pattern&&!new RegExp(p.pattern).test(v)))return false;
   if(p.type==='integer'&&(!Number.isSafeInteger(v)||v<(p.minimum??-Infinity)||v>(p.maximum??Infinity)))return false;
   if(p.type==='boolean'&&typeof v!=='boolean')return false;
 }
 return true;
}
function result(value,isError=false){
 return {content:[{type:'text',text:JSON.stringify(value)}],isError};
}
function failure(id,code,message){return {jsonrpc:'2.0',id,error:{code,message}};}
function response(id,result){return {jsonrpc:'2.0',id,result};}
const supported=['2025-11-25','2025-06-18','2024-11-05'];
async function handle(request){
 if(!request||request.jsonrpc!=='2.0'||typeof request.method!=='string')return failure(request?.id??null,-32600,'Invalid request');
 if(!Object.hasOwn(request,'id'))return null; // JSON-RPC notification, no response
 const id=request.id;
 if(id===null||typeof id!=='number'&&typeof id!=='string')return failure(null,-32600,'Invalid id');
 try{
   switch(request.method){
     case 'initialize':{
       const version=request.params?.protocolVersion;
       return response(id,{protocolVersion:supported.includes(version)?version:supported[0],
         capabilities:{tools:{listChanged:false}},
         serverInfo:{name:'painel-code-navigator',version:'1.0.0'},
         instructions:'Acesso exclusivo ao checkout local. Actions gera um artefato, não hospeda um endpoint permanente. A edição nunca faz commit; escrita desabilitada por padrão.'});
     }
     case 'ping':return response(id,{});
     case 'tools/list':{
       const cursor=request.params?.cursor;
       if(cursor!==undefined)return failure(id,-32602,'Cursor inválido');
       return response(id,{tools});
     }
     case 'tools/call':{
       const name=request.params?.name;
       const descriptor=tools.find(t=>t.name===name);
       if(!descriptor)return failure(id,-32602,'Ferramenta MCP desconhecida.');
       const args=request.params?.arguments??{};
       if(!argumentsValid(args,descriptor))return response(id,result({error:'Argumentos inválidos para '+name},true));
       try{return response(id,result(await handlers[name](args)));}
       catch(e){return response(id,result({error:e instanceof Error?e.message:'Falha na ferramenta'},true));}
     }
     default:return failure(id,-32601,'Method not found');
   }
 }catch(e){return failure(id,-32603,e instanceof Error?e.message:'Internal error');}
}
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',line=>{
 if(Buffer.byteLength(line)>1024*1024){
   process.stdout.write(JSON.stringify(failure(null,-32700,'Request too large'))+'\n');return;
 }
 let request;
 try{request=JSON.parse(line);}
 catch{process.stdout.write(JSON.stringify(failure(null,-32700,'Parse error'))+'\n');return;}
 void handle(request).then(out=>{
   if(out!==null)process.stdout.write(JSON.stringify(out)+'\n');
 }).catch(e=>{
   process.stderr.write('MCP internal failure: '+(e instanceof Error?e.message:'unknown')+'\n');
 });
});
process.stderr.write('Painel code navigator MCP ready (stdio; no public listener)\n');
