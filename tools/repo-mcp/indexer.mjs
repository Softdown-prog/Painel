import {createHash} from 'node:crypto';
import {readdir,readFile,lstat,mkdir,rename,writeFile,rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep,extname} from 'node:path';

const EXCLUDED=new Set(['.git','.repo-mcp','.secrets','.cloudflare','.wrangler','.angular','node_modules','dist','build','coverage','__pycache__','.next','.cache','vendor','target','.venv','venv']);
const TEXT_EXT=new Set(['.ts','.tsx','.js','.jsx','.mjs','.cjs','.mts','.cts','.json','.jsonc','.md','.css','.scss','.html','.yml','.yaml','.toml','.xml','.py','.go','.rs','.sh','.bash','.sql','.txt','.vue','.svelte','.c','.cc','.cpp','.h','.hpp','.cs','.java','.rb','.php','.graphql','.proto']);
const SPECIAL=new Set(['Dockerfile','Makefile','Caddyfile','.gitignore','AGENTS.md']);
const SECRET=/(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx|crt)|.*(?:secret|credential|token|password).*\.json)$/i;
const MAX_INDEX_FILES=50000,MAX_FILE=1024*1024,MAX_SCAN_BYTES=32*1024*1024;
const hash=b=>createHash('sha256').update(b).digest('hex');
const slash=s=>s.split(sep).join('/');
function accepted(p){
  const parts=p.split('/');
  if(parts.some(part=>EXCLUDED.has(part)))return false;
  if(SECRET.test(p))return false;
  const name=parts.at(-1)??'';
  return SPECIAL.has(name)||TEXT_EXT.has(extname(name))||p.startsWith('.github/workflows/')&&/\.ya?ml$/.test(p);
}
function publicPath(p){
  if(typeof p!=='string'||!p||p.length>512||p.includes('\\')||p.includes('\0')||
     isAbsolute(p)||p.startsWith('/')||p.split('/').some(x=>x===''||x==='.'||x==='..'))
    throw Error('Caminho deve ser relativo, sem atalhos ou travessia.');
  if(!accepted(p))throw Error('Arquivo fora das extensões permitidas ou protegido.');
  return p;
}
export class RepoNavigator{
  constructor(root,{indexFile='.repo-mcp/index.json',writable=false}={}){
    this.root=resolve(root);
    this.indexFile=resolve(this.root,indexFile);
    if(!this.indexFile.startsWith(this.root+sep))throw Error('Índice deve permanecer no repositório.');
    this.writable=writable&&process.env.GITHUB_ACTIONS!=='true';
    this.cached=null;
    this.indexMtime=0;
  }
  async safeFile(p){
    publicPath(p);
    const full=resolve(this.root,p);
    if(!full.startsWith(this.root+sep))throw Error('Caminho fora do repositório.');
    let part=this.root;
    for(const piece of p.split('/')){
      part=join(part,piece);
      const stat=await lstat(part);
      if(stat.isSymbolicLink())throw Error('Links simbólicos não são permitidos.');
    }
    const stat=await lstat(full);
    if(!stat.isFile()||stat.size>MAX_FILE)throw Error('Arquivo não é texto permitido ou excede 1 MiB.');
    return full;
  }
  async walk(){
    const paths=[];
    const visit=async (directory,prefix)=>{
      const entries=(await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'));
      for(const e of entries){
        if(paths.length>=MAX_INDEX_FILES)throw Error('Limite de 50 mil arquivos excedido.');
        const p=prefix?prefix+'/'+e.name:e.name;
        if(e.isSymbolicLink())continue;
        if(e.isDirectory()){
          if(!EXCLUDED.has(e.name)&&!e.name.startsWith('.repo-mcp'))await visit(join(directory,e.name),p);
        }else if(e.isFile()&&accepted(p))paths.push(p);
      }
    };
    await visit(this.root,'');
    return paths;
  }
  inspect(path,buffer){
    if(buffer.includes(0))return null;
    const text=buffer.toString('utf8');
    if(text.includes('\ufffd'))return null;
    const lines=text.split(/\r?\n/);
    const symbols=[],imports=[];
    const symbolRx=/^\s*(?:(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|struct|trait|impl|fn|def|func|package)\s+([A-Za-z_$][\w$]*)|(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*))/;
    const importRx=/(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s*|\buse\s+|\bmod\s+)[('"]?([@./\w-][@\w./-]*)['")\s;]?/g;
    for(let i=0;i<lines.length;i++){
      const line=lines[i]??'';
      if(symbols.length<160){
        const match=line.match(symbolRx);
        if(match)symbols.push({name:match[1]??match[2],line:i+1});
      }
      if(imports.length<160){
        importRx.lastIndex=0;
        for(const m of line.matchAll(importRx)){
          if(m[1]&&!imports.includes(m[1]))imports.push(m[1]);
          if(imports.length>=160)break;
        }
      }
    }
    return {path,bytes:buffer.length,sha256:hash(buffer),lines:lines.length,symbols,imports};
  }
  async buildIndex({write=true}={}){
    const files=[];
    for(const p of await this.walk()){
      try{
        const full=await this.safeFile(p);
        const buffer=await readFile(full);
        const entry=this.inspect(p,buffer);
        if(entry)files.push(entry);
      }catch(e){if(e?.code!=='ENOENT'&&e?.code!=='EACCES')throw e;}
    }
    const index={schema:1,generatedAt:new Date().toISOString(),files,
      summary:{fileCount:files.length,symbolCount:files.reduce((n,f)=>n+f.symbols.length,0),
        importCount:files.reduce((n,f)=>n+f.imports.length,0),
        bytesIndexed:files.reduce((n,f)=>n+f.bytes,0)}};
    if(write){
      await mkdir(resolve(this.indexFile,'..'),{recursive:true});
      const tmp=this.indexFile+'.'+process.pid+'.tmp';
      await writeFile(tmp,JSON.stringify(index)+'\n',{mode:0o600});
      await rename(tmp,this.indexFile);
    }
    this.cached=index;
    return index;
  }
  async index(){
    if(this.cached)return this.cached;
    try{
      const loaded=JSON.parse(await readFile(this.indexFile,'utf8'));
      if(loaded?.schema===1&&Array.isArray(loaded.files)&&loaded.summary?.fileCount===loaded.files.length){
        this.cached=loaded;return loaded;
      }
    }catch{}
    return this.buildIndex();
  }
  async stats(){const i=await this.index();return {...i.summary,generatedAt:i.generatedAt,readOnly:!this.writable};}
  async find({query='',prefix='',limit=40}={}){
    if(typeof query!=='string'||query.length>160||typeof prefix!=='string'||prefix.length>250)throw Error('Filtros inválidos.');
    const i=await this.index();
    return i.files.filter(f=>f.path.startsWith(prefix)&&f.path.toLowerCase().includes(query.toLowerCase()))
      .slice(0,Math.min(100,Math.max(1,limit))).map(f=>({path:f.path,lines:f.lines,bytes:f.bytes,symbols:f.symbols.length}));
  }
  async symbols({query='',prefix='',limit=40}={}){
    if(typeof query!=='string'||query.length>100||!query)throw Error('Informe um símbolo.');
    const i=await this.index(),out=[];
    for(const f of i.files){
      if(!f.path.startsWith(prefix))continue;
      for(const symbol of f.symbols){
        if(symbol.name.toLowerCase().includes(query.toLowerCase()))
          out.push({path:f.path,...symbol});
        if(out.length>=Math.min(100,Math.max(1,limit)))return out;
      }
    }
    return out;
  }
  async dependencies({path}){
    publicPath(path);
    const idx=await this.index(),file=idx.files.find(f=>f.path===path);
    if(!file)throw Error('Arquivo não encontrado no índice.');
    const folder=path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';
    const resolved=file.imports.filter(s=>s.startsWith('.')).map(spec=>{
      const candidate=slash(relative(this.root,resolve(this.root,folder,spec)));
      return {specifier:spec,target:idx.files.find(f=>f.path===candidate||f.path===candidate+'.ts'||f.path===candidate+'.js'||f.path===candidate+'.mjs'||f.path===candidate+'/index.ts')?.path??null};
    });
    const incoming=idx.files.filter(f=>f.path!==path&&f.imports.some(s=>{
      if(!s.startsWith('.'))return false;
      const base=f.path.includes('/')?f.path.slice(0,f.path.lastIndexOf('/')):'';
      const candidate=slash(relative(this.root,resolve(this.root,base,s)));
      return path===candidate||path===candidate+'.ts'||path===candidate+'.js'||path===candidate+'.mjs'||path===candidate+'/index.ts';
    })).map(f=>f.path).slice(0,80);
    return {path,imports:file.imports.slice(0,160),localReferences:resolved,incoming};
  }
  async read({path,startLine=1,endLine=0}){
    const full=await this.safeFile(path);
    const content=(await readFile(full)).toString('utf8');
    const lines=content.split(/\r?\n/),start=Math.max(1,startLine);
    const end=endLine===0?Math.min(lines.length,start+199):Math.min(endLine,start+199,lines.length);
    if(start>lines.length||end<start)throw Error('Intervalo de linhas inválido.');
    return {path,startLine:start,endLine:end,totalLines:lines.length,sha256:hash(Buffer.from(content)),
      text:lines.slice(start-1,end).map((s,i)=>String(start+i).padStart(5)+' '+s).join('\n')};
  }
  async search({query,prefix='',caseSensitive=false,limit=40}){
    if(typeof query!=='string'||!query||query.length>200||typeof prefix!=='string'||prefix.length>250)throw Error('Pesquisa inválida.');
    const idx=await this.index(),out=[];let scannedBytes=0,truncated=false;
    for(const f of idx.files){
      if(!f.path.startsWith(prefix))continue;
      if(scannedBytes+f.bytes>MAX_SCAN_BYTES){truncated=true;break;}
      try{
        const full=await this.safeFile(f.path);
        const buffer=await readFile(full);
        scannedBytes+=buffer.length;
        const rows=buffer.toString('utf8').split(/\r?\n/);
        for(let i=0;i<rows.length;i++){
          const content=rows[i]??'';
          const matched=caseSensitive?content.includes(query):content.toLowerCase().includes(query.toLowerCase());
          if(matched)out.push({path:f.path,line:i+1,preview:content.slice(0,240)});
          if(out.length>=Math.min(100,Math.max(1,limit)))return {matches:out,scannedBytes,truncated:true};
        }
      }catch(e){if(e?.code!=='ENOENT')throw e;}
    }
    return {matches:out,scannedBytes,truncated};
  }
  async replace({path,expectedSha256,oldText,newText,replaceAll=false,dryRun=true}){
    if(typeof expectedSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedSha256)||
       typeof oldText!=='string'||!oldText||oldText.length>20000||
       typeof newText!=='string'||newText.length>20000||
       typeof replaceAll!=='boolean'||typeof dryRun!=='boolean')
      throw Error('Argumentos de edição inválidos.');
    if(!dryRun&&!this.writable)throw Error('Escrita desabilitada. Requer REPO_MCP_ALLOW_WRITE=1 fora do Actions.');
    if(path.startsWith('.github/')||path==='AGENTS.md'||path.startsWith('tools/repo-mcp/'))
      throw Error('Alterações em workflows e no servidor MCP não são permitidas por esta ferramenta.');
    const full=await this.safeFile(path),data=await readFile(full);
    if(hash(data)!==expectedSha256)throw Error('O arquivo mudou; leia novamente e use o SHA-256 atual.');
    const before=data.toString('utf8'),occurrences=before.split(oldText).length-1;
    if(occurrences===0)throw Error('Trecho não encontrado.');
    if(!replaceAll&&occurrences!==1)throw Error('Trecho ambíguo; especifique mais contexto ou replaceAll.');
    const after=replaceAll?before.split(oldText).join(newText):before.replace(oldText,newText);
    const newBuffer=Buffer.from(after,'utf8');
    if(newBuffer.length>MAX_FILE)throw Error('Arquivo editado excederia 1 MiB.');
    const summary={path,matched:occurrences,beforeSha256:hash(data),afterSha256:hash(newBuffer),
      oldBytes:data.length,newBytes:newBuffer.length,changed:before!==after,dryRun};
    if(!dryRun&&before!==after){
      const fresh=await readFile(full);
      if(hash(fresh)!==expectedSha256)throw Error('Arquivo mudou durante a edição.');
      await writeFile(full,after,{flag:'w'});
      this.cached=null;
      await rm(this.indexFile,{force:true});
    }
    return summary;
  }
}
