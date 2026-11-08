import assert from 'node:assert/strict';
import {handleDatabaseAdminRoute} from './database-admin.ts';
import {getDatabaseStatus,createProjectDatabase} from './database.ts';
import {adminTls} from './postgres-cert.ts';
import {projectTls} from './postgres-cert.ts';
import {Client} from 'pg';

async function request(db,action,body,query=''){
  let reply;
  const handled=await handleDatabaseAdminRoute({url:'/database/admin/'+encodeURIComponent(db)+'/'+action+query,method:body?'POST':'GET'},{},
    {dataDir:'/data',send:(_r,status,data)=>reply={status,data},body:async()=>body});
  assert.equal(handled,true);assert.ok(reply);return reply;
}
const sql=(db,text,write=false)=>request(db,'sql',{sql:text,write,confirmation:db});
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r));return r.data;};
const status=await getDatabaseStatus();
assert.equal(status.integration,'connected');assert.equal(status.security.hostAuthentication,'trust');
assert.equal(status.security.adminAuthentication,'verified-certificate');assert.equal(status.security.provisioningEnabled,true);
assert.equal((await request('postgres','tables')).status,403);
assert.equal((await request('missing','tables')).status,404);
await createProjectDatabase('new-project','/data');
assert.equal(ok(await sql('p_new_project','SELECT current_database() AS name')).rows[0].name,'p_new_project');
assert.equal(ok(await sql('alpha','SELECT current_user AS name')).rows[0].name,'owner_alpha');
ok(await sql('alpha','CREATE TABLE public.items (id bigint PRIMARY KEY, name text NOT NULL, amount numeric(20,2))',true));
assert.equal(ok(await request('beta','tables')).tables.length,0);
assert.equal((await sql('alpha',"INSERT INTO public.items VALUES(1,'readonly',1)")).status,422);
assert.equal((await sql('alpha','SELECT * FROM pg_authid')).status,422);
assert.equal((await sql('alpha',"DO $$ BEGIN EXECUTE 'SET ROLE postgres'; END $$",true)).status,422);
assert.equal((await sql('alpha',"COPY public.items TO PROGRAM 'touch /tmp/should-not-exist'",true)).status,422);
assert.equal((await sql('alpha','SELECT 1; SELECT 2')).status,422);
assert.equal((await request('alpha','sql',{sql:'DROP TABLE public.items',write:true,confirmation:'beta'})).status,400);
ok(await request('alpha','rows',{schema:'public',table:'items',action:'insert',values:{id:'9007199254740993',name:'test',amount:'9999999999999999.99'},confirmation:'alpha'}));
let rows=ok(await request('alpha','rows',null,'?schema=public&table=items'));
assert.equal(rows.rows[0].id,'9007199254740993');assert.equal(rows.rows[0].amount,'9999999999999999.99');
const reader=ok(await request('alpha','access',{name:'relatorios',permission:'read',confirmation:'alpha'}));
const accessClient=new Client({host:'vps-postgres',database:'alpha',user:reader.identity,ssl:projectTls(reader.identity,'/data','alpha')});
await accessClient.connect();assert.equal((await accessClient.query('SELECT count(*)::int AS n FROM public.items')).rows[0].n,1);
await assert.rejects(accessClient.query("INSERT INTO public.items VALUES(2,'blocked',0)"),e=>e.code==='42501');
await accessClient.end();
ok(await request('alpha','access',{name:'relatorios',permission:'none',confirmation:'alpha'}));
const disabled=new Client({host:'vps-postgres',database:'alpha',user:reader.identity,ssl:projectTls(reader.identity,'/data','alpha')});
await assert.rejects(disabled.connect());await disabled.end().catch(()=>{});
const version=rows.rows[0].__panel_version;
ok(await request('alpha','rows',{schema:'public',table:'items',action:'update',values:{name:'updated'},key:{id:'9007199254740993'},version,confirmation:'alpha'}));
assert.equal((await request('alpha','rows',{schema:'public',table:'items',action:'delete',key:{id:'9007199254740993'},version,confirmation:'alpha'})).status,409);
const bounded=ok(await sql('alpha','SELECT generate_series(1,1000) AS value'));
assert.equal(bounded.rows.length,100);assert.equal(bounded.truncated,true);
const backup=ok(await request('alpha','backups',{})).backup;
assert.ok(backup.sizeBytes>0);assert.match(backup.sha256,/^[a-f0-9]{64}$/);
const part=ok(await request('alpha','backup-part',null,'?id='+backup.id+'&offset=0'));
assert.equal(Buffer.from(part.data,'base64').length,Math.min(65536,backup.sizeBytes));
ok(await request('beta','restore',{sourceDatabase:'alpha',backupId:backup.id,confirmation:'beta'}));
assert.equal(ok(await sql('beta','SELECT name FROM public.items')).rows[0].name,'updated');
assert.equal((await request('beta','restore',{sourceDatabase:'alpha',backupId:backup.id,confirmation:'beta'})).status,409);
// A valid administrator cert cannot authenticate as any scoped owner/editor.
const cross=new Client({host:'vps-postgres',database:'alpha',user:'owner_alpha',ssl:adminTls(process.env)});
await assert.rejects(cross.connect());await cross.end().catch(()=>{});
const bare=new Client({host:'vps-postgres',database:'postgres',user:'panel_db_admin',ssl:{ca:adminTls(process.env).ca,rejectUnauthorized:true}});
await assert.rejects(bare.connect(),e=>e.code==='28000');await bare.end().catch(()=>{});
// Failed mutations leave the original data, and the other project keeps its own contents.
assert.equal((await sql('alpha',"INSERT INTO public.items VALUES(9007199254740993,'duplicate',0)",true)).status,422);
assert.equal(ok(await sql('alpha','SELECT count(*)::int AS n FROM public.items')).rows[0].n,1);
const dropped=ok(await request('alpha','delete',{confirmation:'alpha'}));assert.ok(dropped.backup);
assert.ok(ok(await request('alpha','backups')).backups.length>=2);
ok(await request('alpha','backup-part',null,'?id='+backup.id+'&offset=0'));
assert.equal(ok(await sql('beta','SELECT count(*)::int AS n FROM public.items')).rows[0].n,1);
assert.equal((await sql('beta','SELECT pg_sleep(10)')).status,422);
console.log('PASS: real PostgreSQL 18 TLS, no-cert/cross-cert rejection, two isolated projects, CRUD/stale writes, SQL limits, backup/download/restore/deleted-source recovery, system protection and timeout.');
