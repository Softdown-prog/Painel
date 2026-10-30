import http from 'node:http';
import {readFileSync} from 'node:fs';

/** Check the authenticated HTTP contract, not just an open TCP port. */
export function probeApi({hostname = '127.0.0.1', port = 8080, key, timeout = 3000}) {
  return new Promise(resolve => {
    let finished = false, timer;
    const done = result => { if (!finished) { finished = true; clearTimeout(timer); resolve(result); } };
    const req = http.get({hostname, port, path: '/session', timeout,
      headers: {'x-panel-edge-key': key, accept: 'application/json'}}, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('error', () => done({ok: false, reason: 'INCOMPLETE_RESPONSE'}));
      res.on('data', part => {
        text += part;
        if (text.length > 16384) { done({ok: false, reason: 'INVALID_RESPONSE'}); req.destroy(); }
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return done({ok: false, reason: 'HTTP_ERROR', status: res.statusCode});
        try {
          const data = JSON.parse(text);
          const ok = /^application\/json(?:;|$)/i.test(res.headers['content-type'] || '') &&
            typeof data?.authenticated === 'boolean' && typeof data?.setupRequired === 'boolean';
          done({ok, reason: ok ? 'READY' : 'INVALID_RESPONSE'});
        } catch { done({ok: false, reason: 'INVALID_RESPONSE'}); }
      });
    });
    timer = setTimeout(() => { done({ok: false, reason: 'TIMEOUT'}); req.destroy(); }, timeout);
    req.on('timeout', () => { done({ok: false, reason: 'TIMEOUT'}); req.destroy(); });
    req.on('error', () => done({ok: false, reason: 'UNREACHABLE'}));
  });
}

// The same standalone file can run through stdin in an older deployed container.
// No arbitrary destination may receive the edge key from this command.
if (process.argv.includes('--check-panel-connection')) {
  const messages = {
    READY: 'A API respondeu com JSON e confirmou o acesso interno.',
    INVALID_RESPONSE: 'O endereço interno não confirmou a API do painel.',
    HTTP_ERROR: 'A API recusou a consulta interna. Confira a chave de borda e o encaminhamento.',
    INCOMPLETE_RESPONSE: 'A API interrompeu a resposta antes de concluí-la.',
    TIMEOUT: 'A API não respondeu dentro do prazo.',
    UNREACHABLE: 'Não foi possível alcançar a API neste endereço interno.'
  };
  try {
    const key = readFileSync(process.env.PANEL_EDGE_KEY_FILE || '/run/secrets/panel-edge-key', 'utf8').trim();
    if (key.length < 32) throw Error('Invalid configuration');
    const port = Number(process.env.PORT || 8080);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid configuration');
    const result = await probeApi({key, port, hostname: process.argv.includes('--network') ? 'softload-panel-api' : '127.0.0.1'});
    console.log((result.ok ? 'PASS: ' : 'FAIL: ') + messages[result.reason] + (result.status ? ' HTTP ' + result.status + '.' : ''));
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    console.log('FAIL: Não foi possível ler a configuração privada da API. Nenhuma credencial foi exibida.');
    process.exitCode = 1;
  }
}
