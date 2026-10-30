import type { IncomingMessage, ServerResponse } from "node:http";

type Send = (res: ServerResponse, status: number, data: unknown) => void;
type Dependencies = { send: Send };

/**
 * Contrato de preparação. Nenhuma instalação, conexão TCP, Docker,
 * leitura de segredos, driver ou operação SQL existe neste módulo.
 * Quando o serviço for implantado, substituir por um adaptador restrito
 * atrás da autenticação administrativa existente.
 */
export async function handleDatabaseRoute(
  req: IncomingMessage, res: ServerResponse, { send }: Dependencies,
): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://panel.local").pathname;
  if (path !== "/database" && !path.startsWith("/database/")) return false;
  if (path === "/database/status") {
    if (req.method !== "GET") {
      send(res, 405, { error: "Este endpoint aceita apenas consulta." });
      return true;
    }
    send(res, 200, {
      engine: "postgresql",
      integration: "not_configured",
      enabled: false,
      instance: null,
      databases: null,
      metrics: null,
      checkedAt: new Date().toISOString(),
      message: "Integração com PostgreSQL ainda não configurada no Painel. Nenhum banco foi consultado.",
    });
    return true;
  }
  // Deny by default; even fake configuration flags must not enable writes.
  send(res, 503, {
    error: "Administração PostgreSQL indisponível. O conector ainda não foi instalado nem autorizado.",
    code: "DATABASE_NOT_CONFIGURED",
  });
  return true;
}
