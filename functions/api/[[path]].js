export async function onRequest(context) {
  const request = context.request;
  const incoming = new URL(request.url);
  const edgeKey = context.env.PANEL_EDGE_KEY;
  const accessId = context.env.CF_ACCESS_CLIENT_ID;
  const accessSecret = context.env.CF_ACCESS_CLIENT_SECRET;
  if (!edgeKey || !accessId || !accessSecret) return Response.json({ error: 'API não configurada' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  if (!['GET', 'POST'].includes(request.method)) return Response.json({ error: 'Método não permitido' }, { status: 405 });
  if (request.method === 'POST' && request.headers.get('origin') !== incoming.origin) return Response.json({ error: 'Origem inválida' }, { status: 403 });
  const path = incoming.pathname.slice('/api'.length) || '/';
  const target = new URL(`https://panel-api.analysepro.com${path}${incoming.search}`);
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'cookie']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('x-panel-edge-key', edgeKey);
  headers.set('CF-Access-Client-Id', accessId);
  headers.set('CF-Access-Client-Secret', accessSecret);
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) headers.set('cf-connecting-ip', ip);
  try {
    const upstream = await fetch(target, { method: request.method, headers, body: request.method === 'POST' ? request.body : undefined, redirect: 'manual' });
    const responseHeaders = new Headers();
    for (const name of ['content-type', 'set-cookie']) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set('cache-control', 'no-store');
    responseHeaders.set('x-content-type-options', 'nosniff');
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return Response.json({ error: 'API da VPS indisponível' }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
}
