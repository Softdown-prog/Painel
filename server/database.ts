import type { IncomingMessage, ServerResponse } from "node:http";

type Send = (res: ServerResponse, status: number, data: unknown) => void;
type Client = {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};
type ClientFactory = (options: Record<string, unknown>) => Client;
type DatabaseStatus = {
  engine: "postgresql";
  integration: "not_configured" | "connected" | "unavailable";
  enabled: boolean;
  instance: { version: string } | null;
  databases: { name: string; owner: string; sizeBytes: number }[] | null;
  metrics: { databaseCount: number; connections: number; totalBytes: number } | null;
  checkedAt: string;
  message: string;
};

export async function getDatabaseStatus(
  env: NodeJS.ProcessEnv = process.env,
  factory?: ClientFactory,
): Promise<DatabaseStatus> {
  const base: DatabaseStatus = {
    engine: "postgresql", integration: "not_configured", enabled: false,
    instance: null, databases: null, metrics: null,
    checkedAt: new Date().toISOString(),
    message: "A conexão com PostgreSQL ainda não foi habilitada na API do Painel.",
  };
  if (env.PANEL_POSTGRES_ENABLED !== "1") return base;
  let client: Client | undefined;
  try {
    if (!factory) {
      // @ts-ignore - driver installed in the API container rather than frontend tooling
      const { Client: PgClient } = await import("pg");
      factory = (options: Record<string, unknown>) => new PgClient(options) as Client;
    }
    const port = Number(env.PANEL_POSTGRES_PORT || 5432);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
    client = factory({
      host: env.PANEL_POSTGRES_HOST || "vps-postgres",
      port,
      user: env.PANEL_POSTGRES_USER || "postgres",
      database: env.PANEL_POSTGRES_DB || "postgres",
      connectionTimeoutMillis: 3000,
      query_timeout: 4000,
      statement_timeout: 4000,
      application_name: "vps-panel-readonly",
    });
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
    const row = info.rows[0];
    if (!row || typeof row.version !== "string") throw new Error("bad response");
    return {
      ...base, enabled: true, integration: "connected",
      instance: { version: row.version },
      databases: names.rows.map(db => ({
        name: String(db.name), owner: String(db.owner), sizeBytes: Number(db.size_bytes),
      })),
      metrics: {
        databaseCount: Number(row.database_count),
        connections: Number(row.connections),
        totalBytes: Number(row.total_bytes),
      },
      message: "PostgreSQL conectado e consultado em modo somente leitura.",
    };
  } catch (error) {
    // Never return the raw exception or connection information to the browser.
    console.warn("PostgreSQL status failed:", error instanceof Error ? error.name : "unknown");
    return {
      ...base, integration: "unavailable", enabled: true,
      message: "PostgreSQL indisponível. Confira o serviço e a rede privada da API.",
    };
  } finally {
    if (client) { try { await client.end(); } catch { /* already closed */ } }
  }
}

type Dependencies = { send: Send; loadStatus?: () => Promise<DatabaseStatus> };
export async function handleDatabaseRoute(
  req: IncomingMessage, res: ServerResponse, { send, loadStatus = getDatabaseStatus }: Dependencies,
): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://panel.local").pathname;
  if (path !== "/database" && !path.startsWith("/database/")) return false;
  if (path === "/database/status") {
    if (req.method !== "GET") {
      send(res, 405, { error: "Este endpoint aceita apenas consulta." });
      return true;
    }
    send(res, 200, await loadStatus());
    return true;
  }
  send(res, 503, { code: "DATABASE_OPERATIONS_DISABLED", error: "Operações de alteração não habilitadas." });
  return true;
}
