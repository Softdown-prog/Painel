import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabaseStatus, createProjectDatabase, handleDatabaseRoute } from './database.ts';
import { adminTls, signerReady, issueCertificate } from './postgres-cert.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'panel-pg-mtls-'));
  const tls = join(dir, 'tls');
  mkdirSync(tls, { mode: 0o700 });
  for (const [file, value] of [
    ['ca.key', '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n'],
    ['ca.crt', 'TEST ROOT CA'],
    ['admin.crt', 'ADMIN CERT'],
    ['admin.key', 'ADMIN KEY'],
  ]) writeFileSync(join(tls,file),value,{mode:0o600});
  const env = {
    NODE_ENV: 'test',
    PANEL_POSTGRES_ENABLED: '1', PANEL_POSTGRES_WRITE_ENABLED: '1',
    PANEL_POSTGRES_TLS_ENABLED: '1',
    PANEL_POSTGRES_TLS_DIR: tls, PANEL_POSTGRES_HOST: 'vps-postgres',
  };
  return {dir,tls,env,remove:()=>rmSync(dir,{recursive:true,force:true})};
}
const hba = (method, type = 'hostssl') => [{ type, auth_method: method, error: null }];
test('status is disabled by default and does not request secrets',async()=>{
  const status = await getDatabaseStatus({});
  assert.equal(status.integration,'not_configured');
  assert.equal(status.security.provisioningEnabled,false);
});
test('inventory reports trust as unsafe and reads roles without changing SQL',async()=>{
  const sql = []; let ended=false;
  const c={async connect(){},async query(q){
    sql.push(q);
    if(q.startsWith('SET')) return {rows:[]};
    if(q.includes('current_setting')) return {rows:[{
      version:'18.6',database_count:2,connections:9,total_bytes:'3000'
    }]};
    if(q.includes('pg_hba_file_rules')) return {rows:hba('trust','host')};
    if(q.includes('pg_roles')) return {rows:[
      {name:'postgres',can_login:true,superuser:true},
      {name:'u_site_loja',can_login:true,superuser:false}
    ]};
    return {rows:[{name:'postgres',owner:'postgres',size_bytes:'1500'},
      {name:'p_site_loja',owner:'u_site_loja',size_bytes:'1500'}]};
  },async end(){ended=true}};
  const status = await getDatabaseStatus({PANEL_POSTGRES_ENABLED:'1'},()=>c);
  assert.equal(status.integration,'connected');
  assert.equal(status.metrics.databaseCount,2);
  assert.equal(status.roles[1].name,'u_site_loja');
  assert.equal(status.security.hostAuthentication,'trust');
  assert.equal(status.security.provisioningEnabled,false);
  assert.ok(sql.every(q=>q.startsWith('SET')||q.startsWith('SELECT')));
  assert.equal(ended,true);
});
test('connection failures never leak private material',async()=>{
  const status = await getDatabaseStatus({PANEL_POSTGRES_ENABLED:'1'},()=>({
    async connect(){throw Error('private certificate data');},async query(){},async end(){}
  }));
  assert.equal(status.integration,'unavailable');
  assert.equal(JSON.stringify(status).includes('private certificate data'),false);
});
test('certificate signer is gated and never reads files from arbitrary production paths',()=>{
  const f=fixture();
  try{
    assert.equal(signerReady(f.env),true);
    assert.match(adminTls(f.env).cert,/ADMIN CERT/);
    assert.equal(signerReady({...f.env,NODE_ENV:'production'}),false);
    assert.equal(signerReady({...f.env,PANEL_POSTGRES_TLS_ENABLED:'0'}),false);
    assert.equal(signerReady({...f.env,PANEL_POSTGRES_TLS_DIR:'/etc'}),false);
  }finally{f.remove();}
});
test('no project is created while trust is enabled, even with signer installed',async()=>{
  const f=fixture();let writes=0;
  try{
    const mock=()=>({
      async connect(){},
      async query(q){if(!q.startsWith('SELECT'))writes++;return {rows:hba('trust','host')};},
      async end(){}
    });
    await assert.rejects(createProjectDatabase('site-loja',f.dir,f.env,mock),/sem certificado/);
    assert.equal(writes,0);
    await assert.rejects(createProjectDatabase('drop;table',f.dir,f.env,mock),/Use 2 a 30/);
    await assert.rejects(createProjectDatabase('site-loja',f.dir,{...f.env,PANEL_POSTGRES_WRITE_ENABLED:'0'},mock),/não habilitada/);
  }finally{f.remove();}
});
test('certificate policy without a live rejection of cert-less clients must refuse writes',async()=>{
  const f=fixture();let creates=0;
  try{
    const mock=()=>({
      async connect(){},
      async query(q){
        if(q.includes('pg_hba_file_rules'))return {rows:hba('cert')};
        if(q.includes('pg_stat_ssl'))return {rows:[{ssl:true}]};
        if(q.startsWith('CREATE'))creates++;
        return {rows:[]};
      },async end(){}
    });
    await assert.rejects(createProjectDatabase('site-loja',f.dir,f.env,mock),/recusa de clientes sem certificado/);
    assert.equal(creates,0);
  }finally{f.remove();}
});
test('secure creation uses certificates, no PASSWORD values, and verifies real project identity',async()=>{
  const f=fixture(),sql=[];
  let published=false,cleaned=false;
  try{
    const mock=config=>({
      async connect(){
        if(!config.ssl?.cert)throw Object.assign(Error('certificate required'),{code:'28000'});
        if(config.user==='u_site_loja' && config.ssl.cert==='ADMIN CERT')
          throw Object.assign(Error('CN mismatch'),{code:'28000'});
      },
      async query(q){
        sql.push(q);
        if(q.includes('pg_hba_file_rules'))return {rows:[...hba('cert'),...hba('reject','host')]};
        if(q.includes('pg_stat_ssl'))return {rows:[{ssl:true}]};
        if(q.includes('rolsuper AS'))return {rows:[{superuser:true}]};
        if(q.includes('database_exists'))return {rows:[{databases:0,database_exists:0,role_exists:0}]};
        if(q.includes('current_user AS'))return {rows:[{username:'u_site_loja',db:'p_site_loja'}]};
        return {rows:[]};
      },
      async end(){}
    });
    const issuer=()=>({
      directory:join(f.dir,'client'),
      client:{ca:'ROOT',cert:'PROJECT CERT',key:'KEY',rejectUnauthorized:true},
      publish(){published=true;},cleanup(){cleaned=true;}
    });
    const created=await createProjectDatabase('site-loja',f.dir,f.env,mock,issuer);
    assert.deepEqual(created,{
      project:'site-loja',database:'p_site_loja',
      username:'u_site_loja',credentialsStored:true
    });
    assert.equal(published,true);
    assert.equal(cleaned,true);
    assert.ok(sql.includes('CREATE DATABASE p_site_loja OWNER u_site_loja'));
    assert.ok(sql.includes('REVOKE ALL ON DATABASE p_site_loja FROM PUBLIC'));
    assert.ok(sql.some(q=>q.startsWith('CREATE ROLE u_site_loja LOGIN PASSWORD NULL')));
    assert.ok(!sql.some(q=>q.includes("'PROJECT CERT'")||q.includes("'KEY'")));
    assert.doesNotMatch(JSON.stringify(created),/cert|private|password/i);
  }finally{f.remove();}
});
test('OpenSSL generates distinct certs with private project keys and no passwords',()=>{
  const binary=spawnSync('openssl',['version'],{encoding:'utf8'});
  if(binary.status!==0)return;
  const f=fixture();
  try{
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes',
      '-keyout',join(f.tls,'ca.key'),'-out',join(f.tls,'ca.crt'),
      '-days','2','-subj','/CN=Test VPS CA'],{stdio:'ignore'});
    const issued=issueCertificate('u_site_loja',f.dir,f.env);
    const pendingKey=issued.client.key;
    assert.match(pendingKey,/PRIVATE KEY/);
    issued.publish();
    assert.equal(issued.directory,join(f.dir,'database-credentials','site-loja'));
    assert.equal(statSync(join(issued.directory,'client.key')).mode&0o777,0o600);
    assert.equal(existsSync(join(issued.directory,'client.csr')),false);
    assert.equal(JSON.parse(readFileSync(join(issued.directory,'connection.json'),'utf8')).authentication,'client-certificate');
    assert.equal(JSON.stringify(readFileSync(join(issued.directory,'connection.json'),'utf8')).includes('password'),false);
    issued.cleanup();
    assert.equal(existsSync(issued.directory),true);
  }finally{f.remove();}
});
test('admin routes still reject unsupported database writes',async()=>{
  const responses=[];const send=(_,status,value)=>responses.push({status,value});
  await handleDatabaseRoute({url:'/database/status',method:'GET'},{},{
    send,loadStatus:async()=>({engine:'postgresql',integration:'not_configured'})
  });
  await handleDatabaseRoute({url:'/database/status',method:'POST'},{},{send});
  await handleDatabaseRoute({url:'/database/projects',method:'POST'},{},{
    send,body:async()=>({project:'site-loja'}),
    create:async slug=>({project:slug,database:'p_site_loja',username:'u_site_loja',credentialsStored:true})
  });
  await handleDatabaseRoute({url:'/database/projects',method:'POST'},{},{
    send,body:async()=>({project:'site-loja',password:'tryme'}),
    create:async()=>{throw Error('unexpected');}
  });
  await handleDatabaseRoute({url:'/database/query',method:'POST'},{},{send});
  assert.deepEqual(responses.map(r=>r.status),[200,405,201,400,503]);
  assert.doesNotMatch(JSON.stringify(responses),/tryme/);
});
