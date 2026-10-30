type PanelEnv = {
  PANEL_EDGE_KEY?: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
};
type PanelContext = { request: Request; env: PanelEnv };
const API_ORIGIN = 'https://panel-api.analysepro.com';
function failure(status: number, code: string, error: string, upstreamStatus?: number) {
  return Response.json({ error, code, ...(upstreamStatus === undefined ? {} : { upstreamStatus }) }, {
    status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  });
}
/** Fixed-origin proxy. Credentials never follow redirects or reach the browser. */
export async function proxyPanelRequest(context: PanelContext, fetcher: typeof fetch = fetch,
  timeoutMs = context.request.method === 'GET' ? 45_000 : 110_000): Promise<Response> {
  const { request } = context, incoming = new URL(request.url);
  const edgeKey = context.env.PANEL_EDGE_KEY?.trim(), accessId = context.env.CF_ACCESS_CLIENT_ID?.trim(), accessSecret = context.env.CF_ACCESS_CLIENT_SECRET?.trim();
  if (!edgeKey || !accessId || !accessSecret)
    return failure(503, 'EDGE_NOT_CONFIGURED', 'A conexão com a VPS ainda não foi configurada no painel. Confira as credenciais em Configuração avançada.');
  if (!['GET', 'POST', 'DELETE'].includes(request.method)) return failure(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
  if (request.method !== 'GET' && request.headers.get('origin') !== incoming.origin)
    return failure(403, 'INVALID_ORIGIN', 'Origem inválida. Abra o painel pelo seu endereço original.');
  if (incoming.pathname !== '/api' && !incoming.pathname.startsWith('/api/')) return failure(400, 'INVALID_PATH', 'Endereço da API inválido.');
  const path = incoming.pathname.slice('/api'.length) || '/';
  if (path.startsWith('//') || /%2f|%5c/i.test(path)) return failure(400, 'INVALID_PATH', 'Endereço da API inválido.');
  const target = new URL(API_ORIGIN); target.pathname = path; target.search = incoming.search;
  const headers = new Headers({ accept: 'application/json' });
  for (const name of ['content-type', 'cookie']) {
    const value = request.headers.get(name); if (value) headers.set(name, value);
  }
  headers.set('x-panel-edge-key', edgeKey);
  headers.set('CF-Access-Client-Id', accessId);
  headers.set('CF-Access-Client-Secret', accessSecret);
  const ip = request.headers.get('cf-connecting-ip'); if (ip) headers.set('cf-connecting-ip', ip);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetcher(target, { method: request.method, headers,
      body: request.method === 'POST' ? request.body : undefined, redirect: 'manual', signal: controller.signal });
    if (upstream.status >= 300 && upstream.status < 400)
      return failure(502, 'UPSTREAM_ACCESS', 'A autorização da conexão privada com a VPS precisa ser conferida em Configuração avançada.', upstream.status);
    const responseHeaders = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    if (upstream.status === 204) return new Response(null, { status: 204, headers: responseHeaders });
    const type = upstream.headers.get('content-type') || '';
    let data: unknown;
    if (/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(type)) {
      try { data = await upstream.json(); } catch { /* Normalize provider content below. */ }
    }
    if (controller.signal.aborted) throw new Error('Upstream timeout');
    const object = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
    if (object && !object.cloudflare_error && !('status_code' in object && !('error' in object)) &&
      (upstream.ok || typeof object.error === 'string')) {
      const cookie = upstream.headers.get('set-cookie');
      if (cookie && /^panel_session=/.test(cookie)) responseHeaders.set('set-cookie', cookie);
      return Response.json(object, { status: upstream.status, headers: responseHeaders });
    }
    if (upstream.status === 401 || upstream.status === 403 || upstream.headers.get('cf-mitigated') === 'challenge')
      return failure(502, 'UPSTREAM_ACCESS', 'A autorização da conexão privada com a VPS foi recusada. Confira as credenciais do painel em Configuração avançada.', upstream.status);
    if ([408, 504, 522, 524].includes(upstream.status))
      return failure(504, 'UPSTREAM_TIMEOUT', 'A API da VPS demorou para responder. Confira a API e o túnel do servidor.', upstream.status);
    if (upstream.status >= 500)
      return failure(502, 'UPSTREAM_UNAVAILABLE', 'A conexão com a API da VPS está indisponível. Confira a API e o túnel do servidor.', upstream.status);
    return failure(502, 'UPSTREAM_INVALID_RESPONSE', 'O endereço da VPS não devolveu a resposta esperada da API. Confira o encaminhamento do painel.', upstream.status);
  } catch {
    return controller.signal.aborted
      ? failure(504, 'UPSTREAM_TIMEOUT', 'A API da VPS demorou para responder. Confira a API e o túnel do servidor.')
      : failure(502, 'UPSTREAM_UNAVAILABLE', 'Não foi possível alcançar a API da VPS. Confira a API e o túnel do servidor.');
  } finally { clearTimeout(timer); }
}
export async function onRequest(context: PanelContext) { return proxyPanelRequest(context); }
