/**
 * SAC-PRE001..005 on this repository's real Angular source.
 * External SAC checkout is pinned by the workflow; source is read-only.
 * Never claim runtime or deployment was validated by this static pass.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readdir,readFile,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {verifyWorkspace} from '../.sac-tool/packages/angular-precompiler/src/index.mjs';
import {analyzeImportGraph} from '../.sac-tool/packages/angular-precompiler/src/dependency-graph.mjs';
import {analyzeAngularComponentWiring} from '../.sac-tool/packages/angular-precompiler/src/component-wiring.mjs';
import {inspectAngularTemplateLinks} from '../.sac-tool/packages/angular-precompiler/src/template-links.mjs';
import {inspectAngularTemplateBindings} from '../.sac-tool/packages/angular-precompiler/src/template-binding-evidence.mjs';

const root=path.resolve(fileURLToPath(new URL('../angular',import.meta.url)));
const appRequire=createRequire(path.join(root,'package.json'));
const ts=appRequire('typescript');
const ng=await import(pathToFileURL(appRequire.resolve('@angular/compiler')).href);
const files=[],templates=[];
let count=0,bytes=0;
async function walk(folder){
  const entries=await readdir(folder,{withFileTypes:true});
  for(const entry of entries){
    if(++count>500)throw Error('SAC file-entry limit');
    if(entry.isSymbolicLink())throw Error('SAC source symlink rejected');
    const full=path.join(folder,entry.name);
    if(entry.isDirectory()){await walk(full);continue;}
    if(!entry.isFile())throw Error('SAC special file rejected');
    const target=/\.tsx?$/.test(entry.name)?files:/\.html$/.test(entry.name)?templates:null;
    if(!target)continue;
    const info=await lstat(full);
    if(!info.isFile()||info.nlink!==1||info.size>524288)throw Error('SAC file bound');
    bytes+=info.size;
    if(files.length+templates.length>=160||bytes>4*1024*1024)throw Error('SAC overall bound');
    const name=path.relative(root,full).split(path.sep).join('/');
    if(!/^src\/[a-zA-Z0-9_./-]+\.(?:tsx?|html)$/.test(name))throw Error('SAC unsafe source path');
    target.push({path:name,source:await readFile(full,'utf8')});
  }
}
assert.equal(await realpath(root),root,'SAC must use physical Angular root');
await walk(path.join(root,'src'));
assert.ok(files.length>10&&templates.length>2,'Angular source enumeration empty');
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const expected=pkg.dependencies['@angular/core'];
const pre=await verifyWorkspace({workspace:root,angularVersion:expected});
const graph=analyzeImportGraph({files,typescript:ts,tsconfig:{
  path:'tsconfig.json',text:await readFile(path.join(root,'tsconfig.json'),'utf8')
},policy:{layers:[],allowImports:{},external:['@angular/','rxjs','rxjs/','tslib']}});
const wiring=analyzeAngularComponentWiring({files,typescript:ts});
const links=inspectAngularTemplateLinks({files,templates,typescript:ts});
const bindings=inspectAngularTemplateBindings({files,templates,typescript:ts,angularCompiler:ng});
assert.equal(pre.rule_id,'SAC-PRE001');
for(const [item,rule] of [[graph,'SAC-PRE002'],[wiring,'SAC-PRE003'],
 [links,'SAC-PRE004'],[bindings,'SAC-PRE005']]){
  assert.equal(item.rule_id,rule);
  assert.equal(item.deployment_authorized,false);
}
const countCodes=findings=>Object.fromEntries(Object.entries((findings||[]).reduce((out,item)=>{
  const code=String(item.code||'unknown');
  if(/^[a-z][a-z0-9-]{0,96}$/.test(code))out[code]=(out[code]||0)+1;
  return out;
},{})).sort((a,b)=>a[0].localeCompare(b[0])));
const report={
  schema_version:1,kind:'sac-panel-angular-static',
  repository:'Softdown-prog/Painel',
  source_sha:process.env.GITHUB_SHA||null,
  sac_sha:process.env.SAC_PIN_SHA||null,
  angular_version:expected,
  source_files:{typescript:files.length,html:templates.length,bytes},
  checks:{
    pre:{status:pre.status,diagnostics:(pre.evidence||[]).map(x=>({
      code:x.code,assertion:x.assertion,status:x.status
    }))},
    graph:{status:graph.status,nodes:graph.nodes.length,edges:graph.edges.length,
      findings:countCodes(graph.findings)},
    components:{status:wiring.status,checked:wiring.components_checked,
      findings:countCodes(wiring.findings)},
    links:{status:links.status,linked:links.external_templates_linked,
      missing:links.external_templates_not_enumerated,findings:countCodes(links.findings)},
    bindings:{status:bindings.status,parsed:bindings.templates_total_parsed,
      parser_errors:bindings.template_parser_error_count,findings:countCodes(bindings.findings)}
  },
  official_build:'separate-ci-step',browser:'not-run-in-sac',runtime:'not-run',
  deployment_authorized:false
};
console.log(JSON.stringify(report,null,2));
if(pre.status==='fail'||graph.status==='fail'||wiring.status==='fail'||
  bindings.template_parser_error_count>0||links.external_templates_not_enumerated>0)
  throw Error('SAC found actionable source failures; review the bounded report');
