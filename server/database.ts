import { randomBytes } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

type Send = (res: ServerResponse, status: number, data: unknown) => void;
type Client = {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};
type ClientFactory = (options: Record<string, unknown>) => Client;
type Security = {
  hostAuthentication: "trust" | "scram-sha-256" | "other" | "unknown";
  provisioningEnabled: boolean;
  message: string;
};
type DatabaseStatus = {
  engine: "postgresql";
  integration: "not_configured" | "connected" | "unavailable";
  enabled: boolean;
  instance: { version: string } | null;
  databases: { name: string; owner: string; sizeBytes: number }[] | null;
  roles: { name: string; canLogin: boolean; superuser: boolean }[] | null;
  security: Security;
  metrics: { databaseCount: number; connections: number; totalBytes: number } | null;
  checkedAt: string;
  message: string;
};
type Environment = NodeJS.ProcessEnv;
const SLUG = /^[a-z][a-z0-9-]{1,29}$/;
const MAX_MANAGED = 40;
let provisioning = false;

function passwordFile(env: Environment): string | undefined {
  const file = env.PANEL_POSTGRES_PASSWORD_FILE;
  if (!file || !file.startsWith("/") || !existsSync(file)) return;
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) return;
    const password = readFileSync(file, "utf8").trim();
    if (password.length >= 24 && password.length <= 512 && !/[\u0000-\u001f]/.test(password)) return password;
  } catch { /* Missing private admin credential. */ }
}
function options(env: Environment, password?: string): Record<string, unknown> {
  const port = Number(env.PANEL_POSTGRES_PORT || 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
  return {
    host: env.PANEL_POSTGRES_HOST || "vps-postgres", port,
    user: env.PANEL_POSTGRES_USER || "postgres",
    database: env.PANEL_POSTGRES_DB || "postgres",
    ...(password !== undefined ? { password } : {}),
    connectionTimeoutMillis: 3000, query_timeout: 4000, statement_timeout: 4000,
    application_name: "vps-panel-database",
  };
}
async function factoryOrPg(factory?: ClientFactory): Promise<ClientFactory> {
  if (factory) return factory;
  // @ts-ignore: pg is bundled in the API image, not in frontend packages.
  const { Client: PgClient } = await import("pg");
  return (config: Record<string, unknown>) => new PgClient(config) as Client;
}
function assessRules(rows: Record<string, unknown>[]): Security["hostAuthentication"] {
  if (!rows.length || rows.some(r => r.error !== null && r.error !== undefined)) return "unknown";
  const hosts = rows.filter(r => typeof r.type === "string" && r.type.startsWith("host"));
  if (!hosts.length) return "unknown";
  if (hosts.some(r => r.auth_method === "trust")) return "trust";
  if (hosts.every(r => r.auth_method === "scram-sha-256" || r.auth_method === "reject") &&
      hosts.some(r => r.auth_method === "scram-sha-256")) return "scram-sha-256";
  return "other";
}
function security(auth: Security["hostAuthentication"], env: Environment): Security {
  const configured = env.PANEL_POSTGRES_WRITE_ENABLED === "1" && Boolean(passwordFile(env));
  const provisioningEnabled = auth === "scram-sha-256" && configured;
  const message = auth === "trust"
    ? "Atenção: PostgreSQL permite conexão sem senha (trust). Não há isolamento real entre projetos; criação bloqueada."
    : auth === "scram-sha-256" && !configured
      ? "Autenticação SCRAM encontrada. Falta habilitar provisionamento e instalar uma credencial administrativa privada."
      : provisioningEnabled
        ? "Autenticação SCRAM e provisionamento habilitados. Uma conta diferente será criada para cada banco."
        : "O método de autenticação não foi confirmado como seguro para criar contas. Provisionamento bloqueado.";
  return { hostAuthentication: auth, provisioningEnabled, message };
}
export async function getDatabaseStatus(
  env: Environment = process.env, factory?: ClientFactory,
): Promise<DatabaseStatus> {
  const base: DatabaseStatus = {
    engine: "postgresql", integration: "not_configured", enabled: false,
    instance: null, databases: null, roles: null, metrics: null,
    checkedAt: new Date().toISOString(),
    security: security("unknown", env),
    message: "A conexão com PostgreSQL ainda não foi habilitada na API do Painel.",
  };
  if (env.PANEL_POSTGRES_ENABLED !== "1") return base;
  let client: Client | undefined;
  try {
    const create = await factoryOrPg(factory);
    client = create(options(env, passwordFile(env)));
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    const info = await client.query(
      "SELECT current_setting('server_version') AS version, " +
      "(SELECT COUNT(*)::int FROM pg_database WHERE NOT datistemplate) AS database_count, " +
      "(SELECT COUNT(*)::int FROM pg_stat_activity) AS connections, " +
      "(SELECT COALESCE(SUM(pg_database_size(oid)),0)::text FROM pg_database WHERE NOT datistemplate) AS total_bytes"
    );
    const names = await client.query(
      "SELECT datname AS name, pg_get_userbyid(datdba) AS owner, " +
      "pg_database_size(oid)::text AS size_bytes FROM pg_database " +
      "WHERE NOT datistemplate ORDER BY datname LIMIT 100"
    );
    const roles = await client.query(
      "SELECT rolname AS name, rolcanlogin AS can_login, rolsuper AS superuser " +
      "FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname LIMIT 100"
    );
    // This is a diagnostic, not proof that pg_hba.conf has been reloaded.
    // The provisioning route additionally tests a deliberately incorrect password.
    const rules = await client.query(
      "SELECT type, auth_method, error FROM pg_hba_file_rules ORDER BY line_number"
    );
    const row = info.rows[0];
    if (!row || typeof row.version !== "string") throw new Error("bad response");
    const auth = assessRules(rules.rows);
    return {
      ...base, enabled: true, integration: "connected",
      instance: { version: row.version },
      databases: names.rows.map(db => ({
        name: String(db.name), owner: String(db.owner), sizeBytes: Number(db.size_bytes),
      })),
      roles: roles.rows.map(role => ({
        name: String(role.name), canLogin: role.can_login === true, superuser: role.superuser === true,
      })),
      security: security(auth, env),
      metrics: {
        databaseCount: Number(row.database_count),
        connections: Number(row.connections),
        totalBytes: Number(row.total_bytes),
      },
      message: "PostgreSQL conectado; inventário e autenticação consultados.",
    };
  } catch (error) {
    console.warn("PostgreSQL status failed:", error instanceof Error ? error.name : "unknown");
    return {
      ...base, integration: "unavailable", enabled: true,
      message: "PostgreSQL indisponível. Confira o serviço e a rede privada da API.",
    };
  } finally {
    if (client) { try { await client.end(); } catch { /* already closed */ } }
  }
}
class ProvisionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function names(slug: string): { db: string; role: string } {
  const name = slug.replaceAll("-", "_");
  return { db: "p_" + name, role: "u_" + name };
}
function credentialDirectory(dataDir: string): string {
  const dir = join(dataDir, "database-credentials");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new ProvisionError(503, "Diretório de credenciais sem proteção adequada na VPS.");
  return dir;
}
function saveCredential(dir: string, slug: string, record: Record<string, string>): string {
  const file = join(dir, slug + ".json");
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, JSON.stringify(record) + "\n"); }
  catch (error) { try { unlinkSync(file); } catch { /* already removed */ } throw error; }
  finally { closeSync(fd); }
  return file;
}
export async function createProjectDatabase(
  slug: string, dataDir: string, env: Environment = process.env, factory?: ClientFactory,
): Promise<{ project: string; database: string; username: string; credentialsStored: boolean }> {
  if (!SLUG.test(slug)) throw new ProvisionError(400, "Use 2 a 30 caracteres: letras minúsculas, números e traços.");
  if (env.PANEL_POSTGRES_ENABLED !== "1" || env.PANEL_POSTGRES_WRITE_ENABLED !== "1")
    throw new ProvisionError(403, "Criação de bancos ainda não habilitada nesta VPS.");
  const adminPassword = passwordFile(env);
  if (!adminPassword) throw new ProvisionError(403, "Credencial administrativa SCRAM privada ainda não configurada.");
  if (provisioning) throw new ProvisionError(429, "Outra criação de banco está em andamento.");
  provisioning = true;
  let client: Client | undefined;
  let createdRole = false, createdDb = false, secretFile: string | undefined;
  const pair = names(slug);
  try {
    const create = await factoryOrPg(factory);
    const dir = credentialDirectory(dataDir);
    if (existsSync(join(dir, slug + ".json")))
      throw new ProvisionError(409, "Projeto já possui credenciais registradas nesta VPS.");
    client = create(options(env, adminPassword));
    await client.connect();
    const rules = await client.query("SELECT type, auth_method, error FROM pg_hba_file_rules ORDER BY line_number");
    if (assessRules(rules.rows) !== "scram-sha-256")
      throw new ProvisionError(403, "Autenticação host SCRAM não confirmada. Nenhum banco foi criado.");
    // Check ACTIVE authentication: a wrong password MUST fail as 28P01.
    // Merely reading the HBA file can misreport a pending (unreloaded) change.
    let bad: Client | undefined;
    let denied = false;
    try {
      bad = create(options(env, randomBytes(48).toString("base64url")));
      await bad.connect();
    } catch (error) {
      denied = Boolean(error && typeof error === "object" && "code" in error && error.code === "28P01");
    } finally { if (bad) await bad.end().catch(() => {}); }
    if (!denied)
      throw new ProvisionError(403, "Não foi confirmado que o PostgreSQL rejeita senha incorreta. Operação bloqueada.");
    const admin = await client.query("SELECT rolsuper AS superuser FROM pg_roles WHERE rolname = current_user");
    if (admin.rows[0]?.superuser !== true)
      throw new ProvisionError(403, "Conta administrativa PostgreSQL não possui privilégio para criar bancos.");
    const existing = await client.query(
      "SELECT (SELECT COUNT(*)::int FROM pg_database WHERE left(datname,2) = 'p_') AS databases, " +
      "(SELECT COUNT(*)::int FROM pg_database WHERE datname = '" + pair.db + "') AS database_exists, " +
      "(SELECT COUNT(*)::int FROM pg_roles WHERE rolname = '" + pair.role + "') AS role_exists"
    );
    if (Number(existing.rows[0]?.databases) >= MAX_MANAGED)
      throw new ProvisionError(409, "Limite de 40 bancos gerenciados atingido.");
    if (Number(existing.rows[0]?.database_exists) !== 0 || Number(existing.rows[0]?.role_exists) !== 0)
      throw new ProvisionError(409, "Banco ou conta já existe. Nada foi alterado.");
    const generated = randomBytes(48).toString("base64url");
    // Identifiers derive exclusively from a strict ASCII slug. Generated password
    // is base64url, so it cannot contain SQL delimiters. No browser-supplied SQL.
    await client.query("CREATE ROLE " + pair.role +
      " LOGIN PASSWORD '" + generated + "' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    createdRole = true;
    await client.query("CREATE DATABASE " + pair.db + " OWNER " + pair.role);
    createdDb = true;
    await client.query("REVOKE ALL ON DATABASE " + pair.db + " FROM PUBLIC");
    secretFile = saveCredential(dir, slug, {
      project: slug, database: pair.db, username: pair.role, password: generated,
      host: env.PANEL_POSTGRES_HOST || "vps-postgres", port: String(env.PANEL_POSTGRES_PORT || 5432),
      createdAt: new Date().toISOString(),
    });
    console.log(JSON.stringify({ event: "postgres_project_created", project: slug, database: pair.db }));
    return { project: slug, database: pair.db, username: pair.role, credentialsStored: true };
  } catch (error) {
    if (client) {
      if (createdDb) {
        try { await client.query("DROP DATABASE " + pair.db); } catch { /* inspect manually */ }
      }
      if (createdRole) {
        try { await client.query("DROP ROLE " + pair.role); } catch { /* inspect manually */ }
      }
    }
    if (secretFile) { try { unlinkSync(secretFile); } catch { /* inspect manually */ } }
    if (error instanceof ProvisionError) throw error;
    console.warn("PostgreSQL provisioning failed:", error instanceof Error ? error.name : "unknown");
    throw new ProvisionError(502, "Não foi possível criar o banco. Confira o PostgreSQL antes de repetir.");
  } finally {
    if (client) await client.end().catch(() => {});
    provisioning = false;
  }
}
type Dependencies = {
  send: Send;
  body?: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  loadStatus?: () => Promise<DatabaseStatus>;
  create?: (slug: string) => ReturnType<typeof createProjectDatabase>;
  dataDir?: string;
};
export async function handleDatabaseRoute(
  req: IncomingMessage, res: ServerResponse,
  { send, body, loadStatus = getDatabaseStatus, create, dataDir = process.env.PANEL_DATA_DIR || "/data" }: Dependencies,
): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://panel.local").pathname;
  if (path !== "/database" && !path.startsWith("/database/")) return false;
  if (path === "/database/status" && req.method === "GET") {
    send(res, 200, await loadStatus());
    return true;
  }
  if (path === "/database/projects" && req.method === "POST") {
    try {
      if (!body) throw new ProvisionError(503, "Leitura da requisição não configurada.");
      const input = await body(req);
      if (!input || Object.keys(input).join(",") !== "project" || typeof input.project !== "string")
        throw new ProvisionError(400, "Informe somente o identificador do projeto.");
      const created = await (create || ((slug: string) => createProjectDatabase(slug, dataDir)))(input.project);
      send(res, 201, { ok: true, ...created, message: "Banco criado. Credencial gerada e armazenada somente na VPS." });
    } catch (error) {
      if (error instanceof ProvisionError) send(res, error.status, { error: error.message });
      else {
        console.warn("Database route failed:", error instanceof Error ? error.name : "unknown");
        send(res, 502, { error: "Não foi possível criar o banco; confira o estado antes de repetir." });
      }
    }
    return true;
  }
  if (path === "/database/status") {
    send(res, 405, { error: "Este endpoint aceita apenas consulta." });
    return true;
  }
  send(res, 503, { code: "DATABASE_OPERATIONS_DISABLED", error: "Operação não habilitada." });
  return true;
}
