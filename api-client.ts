/** Same-origin transport shared by all screens. Never repeats administrative operations. */
(() => {
  class PanelApiError extends Error {
    constructor(message: string, readonly status: number, readonly code: string) { super(message); }
  }
  function unavailable(status: number): string {
    if (status === 401) return 'Sua sessão terminou. Entre novamente no painel.';
    if (status === 403) return 'A conexão com a VPS foi bloqueada. Confira a autorização da API em Configuração avançada.';
    if ([408, 504, 522, 524].includes(status)) return 'A API da VPS demorou para responder. Confira a conexão antes de tentar novamente.';
    if (status === 404) return 'O endereço da API não foi encontrado. Confira a conexão do painel em Configuração avançada.';
    if (status >= 500) return 'O painel não conseguiu se comunicar com a API da VPS (HTTP ' + status + '). Confira a API e o túnel do servidor.';
    return 'A API não devolveu uma resposta válida (HTTP ' + status + '). Teste a conexão do painel.';
  }
  async function request<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
    const url = new URL('/api' + path, location.origin);
    if (!path.startsWith('/') || path.startsWith('//') || /[\\#]/.test(path) || !url.pathname.startsWith('/api/'))
      throw new PanelApiError('Endereço de consulta inválido.', 0, 'INVALID_PATH');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const mutating = (options.method || 'GET').toUpperCase() !== 'GET';
    // Publishing can perform several server checks; keep its budget above the proxy's.
    const timer = setTimeout(abort, mutating ? 115_000 : 50_000);
    try {
      const headers = new Headers(options.headers);
      headers.set('accept', 'application/json');
      const response = await fetch('/api' + path, { ...options, headers, signal: controller.signal,
        cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
      if (response.status === 204 && response.ok) return undefined as T;
      let data: unknown;
      try { data = await response.json(); }
      catch { throw new PanelApiError(unavailable(response.status), response.status, 'INVALID_RESPONSE'); }
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new PanelApiError(unavailable(response.status), response.status, 'INVALID_RESPONSE');
      const payload = data as Record<string, unknown>;
      if (!response.ok) {
        const message = typeof payload.error === 'string' && payload.error.length <= 1000 && !/[<>]/.test(payload.error)
          ? payload.error : unavailable(response.status);
        throw new PanelApiError(message, response.status, typeof payload.code === 'string' ? payload.code : 'HTTP_ERROR');
      }
      return data as T;
    } catch (error) {
      let failure: PanelApiError;
      if (controller.signal.aborted) failure = new PanelApiError('A consulta foi interrompida ou demorou para responder. Teste a conexão da VPS.', 0, 'REQUEST_ABORTED');
      else if (error instanceof PanelApiError) failure = error;
      else failure = new PanelApiError('Não foi possível conectar à API da VPS. Confira sua internet e teste a conexão do painel.', 0, 'NETWORK_ERROR');
      if (mutating && (failure.status === 0 || failure.status >= 500 || failure.code === 'INVALID_RESPONSE'))
        failure.message += ' O resultado da operação não foi confirmado. Confira o estado antes de repetir.';
      throw failure;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }
  Object.assign(window, { panelApi: { request } satisfies PanelApiClient });
})();
