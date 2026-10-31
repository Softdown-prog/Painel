import { adminTls, signerReady, issueCertificate, type TlsMaterial, type IssuedCertificate } from "./postgres-cert.ts";
import { existsSync } from "node:fs";
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
  hostAuthentication: "trust" | "cert" | "other" | "unknown";
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

function options(env: Environment, ssl?: TlsMaterial, role?: string, database?: string): Record<string, unknown> {
  const port = Number(env.PANEL_POSTGRES_PORT || 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
  return {
    host: env.PANEL_POSTGRES_HOST || "vps-postgres", port,
    user: role || env.PANEL_POSTGRES_USER || "postgres",
    database: database || env.PANEL_POSTGRES_DB || "postgres",
    ...(ssl ? { ssl: { ...ssl, servername: env.PANEL_POSTGRES_HOST || "vps-postgres" } } : {}),
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
  if (hosts.every(r => r.auth_method === "reject" ||
      (r.type === "hostssl" && r.auth_method === "cert")) &&
      hosts.some(r => r.type === "hostssl" && r.auth_method === "cert")) return "cert";
  return "other";
}
function security(auth: Security["hostAuthentication"], env: Environment): Security {
  const configured = env.PANEL_POSTGRES_WRITE_ENABLED === "1" && signerReady(env);
  const provisioningEnabled = auth === "cert" && configured;
  const message = auth === "trust"
    ? "Atenção: PostgreSQL ainda usa trust. Qualquer container na rede pode assumir outra identidade. Criação bloqueada."
    : auth === "cert" && !configured
      ? "Autenticação por certificado detectada. Falta ativar o provisionamento e instalar os certificados privados."
      : provisioningEnabled
        ? "Autenticação por certificados ativa. Cada projeto terá banco e identidade próprios, sem senhas."
        : "Certificados TLS obrigatórios ainda não foram confirmados. Criação bloqueada, sem exigir senhas.";
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
    client = create(options(env, adminTls(env)));
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
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function names(slug: string): { db: string; role: string } {
  const name = slug.replaceAll("-", "_");
  return { db: "p_" + name, role: "u_" + name };
}
export async function createProjectDatabase(
  slug: string, dataDir: string, env: Environment = process.env,
  factory?: ClientFactory, issuer: typeof issueCertificate = issueCertificate,
): Promise<{ project: string; database: string; username: string; credentialsStored: boolean }> {
  if (!SLUG.test(slug)) throw new ProvisionError(400, "Use 2 a 30 caracteres: letras minúsculas, números e traços.");
  if (env.PANEL_POSTGRES_ENABLED !== "1" || env.PANEL_POSTGRES_WRITE_ENABLED !== "1")
    throw new ProvisionError(403, "Criação de bancos ainda não habilitada nesta VPS.");
  if (!signerReady(env))
    throw new ProvisionError(403, "Certificados PostgreSQL ainda não estão instalados. Nenhuma senha é necessária.");
  if (provisioning) throw new ProvisionError(429, "Outra criação de banco está em andamento.");
  provisioning = true;
  let client: Client | undefined;
  let createdRole = false, createdDb = false, issued: IssuedCertificate | undefined;
  const pair = names(slug);
  let create: ClientFactory;
  const connectAs = async (ssl?: TlsMaterial, role?: string, database?: string): Promise<Client> => {
    const session = create(options(env, ssl, role, database));
    try { await session.connect(); return session; }
    catch (error) { await session.end().catch(() => {}); throw error; }
  };
  const expectedDenial = (error: unknown): boolean =>
    !!error && typeof error === "object" && "code" in error &&
    error.code === "28000";
  try {
    create = await factoryOrPg(factory);
    const admin = adminTls(env);
    if (!admin) throw new ProvisionError(403, "Conexão administrativa por certificado não configurada.");
    if (existsSync(join(dataDir, "database-credentials", slug)))
      throw new ProvisionError(409, "Projeto já possui certificados registrados nesta VPS.");
    client = await connectAs(admin);
    const rules = await client.query("SELECT type, auth_method, error FROM pg_hba_file_rules ORDER BY line_number");
    if (assessRules(rules.rows) !== "cert")
      throw new ProvisionError(403, "O PostgreSQL ainda aceita conexões sem certificado. Criação bloqueada.");
    const live = await client.query("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()");
    if (live.rows[0]?.ssl !== true)
      throw new ProvisionError(403, "A conexão administrativa não usa TLS.");
    // HBA view alone can show an unreloaded file. Prove the live server rejects
    // the existing administrative user when no client certificate is presented.
    let rejected = false;
    try {
      const bare = await connectAs({ ca: admin.ca, cert: "", key: "", rejectUnauthorized: true });
      await bare.end();
    } catch (error) { rejected = expectedDenial(error); }
    if (!rejected)
      throw new ProvisionError(403, "O servidor não confirmou a recusa de clientes sem certificado.");
    const authority = await client.query("SELECT rolsuper AS superuser FROM pg_roles WHERE rolname=current_user");
    if (authority.rows[0]?.superuser !== true)
      throw new ProvisionError(403, "Identidade administrativa não pode criar bancos.");
    const existing = await client.query(
      "SELECT (SELECT COUNT(*)::int FROM pg_database WHERE left(datname,2) = 'p_') AS databases, " +
      "(SELECT COUNT(*)::int FROM pg_database WHERE datname = '" + pair.db + "') AS database_exists, " +
      "(SELECT COUNT(*)::int FROM pg_roles WHERE rolname = '" + pair.role + "') AS role_exists"
    );
    if (Number(existing.rows[0]?.databases) >= MAX_MANAGED)
      throw new ProvisionError(409, "Limite de 40 bancos gerenciados atingido.");
    if (Number(existing.rows[0]?.database_exists) !== 0 || Number(existing.rows[0]?.role_exists) !== 0)
      throw new ProvisionError(409, "Banco ou conta já existe; nada foi alterado.");
    // CA private key stays in the Panel's private mounted volume; neither
    // the key nor the issued certificate is returned to the browser.
    issued = issuer(pair.role, dataDir, env);
    // Identifiers are derived only from the strictly validated ASCII slug.
    // No SQL or password supplied by the browser is interpolated.
    await client.query("CREATE ROLE " + pair.role +
      " LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    createdRole = true;
    await client.query("CREATE DATABASE " + pair.db + " OWNER " + pair.role);
    createdDb = true;
    await client.query("REVOKE ALL ON DATABASE " + pair.db + " FROM PUBLIC");
    // Prove role isolation: the admin's valid certificate must not authenticate
    // as the new project user because CN != requested database username.
    let crossDenied = false;
    try {
      const cross = await connectAs(admin, pair.role, pair.db);
      await cross.end();
    } catch (error) { crossDenied = expectedDenial(error); }
    if (!crossDenied)
      throw new ProvisionError(403, "Não foi possível comprovar isolamento dos certificados.");
    const projectClient = await connectAs(issued.client, pair.role, pair.db);
    try {
      const identity = await projectClient.query("SELECT current_user AS username, current_database() AS db");
      if (identity.rows[0]?.username !== pair.role || identity.rows[0]?.db !== pair.db)
        throw new ProvisionError(403, "Identidade do projeto não foi confirmada.");
    } finally { await projectClient.end().catch(() => {}); }
    issued.publish();
    console.log(JSON.stringify({ event: "postgres_project_certificate_created", project: slug, database: pair.db }));
    return { project: slug, database: pair.db, username: pair.role, credentialsStored: true };
  } catch (error) {
    if (client) {
      // A partially failed transaction is not silently classified as success.
      if (createdDb) {
        try { await client.query("DROP DATABASE " + pair.db); }
        catch { console.error("PostgreSQL rollback requires manual inspection:", pair.db); }
      }
      if (createdRole) {
        try { await client.query("DROP ROLE " + pair.role); }
        catch { console.error("PostgreSQL rollback requires manual inspection:", pair.role); }
      }
    }
    if (error instanceof ProvisionError) throw error;
    console.warn("PostgreSQL certificate provisioning failed:", error instanceof Error ? error.name : "unknown");
    throw new ProvisionError(502, "Falha ao criar o banco. Confira o estado antes de repetir.");
  } finally {
    issued?.cleanup();
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
      send(res, 201, { ok: true, ...created, message: "Banco criado; certificado de acesso sem senha guardado somente na VPS." });
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
