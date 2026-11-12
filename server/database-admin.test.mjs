import test from 'node:test';
import assert from 'node:assert/strict';
import {identifier, confirmation, editRow, handleDatabaseAdminRoute} from './database-admin.ts';
import {initialInsertValues} from '../angular/src/database-row-values.ts';

test('identifiers are quoted, including quotes, and unsafe/oversized names fail',()=>{
  assert.equal(identifier('a"; DROP DATABASE postgres;--'),'"a""; DROP DATABASE postgres;--"');
  for(const input of ['',null,'x\0y','a'.repeat(64)])assert.throws(()=>identifier(input));
});
test('form preserves special PostgreSQL column names without prototype mutation',()=>{
 const columns=[
   {name:'__proto__',generated:false,defaulted:false,nullable:false},
   {name:'constructor',generated:false,defaulted:false,nullable:false},
   {name:'created_at',generated:false,defaulted:true,nullable:false}
 ];
 const values=initialInsertValues(columns);
 assert.equal(Object.hasOwn(values,'__proto__'),true);
 assert.equal(Object.hasOwn(values,'constructor'),true);
 assert.equal(Object.getPrototypeOf(values),Object.prototype);
 assert.deepEqual(JSON.parse(JSON.stringify(values)),JSON.parse('{"__proto__":null,"constructor":null}'));
});
test('changes require exact target confirmation',()=>{
  assert.throws(()=>confirmation({confirmation:'alpha'},'beta'));
  confirmation({confirmation:'beta'},'beta');
});
function client(columns, count=1){
  const calls=[];
  return {calls,async query(sql,values){calls.push({sql,values});return sql.startsWith('SELECT a.attname')?{rows:columns}:{rows:[],rowCount:count};}};
}
const cols=[{name:'id',primary:true,generated:true},{name:'name',primary:false,generated:false}];
test('insert binds values and rejects generated/unknown columns',async()=>{
  const c=client(cols);const value="'; DROP TABLE clients;--";
  await editRow(c,'public','clients',{action:'insert',values:{name:value}});
  assert.ok(!c.calls[1].sql.includes(value));assert.deepEqual(c.calls[1].values,[value]);
  await assert.rejects(editRow(c,'public','clients',{action:'insert',values:{id:1}}),/editáveis/);
  await assert.rejects(editRow(c,'public','clients',{action:'insert',values:{missing:1}}),/editáveis/);
});
test('insert preserves PostgreSQL defaults and allows manual primary keys',async()=>{
  const columns=[
    {name:'codigo',nullable:false,generated:false,defaulted:false,primary:true},
    {name:'criado_em',nullable:false,generated:false,defaulted:true,primary:false},
    {name:'descricao',nullable:true,generated:false,defaulted:false,primary:false},
    {name:'id_automatico',nullable:false,generated:true,defaulted:false,primary:false}
  ];
  assert.deepEqual(initialInsertValues(columns),{codigo:null});
  assert.deepEqual(initialInsertValues(columns.slice(1)),{});
  const c=client(columns);
  await editRow(c,'public','catalogo',{action:'insert',values:{codigo:'ABC-01'}});
  assert.match(c.calls[1].sql,/INSERT INTO "public"\."catalogo" \("codigo"\) VALUES \(\$1\)/);
  assert.deepEqual(c.calls[1].values,['ABC-01']);
  const defaults=client(columns);
  await editRow(defaults,'public','catalogo',{action:'insert',values:{}});
  assert.equal(defaults.calls[1].sql,'INSERT INTO "public"."catalogo" DEFAULT VALUES');
  assert.deepEqual(defaults.calls[1].values,[]);
  await assert.rejects(editRow(c,'public','catalogo',{action:'update',values:{},key:{codigo:'ABC-01'},version:'17'}),/editáveis/);
});
test('updates/deletes require primary key and optimistic row version',async()=>{
  const c=client(cols);
  await editRow(c,'public','clients',{action:'update',values:{name:'Novo'},key:{id:'9007199254740993'},version:'17'});
  assert.match(c.calls[1].sql,/xmin::text=\$3/);assert.deepEqual(c.calls[1].values,['Novo','9007199254740993','17']);
  await assert.rejects(editRow(c,'public','clients',{action:'delete',key:{},version:'17'}),/Chave e versão/);
  await assert.rejects(editRow(client([{name:'name'}]),'public','clients',{action:'delete',key:{name:'x'},version:'17'}),/primária/);
  await assert.rejects(editRow(client(cols,0),'public','clients',{action:'delete',key:{id:'1'},version:'17'}),/alterado ou excluído/);
});
test('system schemas are protected from row editing',async()=>{
  await assert.rejects(editRow(client(cols),'pg_catalog','pg_authid',{action:'delete'}),/protegido/);
});
test('unknown route/method and disabled administration fail closed',async()=>{
  for(const [url,method,status] of [['/database/admin/test/sql','GET',405],['/database/admin/test/nope','POST',404],['/database/admin/test/tables','GET',503]]){
    let reply;
    assert.equal(await handleDatabaseAdminRoute({url,method},{},{dataDir:'/nonexistent',env:{},body:async()=>({}),send:(_r,s,d)=>reply={s,d}}),true);
    assert.equal(reply.s,status);assert.equal(typeof reply.d.error,'string');
  }
  assert.equal(await handleDatabaseAdminRoute({url:'/session'},{},{send(){}}),false);
});
