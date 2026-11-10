/** Authenticated database administration. SQL never runs as the cluster administrator. */
import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, chmodSync, writeFileSync, openSync, closeSync, readSync} from 'node:fs';
import {join} from 'node:path';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {adminTls, issueCertificate, projectTls} from './postgres-cert.ts';
import {databaseOptions, verifyCertificateLane, CERTIFICATE_GROUP} from './database.ts';

type Row = Record<string, unknown>;
type Result = {rows: Row[]; rowCount: number | null; fields?: {name: string}[]};
export type SqlClient = {connect(): Promise<void>; end(): Promise<void>;
  query(sql: string | {text: string; values?: unknown[]; queryMode?: string}, values?: unknown[]): Promise<Result>};
type Env = NodeJS.ProcessEnv;
type Column = {name: string; type: string; nullable: boolean; generated: boolean; primary: boolean};
type Scope = {client: SqlClient; database: string; owner: string; role: string; credentials: string};
class DatabaseError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 63 || /[\x00-\x1f\x7f]/.test(value))
    throw new DatabaseError(400, 'Nome de banco, tabela ou coluna inválido.');
  return '"' + value.replaceAll('"', '""') + '"';
}
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DatabaseError(400, 'Informe um objeto JSON.');
  return value as Row;
}
export function confirmation(input: Row, target: string): void {
  if (input['confirmation'] !== target) throw new DatabaseError(400, 'Confirme digitando exatamente: ' + target);
}
function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new DatabaseError(400, 'Paginação inválida.');
  return n;
}
async function connect(config: Record<string, unknown>): Promise<SqlClient> {
  // @ts-ignore pg is installed only in the API image.
  const {Client} = await import('pg');
  const client = new Client(config) as SqlClient;
  try { await client.connect(); return client; }
  catch (error) { await client.end().catch(() => {}); throw error; }
}
function failure(error: unknown): {status: number; error: string; code?: string} {
  if (error instanceof DatabaseError) return {status: error.status, error: error.message};
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const messages: Record<string, string> = {'23505': 'Já existe um registro com essa chave.',
    '23503': 'Há registros relacionados. Nenhum dado dependente foi apagado.', '23502': 'Preencha as colunas obrigatórias.',
    '42501': 'Esta identidade não tem permissão para essa operação.', '25006': 'Consulta em modo somente leitura. Ative a alteração e confirme o banco.',
    '42601': 'SQL inválido. Execute uma única instrução por vez.', '57014': 'Operação interrompida por atingir o limite de tempo.',
    '55006': 'O banco possui conexões ativas. Desconecte os clientes antes de excluir.',
    '2BP01': 'Existem objetos ou permissões dependentes; a exclusão foi recusada.'};
  return {status: 422, code: code || 'DATABASE_OPERATION_FAILED', error: messages[code] ||
    'A operação não foi concluída. Confira tipos, permissões e dependências; dados e SQL não são incluídos nos logs.'};
}
const locks = new Set<string>();
async function exclusive<T>(database: string, operation: () => Promise<T>): Promise<T> {
  if (locks.has(database)) throw new DatabaseError(409, 'Já existe uma alteração em andamento neste banco.');
  locks.add(database);
  try { return await operation(); } finally { locks.delete(database); }
}
async function administrator(env: Env): Promise<SqlClient> {
  if (env['PANEL_POSTGRES_ENABLED'] !== '1' || env['PANEL_POSTGRES_WRITE_ENABLED'] !== '1')
    throw new DatabaseError(503, 'Administração ainda não habilitada nesta VPS.');
  const tls = adminTls(env);
  if (!tls) throw new DatabaseError(503, 'Certificado administrativo não instalado.');
  const client = await connect(databaseOptions(env, tls));
  try {
    if (!await verifyCertificateLane(client, env)) throw new DatabaseError(403, 'A autenticação exclusiva do painel não foi comprovada.');
    return client;
  } catch (error) { await client.end().catch(() => {}); throw error; }
}
async function databaseIdentity(client: SqlClient, database: string): Promise<{owner: string}> {
  identifier(database);
  const r = await client.query('SELECT d.datname, r.rolname AS owner, r.rolsuper FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=$1 AND NOT d.datistemplate', [database]);
  const row = r.rows[0];
  if (!row) throw new DatabaseError(404, 'Banco não encontrado.');
  if (['postgres', 'template0', 'template1'].includes(database) || row['rolsuper'] !== false)
    throw new DatabaseError(403, 'Banco de sistema ou pertencente ao administrador global. Acesso pelo editor bloqueado.');
  // A shared owner would allow SQL to reach another project's data. Require isolation.
  const count = await client.query('SELECT count(*)::int AS count FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname=$1) AND NOT datistemplate', [row['owner']]);
  if (count.rows[0]?.['count'] !== 1) throw new DatabaseError(403, 'Este proprietário é compartilhado por vários bancos. Separe as identidades antes de usar o editor.');
  const elevated = await client.query('WITH RECURSIVE roles AS (SELECT oid FROM pg_roles WHERE rolname=$1 UNION SELECT m.roleid FROM pg_auth_members m JOIN roles r ON r.oid=m.member) SELECT count(*)::int AS count FROM pg_roles WHERE oid IN (SELECT oid FROM roles) AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolname IN (\'pg_read_server_files\',\'pg_write_server_files\',\'pg_execute_server_program\'))', [row['owner']]);
  if (elevated.rows[0]?.['count'] !== 0) throw new DatabaseError(403, 'O proprietário possui privilégios globais incompatíveis com o editor isolado.');
  return {owner: String(row['owner'])};
}
async function scoped(database: string, dataDir: string, env: Env): Promise<Scope> {
  const admin = await administrator(env);
  try {
    const {owner} = await databaseIdentity(admin, database);
    const role = 'u_admin_' + createHash('sha256').update(database + '\0' + owner).digest('hex').slice(0, 16);
    const credentials = join(dataDir, 'database-credentials', role.slice(2).replaceAll('_', '-'));
    // Identity and private certificate are created once, with no password and no cluster privileges.
    if (!existsSync(credentials)) {
      await exclusive('identity:' + database, async () => {
        const found = await admin.query('SELECT 1 AS found FROM pg_roles WHERE rolname=$1', [role]);
        if (found.rows.length) throw new DatabaseError(409, 'Identidade incompleta encontrada. Requer revisão do administrador.');
        const cert = issueCertificate(role, dataDir, env, database);
        let created = false;
        try {
          await admin.query('CREATE ROLE ' + identifier(role) + ' LOGIN CONNECTION LIMIT 2 PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
          created = true;
          await admin.query('GRANT ' + identifier(CERTIFICATE_GROUP) + ', ' + identifier(owner) + ' TO ' + identifier(role));
          cert.publish();
        } catch (error) {
          if (created) await admin.query('DROP ROLE ' + identifier(role)).catch(() => {});
          throw error;
        } finally { cert.cleanup(); }
      });
    }
    // Recheck membership every time: a stale or externally modified identity must not gain global powers.
    const membership = await admin.query('SELECT r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolreplication, ARRAY(SELECT p.rolname::text FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid WHERE m.member=r.oid ORDER BY p.rolname) AS memberships FROM pg_roles r WHERE r.rolname=$1', [role]);
    const row = membership.rows[0];
    if (!row || ['rolsuper','rolcreaterole','rolcreatedb','rolbypassrls','rolreplication'].some(k => row[k] !== false) ||
      JSON.stringify(row['memberships']) !== JSON.stringify([owner, CERTIFICATE_GROUP].sort()))
      throw new DatabaseError(403, 'Identidade do editor alterada fora do painel. Revise as permissões.');
    const client = await connect({...databaseOptions(env, projectTls(role, dataDir, database), role, database),
      query_timeout: 10_000, statement_timeout: 8_000, lock_timeout: 2000, idle_in_transaction_session_timeout: 10_000});
    try { await client.query('SET ROLE ' + identifier(owner)); }
    catch (error) { await client.end().catch(() => {}); throw error; }
    return {client, database, owner, role, credentials};
  } finally { await admin.end().catch(() => {}); }
}
async function columns(client: SqlClient, schema: string, table: string): Promise<Column[]> {
  identifier(schema); identifier(table);
  if (schema === 'information_schema' || schema.startsWith('pg_')) throw new DatabaseError(403, 'Esquema de sistema protegido.');
  const r = await client.query(`SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
    NOT a.attnotnull AS nullable, (a.attgenerated<>'' OR a.attidentity<>'') AS generated,
    a.atthasdef AS defaulted,
    EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary AND a.attnum=ANY(i.indkey)) AS primary
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [schema, table]);
  if (!r.rows.length) throw new DatabaseError(404, 'Tabela não encontrada.');
  if (r.rows.some(c => c['name'] === '__panel_version')) throw new DatabaseError(409, 'Coluna reservada pelo editor. Use o SQL para esta tabela.');
  return r.rows as Column[];
}
export async function boundedSql(client: SqlClient, sql: string, write: boolean): Promise<Row> {
  if (!sql.trim() || Buffer.byteLength(sql) > 32_768) throw new DatabaseError(400, 'SQL deve ter entre 1 e 32.768 bytes.');
  // One extended-protocol statement. Transaction/session control belongs to this wrapper.
  if (/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*\s*(?:BEGIN|START|COMMIT|END|ROLLBACK|ABORT|SET|RESET|DISCARD|PREPARE|EXECUTE|DEALLOCATE)\b/i.test(sql))
    throw new DatabaseError(400, 'Controle de sessão não é permitido no editor. Execute uma instrução de dados ou estrutura.');
  // @ts-ignore pg-cursor is a small server-only dependency, never bundled into the frontend.
  const {default: Cursor} = await import('pg-cursor');
  await client.query(write ? 'BEGIN' : 'BEGIN READ ONLY');
  let finished = false;
  try {
    // Cursor protocol bounds rows at the server, including RETURNING results.
    const cursor = (client.query as unknown as (cursor: unknown) => {read(n: number): Promise<Row[]>; close(): Promise<void>; _result?: {fields?: {name: string}[]; rowCount?: number; command?: string}})(new Cursor(sql, [], {rowMode: 'object'}));
    let rows: Row[];
    try { rows = await cursor.read(101); } finally { await cursor.close().catch(() => {}); }
    if (Buffer.byteLength(JSON.stringify(rows)) > 512_000) throw new DatabaseError(413, 'Resultado grande demais. Selecione menos colunas ou use limites no SQL.');
    const result = {rows: rows.slice(0,100), columns: cursor._result?.fields?.map(f => f.name) || Object.keys(rows[0] || {}),
      truncated: rows.length > 100, affectedRows: cursor._result?.rowCount ?? null, command: cursor._result?.command || 'SQL', write};
    await client.query('COMMIT'); finished = true;
    return result;
  } finally { if (!finished) await client.query('ROLLBACK').catch(() => {}); }
}
export async function editRow(client: SqlClient, schema: string, table: string, input: Row): Promise<Row> {
  const cols = await columns(client, schema, table), action = input['action'];
  const pk = cols.filter(c => c.primary), values: unknown[] = [];
  const bind = (v: unknown) => { values.push(v); return '$' + values.length; };
  const target = identifier(schema) + '.' + identifier(table);
  let sql: string;
  if (action === 'insert' || action === 'update') {
    const data = object(input['values']), keys = Object.keys(data);
    if ((action === 'update' && !keys.length) || keys.length > cols.length || keys.some(k => !cols.some(c => c.name === k && !c.generated)))
      throw new DatabaseError(400, 'Use somente colunas editáveis; omita campos automáticos.');
    sql = action === 'insert' ? (keys.length ? 'INSERT INTO ' + target + ' (' + keys.map(identifier).join(',') + ') VALUES (' + keys.map(k => bind(data[k])).join(',') + ')' :
      'INSERT INTO ' + target + ' DEFAULT VALUES') :
      'UPDATE ' + target + ' SET ' + keys.map(k => identifier(k) + '=' + bind(data[k])).join(',');
  } else if (action === 'delete') sql = 'DELETE FROM ' + target;
  else throw new DatabaseError(400, 'Ação inválida.');
  if (action !== 'insert') {
    if (!pk.length) throw new DatabaseError(403, 'Esta tabela não possui chave primária. Use o SQL com confirmação.');
    const key = object(input['key']);
    if (pk.some(c => !Object.hasOwn(key, c.name)) || Object.keys(key).length !== pk.length || !/^\d+$/.test(String(input['version'])))
      throw new DatabaseError(400, 'Chave e versão do registro são obrigatórias.');
    sql += ' WHERE ' + pk.map(c => identifier(c.name) + ' IS NOT DISTINCT FROM ' + bind(key[c.name])).join(' AND ') + ' AND xmin::text=' + bind(input['version']);
  }
  const result = await client.query(sql, values);
  if (result.rowCount !== 1) throw new DatabaseError(409, 'O registro foi alterado ou excluído. Atualize a tabela antes de tentar novamente.');
  return {ok: true, affectedRows: result.rowCount};
}
type Backup = {id: string; database: string; sizeBytes: number; sha256: string; createdAt: string};
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function backupRoot(dataDir: string): string {
  const dir = join(dataDir, 'database-backups'); mkdirSync(dir, {recursive: true, mode: 0o700});
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077)) throw new DatabaseError(503, 'Pasta de backups sem proteção adequada.');
  return dir;
}
function backups(dataDir: string, database?: string): Backup[] {
  const dir = backupRoot(dataDir);
  return readdirSync(dir).filter(n => UUID.test(n.replace(/\.json$/, '')) && n.endsWith('.json')).flatMap(n => {
    try { const p = join(dir,n); if (lstatSync(p).isSymbolicLink()) return [];
      const b = JSON.parse(readFileSync(p,'utf8')) as Backup;
      return UUID.test(b.id) && typeof b.database === 'string' && (database === undefined || b.database === database) ? [b] : []; } catch { return []; }
  }).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
}
function cliEnvironment(scope: Scope, env: Env): NodeJS.ProcessEnv {
  return {PATH: process.env['PATH'] || '/usr/local/bin:/usr/bin:/bin',
    PGHOST: env['PANEL_POSTGRES_HOST'] || 'vps-postgres', PGPORT: env['PANEL_POSTGRES_PORT'] || '5432',
    PGDATABASE: scope.database, PGUSER: scope.role, PGSSLMODE: 'verify-full', PGCONNECT_TIMEOUT: '5',
    PGSSLCERT: join(scope.credentials,'client.crt'), PGSSLKEY: join(scope.credentials,'client.key'),
    PGSSLROOTCERT: join(scope.credentials,'ca.crt'), PGAPPNAME: 'vps-panel-backup',
    PGOPTIONS: '-c statement_timeout=45000 -c lock_timeout=2000'};
}
async function command(command: 'pg_dump'|'pg_restore', args: string[], scope: Scope, env: Env, output?: string): Promise<void> {
  // libpq interprets --dbname strings containing '=' or URI prefixes as connection options.
  // Catalog identifiers remain fully quoted elsewhere; CLI backup names deliberately use a stricter contract.
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,62}$/.test(scope.database))
    throw new DatabaseError(400,'Backup pelo painel requer nome de banco com letras, números, pontos, traços ou sublinhados.');
  await new Promise<void>((resolve,reject) => {
    const fd = output ? openSync(output, 'wx', 0o600) : null;
    const child = spawn(command, args, {env: cliEnvironment(scope, env), stdio: ['ignore',fd ?? 'ignore','ignore']});
    if (fd !== null) closeSync(fd);
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 60_000);
    const sizeTimer = output ? setInterval(() => { try { if (lstatSync(output).size > 64*1024*1024) child.kill('SIGKILL'); } catch { /* creating */ } },100) : null;
    const clear = () => { clearTimeout(timer); if (sizeTimer) clearInterval(sizeTimer); };
    child.once('error', () => { clear(); reject(new DatabaseError(503, 'Cliente PostgreSQL indisponível.')); });
    child.once('close', code => { clear(); code === 0 ? resolve() : reject(new DatabaseError(422, 'Backup/restauração não concluído. Verifique permissões, espaço e limite de 60 segundos/64 MB.')); });
  });
}
async function makeBackup(scope: Scope, dataDir: string, env: Env): Promise<Backup> {
  const dir = backupRoot(dataDir), files = readdirSync(dir);
  const used = files.reduce((sum,n) => sum + lstatSync(join(dir,n)).size,0);
  if (used > 192*1024*1024 || files.length >= 80) throw new DatabaseError(409, 'Limite de backups locais atingido. Baixe e remova backups antigos.');
  const id = randomUUID(), path = join(dir,id+'.dump');
  try {
    await command('pg_dump',['--format=custom','--no-owner','--no-acl','--no-password', '--role='+scope.owner, '--dbname='+scope.database],scope,env,path);
    const sizeBytes = lstatSync(path).size;
    if (sizeBytes > 64*1024*1024) throw new DatabaseError(413, 'Backup excede 64 MB.');
    const backup = {id,database:scope.database,sizeBytes,sha256:fileHash(path),createdAt:new Date().toISOString()};
    writeFileSync(join(dir,id+'.json'),JSON.stringify(backup)+'\n',{mode:0o600,flag:'wx'});
    chmodSync(path,0o600); return backup;
  } catch(error) { rmSync(path,{force:true}); throw error; }
}
function fileHash(path: string): string {
  const digest = createHash('sha256'), fd = openSync(path,'r'), buffer = Buffer.alloc(65536);
  try { let count: number; while ((count=readSync(fd,buffer,0,buffer.length,null))>0) digest.update(buffer.subarray(0,count)); }
  finally { closeSync(fd); }
  return digest.digest('hex');
}
async function tableList(client: SqlClient): Promise<Row> {
  const result = await client.query(`SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
    pg_total_relation_size(c.oid)::text AS size_bytes, c.reltuples::bigint::text AS estimated_rows
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p','v','m') AND n.nspname<>'information_schema' AND n.nspname !~ '^pg_' ORDER BY n.nspname,c.relname LIMIT 200`);
  return {tables:result.rows};
}
function accessPrefix(database: string): string {
  return 'u_access_' + createHash('sha256').update(database).digest('hex').slice(0,8) + '_';
}
async function grantAccess(scope: Scope, input: Row, dataDir: string, env: Env): Promise<Row> {
  confirmation(input,scope.database);
  const name = input['name'], permission = input['permission'];
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{1,11}$/.test(name) || !['read','write','none'].includes(String(permission)))
    throw new DatabaseError(400,'Use um nome de 2 a 12 letras/números/traços e escolha leitura, leitura/gravação ou revogar.');
  const role = accessPrefix(scope.database) + name.replaceAll('-','_'), quoted = identifier(role);
  const admin = await administrator(env);
  try {
    const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rows.length>0;
    if (!exists) {
      if (permission === 'none') throw new DatabaseError(404,'Identidade não encontrada.');
      const count = await admin.query('SELECT count(*)::int AS count FROM pg_roles WHERE left(rolname,$1)=$2',[accessPrefix(scope.database).length,accessPrefix(scope.database)]);
      if (Number(count.rows[0]?.['count'])>=20) throw new DatabaseError(409,'Limite de 20 identidades por banco atingido.');
      const cert = issueCertificate(role,dataDir,env,scope.database);
      let created = false;
      try {
        await admin.query('CREATE ROLE '+quoted+' LOGIN CONNECTION LIMIT 5 PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
        created=true;await admin.query('GRANT '+identifier(CERTIFICATE_GROUP)+' TO '+quoted);cert.publish();
      } catch(error) {if(created)await admin.query('DROP ROLE '+quoted).catch(()=>{});throw error;}
      finally{cert.cleanup();}
    } else {
      projectTls(role,dataDir,scope.database);
      const check=await admin.query('SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,ARRAY(SELECT p.rolname::text FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid WHERE m.member=r.oid ORDER BY p.rolname) AS memberships FROM pg_roles r WHERE r.rolname=$1',[role]);
      const r=check.rows[0];
      if(!r||['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'].some(k=>r[k]!==false)||JSON.stringify(r['memberships'])!==JSON.stringify([CERTIFICATE_GROUP]))
        throw new DatabaseError(403,'Esta identidade foi alterada fora do painel; revise antes de conceder acesso.');
    }
  } finally {await admin.end().catch(()=>{});}
  const client=scope.client;
  await client.query('BEGIN');
  try {
    const schemas=await client.query("SELECT nspname AS name FROM pg_namespace WHERE nspname<>'information_schema' AND nspname !~ '^pg_' AND pg_has_role(nspowner,'USAGE') ORDER BY nspname LIMIT 100");
    for(const s of schemas.rows){
      const schema=identifier(s['name']);
      await client.query('REVOKE ALL ON ALL TABLES IN SCHEMA '+schema+' FROM '+quoted);
      await client.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA '+schema+' FROM '+quoted);
      await client.query('ALTER DEFAULT PRIVILEGES FOR ROLE '+identifier(scope.owner)+' IN SCHEMA '+schema+' REVOKE ALL ON TABLES FROM '+quoted);
      await client.query('ALTER DEFAULT PRIVILEGES FOR ROLE '+identifier(scope.owner)+' IN SCHEMA '+schema+' REVOKE ALL ON SEQUENCES FROM '+quoted);
      if(permission==='none')await client.query('REVOKE ALL ON SCHEMA '+schema+' FROM '+quoted);
      else {
        await client.query('GRANT USAGE ON SCHEMA '+schema+' TO '+quoted);
        const privileges=permission==='write'?'SELECT,INSERT,UPDATE,DELETE':'SELECT';
        await client.query('GRANT '+privileges+' ON ALL TABLES IN SCHEMA '+schema+' TO '+quoted);
        await client.query('ALTER DEFAULT PRIVILEGES FOR ROLE '+identifier(scope.owner)+' IN SCHEMA '+schema+' GRANT '+privileges+' ON TABLES TO '+quoted);
        if(permission==='write'){
          await client.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA '+schema+' TO '+quoted);
          await client.query('ALTER DEFAULT PRIVILEGES FOR ROLE '+identifier(scope.owner)+' IN SCHEMA '+schema+' GRANT USAGE,SELECT ON SEQUENCES TO '+quoted);
        }
      }
    }
    await client.query((permission==='none'?'REVOKE CONNECT ON DATABASE ':'GRANT CONNECT ON DATABASE ')+identifier(scope.database)+(permission==='none'?' FROM ':' TO ')+quoted);
    await client.query('COMMIT');
    const authority=await administrator(env);
    try{await authority.query('ALTER ROLE '+quoted+(permission==='none'?' NOLOGIN':' LOGIN'));}
    finally{await authority.end().catch(()=>{});}
    return {ok:true,identity:role,permission,credentialsStored:true,message:permission==='none'?'Permissões concedidas pelo painel revogadas.':'Acesso configurado para tabelas atuais e futuras criadas pelo proprietário. Certificado privado guardado somente na VPS.'};
  } catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
}
type Dependencies = {send(res: ServerResponse,status: number,data: unknown): void;
  body(req: IncomingMessage): Promise<Row>; dataDir: string; env?: Env};
export async function handleDatabaseAdminRoute(req: IncomingMessage, res: ServerResponse, deps: Dependencies): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://panel.local');
  if (!url.pathname.startsWith('/database/admin/')) return false;
  const env = deps.env || process.env, start = Date.now();
  let scope: Scope | undefined;
  let database = '', action = '';
  try {
    if (url.pathname === '/database/admin/backups' && req.method === 'GET') {
      const admin = await administrator(env); await admin.end();
      deps.send(res,200,{backups:backups(deps.dataDir)}); return true;
    }
    const match = /^\/database\/admin\/([^/]+)\/(tables|rows|sql|backups|backup-part|restore|delete|access)$/.exec(url.pathname);
    if (!match) throw new DatabaseError(404,'Operação de banco desconhecida.');
    database = decodeURIComponent(match[1]!); action = match[2]!;
    const method = req.method || 'GET';
    if (!['GET','POST'].includes(method) || (method === 'GET' && !['tables','rows','backups','backup-part','access'].includes(action)))
      throw new DatabaseError(405,'Método não permitido.');
    const input = method === 'POST' ? await deps.body(req) : {};
    // Backup files remain recoverable even after the source database was deleted.
    if ((method === 'GET' && (action === 'backups' || action === 'backup-part')) ||
        (method === 'POST' && action === 'delete' && typeof input['backupId'] === 'string')) {
      const admin = await administrator(env); await admin.end();
      if (method === 'POST') confirmation(input,database);
    } else scope = await scoped(database,deps.dataDir,env);
    const client = scope?.client;
    const run = async (): Promise<Row> => {
      if (action === 'tables' && method === 'GET') return {...await tableList(client!),database,owner:scope!.owner};
      if (action === 'rows') {
        const schema = String(method === 'GET' ? url.searchParams.get('schema') || 'public' : input['schema']);
        const table = String(method === 'GET' ? url.searchParams.get('table') || '' : input['table']);
        if (method === 'POST') { confirmation(input, database); return editRow(client!,schema,table,input); }
        const cols = await columns(client!,schema,table), pk = cols.filter(c => c.primary).map(c => identifier(c.name));
        const offset = integer(url.searchParams.get('offset'),0,100_000);
        // JSON values are returned as strings for an exact, lossless round-trip of bigint/numeric.
        const select = cols.map(c => identifier(c.name) + '::text AS ' + identifier(c.name)).join(',');
        const r = await client!.query('SELECT xmin::text AS "__panel_version",' + select + ' FROM ' + identifier(schema)+'.'+identifier(table) +
          (pk.length ? ' ORDER BY '+pk.join(',') : '') + ' LIMIT 51 OFFSET $1',[offset]);
        if (Buffer.byteLength(JSON.stringify(r.rows))>512_000) throw new DatabaseError(413,'Tabela com valores grandes. Use o SQL para selecionar menos colunas.');
        return {columns:cols,rows:r.rows.slice(0,50),hasMore:r.rows.length>50,offset};
      }
      if (action === 'sql' && method === 'POST') {
        const write = input['write'] === true;
        if (write) confirmation(input,database);
        if (typeof input['sql'] !== 'string') throw new DatabaseError(400,'Informe o SQL.');
        return boundedSql(client!,input['sql'],write);
      }
      if (action === 'backups') return method === 'GET' ? {backups:backups(deps.dataDir,database),limitBytes:64*1024*1024} :
        {ok:true,backup:await makeBackup(scope!,deps.dataDir,env)};
      if (action === 'backup-part' && method === 'GET') {
        const id = url.searchParams.get('id'), backup = backups(deps.dataDir,database).find(b => b.id === id);
        if (!backup) throw new DatabaseError(404,'Backup não encontrado.');
        const path = join(backupRoot(deps.dataDir),backup.id+'.dump'), st = lstatSync(path);
        if (!st.isFile() || st.isSymbolicLink() || st.size !== backup.sizeBytes) throw new DatabaseError(409,'Arquivo do backup alterado.');
        const offset = integer(url.searchParams.get('offset'),0,backup.sizeBytes), fd = openSync(path,'r'), buffer = Buffer.alloc(65536);
        try { const count = readSync(fd,buffer,0,buffer.length,offset); return {id:backup.id,offset,next:offset+count,total:backup.sizeBytes,data:buffer.subarray(0,count).toString('base64')}; }
        finally { closeSync(fd); }
      }
      if (action === 'restore' && method === 'POST') {
        confirmation(input,database);
        const id = input['backupId'], source = input['sourceDatabase'];
        if (typeof source !== 'string') throw new DatabaseError(400,'Informe o banco de origem.');
        const backup = backups(deps.dataDir,source).find(b => b.id === id);
        if (!backup) throw new DatabaseError(404,'Backup não encontrado.');
        const existing = (await tableList(client!))['tables'];
        if (Array.isArray(existing) && existing.length)
          throw new DatabaseError(409,'Restaure somente em um banco vazio. Crie um novo banco e escolha o backup.');
        const path = join(backupRoot(deps.dataDir),backup.id+'.dump'), st = lstatSync(path);
        if (!st.isFile() || st.isSymbolicLink() || st.size!==backup.sizeBytes || fileHash(path)!==backup.sha256)
          throw new DatabaseError(409,'A integridade do backup não foi confirmada.');
        await command('pg_restore',['--single-transaction','--exit-on-error','--no-owner','--no-acl','--no-password','--role='+scope!.owner,'--dbname='+database,path],scope!,env);
        return {ok:true,message:'Backup restaurado no banco vazio. A origem foi preservada.'};
      }
      if (action === 'delete' && method === 'POST') {
        confirmation(input,database);
        if (typeof input['backupId'] === 'string') {
          const backup = backups(deps.dataDir,database).find(b => b.id === input['backupId']);
          if (!backup) throw new DatabaseError(404,'Backup não encontrado.');
          const dir = backupRoot(deps.dataDir); rmSync(join(dir,backup.id+'.dump')); rmSync(join(dir,backup.id+'.json'));
          return {ok:true,message:'Backup local excluído.'};
        }
        // No FORCE or CASCADE: active clients and dependent objects must be reviewed by the operator.
        const backup = await makeBackup(scope!,deps.dataDir,env);
        await client!.end();
        const admin = await administrator(env);
        try { await databaseIdentity(admin,database); await admin.query('DROP DATABASE '+identifier(database)); }
        finally { await admin.end().catch(() => {}); }
        return {ok:true,backup,message:'Banco excluído; backup de segurança preservado. Identidades e arquivos privados não foram removidos.'};
      }
      if (action === 'access' && method === 'POST') return grantAccess(scope!,input,deps.dataDir,env);
      if (action === 'access' && method === 'GET') {
        const r = await client!.query('SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema NOT IN (\'pg_catalog\',\'information_schema\') AND grantee NOT LIKE \'pg_%\' GROUP BY grantee, privilege_type ORDER BY grantee,privilege_type LIMIT 100');
        const identities=await client!.query('SELECT rolname AS name,rolcanlogin AS login FROM pg_roles WHERE left(rolname,$1)=$2 ORDER BY rolname',[accessPrefix(database).length,accessPrefix(database)]);
        return {database,owner:scope!.owner,identity:scope!.role,identities:identities.rows,host:env['PANEL_POSTGRES_HOST']||'vps-postgres',port:Number(env['PANEL_POSTGRES_PORT']||5432),
          authentication:'client-certificate',credentialsStored:true,grants:r.rows,
          message:'Certificados privados permanecem na VPS. Permissões de tabelas podem ser administradas pelo SQL deste banco; alterações globais de superusuário são bloqueadas.'};
      }
      throw new DatabaseError(405,'Método não permitido.');
    };
    const result = method === 'POST' ? await exclusive(database,run) : await run();
    // Audit metadata only. No SQL, record contents, key material, passwords or dump data.
    if (method === 'POST') console.log(JSON.stringify({event:'database_admin',database,action,ok:true,durationMs:Date.now()-start}));
    deps.send(res,200,result);
  } catch(error) {
    const f = failure(error);
    console.warn(JSON.stringify({event:'database_admin',database,action,ok:false,status:f.status,code:f.code||'REJECTED',durationMs:Date.now()-start}));
    deps.send(res,f.status,{error:f.error,...(f.code?{code:f.code}:{})});
  } finally { await scope?.client.end().catch(() => {}); }
  return true;
}
