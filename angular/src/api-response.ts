/**
 * The panel API contract is JSON. Never expose an upstream HTML error page,
 * Cloudflare challenge, or the literal JSON parser exception to the user.
 * HTTP errors with legitimate JSON are still passed to the caller.
 */
export async function readPanelApiObject(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type') ?? '';
  const status = response.status;
  if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
    throw new Error(
      'A API da VPS devolveu uma página ou resposta inesperada (HTTP ' + status +
      '). Verifique a conexão Cloudflare ↔ VPS e a rota /api/session. Nenhuma sessão foi confirmada.'
    );
  }
  let value: unknown;
  try { value = await response.json(); }
  catch {
    throw new Error(
      'A API da VPS devolveu JSON inválido (HTTP ' + status +
      '). Verifique a conexão com a VPS e tente verificar a sessão novamente.'
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A API da VPS devolveu um objeto JSON inesperado (HTTP ' + status + ').');
  }
  return value as Record<string, unknown>;
}
