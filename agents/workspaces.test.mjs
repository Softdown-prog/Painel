import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {Workspaces,validateArchiveListing} from './workspaces.mjs';
import {workspaceChanges} from './operations.mjs';
import {createBridge} from './bridge.mjs';
import {EventEmitter,once} from 'node:events';
import {PassThrough,Writable} from 'node:stream';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'agent-import-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const workspace=join(root,'workspace'),state=join(root,'state'),source=join(root,'repo');
 for(const p of [workspace,state,source])mkdirSync(p);
 return {root,workspace,state,source,store:new Workspaces(workspace,state),
  meta:{project:'gh_123_01234567',repository:'Example/Repo',branch:'main',sourceSha:'a'.repeat(40)}};
}
test('archive paths, special entries and size limits fail closed',()=>{
 const row=p=>'-rw-r--r-- 0/0 4 2026-11-08 00:00 '+p+'\n';
 assert.equal(validateArchiveListing('repo/a.txt\n',row('repo/a.txt')).bytes,4);
 for(const path of ['/repo/a','repo/../escape','repo/.git/config','repo/a\\nname','repo/./a'])
  assert.throws(()=>validateArchiveListing(path+'\n',row(path)));
 assert.throws(()=>validateArchiveListing('repo/a\n','lrwxrwxrwx 0/0 0 2026-11-08 00:00 repo/a -> /etc\n'));
 assert.throws(()=>validateArchiveListing('repo/a\n',row('repo/a').replace(' 4 ',' 99999999999 ')));
 assert.throws(()=>validateArchiveListing('repo/a\nother/b\n',row('repo/a')+row('other/b')));
});
test('real GNU tar import creates isolated baseline, preserves ignored source and publishes against remote SHA',async t=>{
 const f=fixture(t);
 writeFileSync(join(f.source,'.gitignore'),'tracked.txt\n');
 writeFileSync(join(f.source,'tracked.txt'),'original\n');
 writeFileSync(join(f.source,'hello world.md'),'safe\n');
 const tar=execFileSync('tar',['-czf','-','-C',f.root,'repo']);
 await f.store.receive(Readable.from(tar),f.meta);
 const dir=join(f.workspace,f.meta.project);
 assert.equal(readFileSync(join(dir,'hello world.md'),'utf8'),'safe\n');
 assert.throws(()=>workspaceChanges(dir,f.store.origin(f.meta.project)),/Selecione/);
 writeFileSync(join(dir,'tracked.txt'),'edited\n');
 execFileSync('git',['-C',dir,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-am','Local change'],{stdio:'ignore'});
 const snapshot=workspaceChanges(dir,f.store.origin(f.meta.project));
 assert.equal(snapshot.baseSha,f.meta.sourceSha);
 assert.deepEqual(snapshot.files.map(x=>x.path),['tracked.txt']);
 assert.equal(snapshot.files[0].content,'edited\n');
 await assert.rejects(f.store.receive(Readable.from(tar),f.meta),/existente/);
 assert.equal(readFileSync(join(dir,'tracked.txt'),'utf8'),'edited\n');
});
test('symbolic links are rejected before installation and leave existing projects untouched',async t=>{
 const f=fixture(t);writeFileSync(join(f.workspace,'untouched'),'preserved');
 symlinkSync('/etc',join(f.source,'escape'));
 const tar=execFileSync('tar',['-czf','-','-C',f.root,'repo']);
 await assert.rejects(f.store.receive(Readable.from(tar),f.meta));
 assert.equal(existsSync(join(f.workspace,f.meta.project)),false);
 assert.equal(readFileSync(join(f.workspace,'untouched'),'utf8'),'preserved');
 assert.deepEqual(f.store.list(),{});
});
test('private import reloads only app-server, preserves conversation and registers scoped project permissions',async t=>{
 const f=fixture(t),children=[],calls=[];let number=0;
 const spawnCodex=(_command,args)=>{
  const p=new EventEmitter();p.args=args;p.stdout=new PassThrough();p.stderr=new PassThrough();children.push(p);
  p.stdin=new Writable({write(chunk,_enc,done){
   const q=JSON.parse(chunk.toString());calls.push(q);
   if(q.method&&q.id){const result=q.method==='account/read'?{account:{type:'chatgpt'}}:
    q.method==='thread/start'?{thread:{id:'thread-'+(++number)}}:
    q.method==='turn/start'?{turn:{id:'turn-fixture'}}:{};
    queueMicrotask(()=>p.stdout.write(JSON.stringify({id:q.id,result})+'\n'));
   }done();
  }});
  p.kill=()=>{p.emit('exit',0);p.stdin.end();p.stdout.end();p.stderr.end();};return p;
 };
 const secret='a'.repeat(64),service=createBridge({secret,workspace:f.workspace,stateDir:f.state,spawnCodex,operationsEnabled:true});
 service.start();service.server.listen(0,'127.0.0.1');await once(service.server,'listening');
 t.after(async()=>{service.stop();service.server.closeAllConnections();await new Promise(r=>service.server.close(r));});
 const base='http://127.0.0.1:'+service.server.address().port;
 const request=(path,body,headers={})=>fetch(base+path,{method:body?'POST':'GET',headers:{'x-panel-agent-key':secret,'content-type':'application/json',...headers},...(body?{body:Buffer.isBuffer(body)?body:JSON.stringify(body)}:{})});
 for(let i=0;i<30&&!(await(await request('/status')).json()).ready;i++)await new Promise(r=>setTimeout(r,5));
 const original=(await(await request('/threads',{project:'Geral'})).json()).thread;
 await request('/threads/'+original.id+'/turns',{message:'Preserve esta conversa'});
 const headers={'x-panel-project':f.meta.project,'x-panel-repository':f.meta.repository,'x-panel-branch':f.meta.branch,'x-panel-source-sha':f.meta.sourceSha};
 assert.equal((await request('/workspaces',Buffer.from('not an archive'),headers)).status,409,'active turn must block import');
 children[0].stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:original.id,turn:{status:'completed'}}})+'\n');
 writeFileSync(join(f.source,'main.txt'),'fixture');
 const tar=execFileSync('tar',['-czf','-','-C',f.root,'repo']);
 assert.equal((await request('/workspaces',tar,headers)).status,201);
 for(let i=0;i<30&&!(await(await request('/status')).json()).ready;i++)await new Promise(r=>setTimeout(r,5));
 const status=await(await request('/status')).json();assert.ok(status.ready);assert.ok(status.projects.includes(f.meta.project));
 assert.equal(children.length,2);assert.ok(children[1].args.some(x=>x.startsWith('permissions.panel_'+f.meta.project+'.filesystem=')));
 assert.equal((await(await request('/threads/'+original.id)).json()).thread.messages[0].text,'Preserve esta conversa');
 assert.equal((await request('/threads',{project:f.meta.project})).status,201);
 assert.equal(calls.findLast(x=>x.method==='thread/start').params.permissions,'panel_'+f.meta.project);
 children[0].emit('exit',0);
 assert.equal((await(await request('/status')).json()).ready,true,'late exit from old subprocess cannot disconnect the new one');
});
