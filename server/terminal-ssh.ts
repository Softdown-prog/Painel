import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

type SSHResult = { exitCode: number; output: string; truncated: boolean; timedOut: boolean };
type Deps = {
  send: (res: ServerResponse, status: number, data: unknown) => void;
  body: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  execute?: (command: string) => Promise<SSHResult>;
  enabled?: boolean;
};
// Send multi-line scripts via SSH stdin; bound the per-request memory use.
const MAX_COMMAND_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT = 24 * 1024;
let executing = false;
function config() {
  const host = process.env.PANEL_TERMINAL_SSH_HOST || '';
  const user = process.env.PANEL_TERMINAL_SSH_USER || '';
  const port = Number(process.env.PANEL_TERMINAL_SSH_PORT || '22');
  const key = process.env.PANEL_TERMINAL_SSH_KEY_FILE || '/run/secrets/panel-ssh-key';
  const hosts = process.env.PANEL_TERMINAL_SSH_KNOWN_HOSTS || '/run/secrets/panel-ssh-known-hosts';
  const valid = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,126}$/.test(host) &&
    /^[a-z_][a-z0-9_-]{0,31}$/.test(user) &&
    Number.isSafeInteger(port) && port > 0 && port <= 65535 &&
    key.startsWith('/run/secrets/') && hosts.startsWith('/run/secrets/') &&
    existsSync(key) && existsSync(hosts);
  return { host, user, port, key, hosts, valid };
}
// This is deliberately exported only for fixed, server-generated operations.
// Routes using it must never concatenate browser-provided shell fragments.
export function executeSshCommand(command: string): Promise<SSHResult> {
  const settings = config();
  if (!settings.valid) return Promise.reject(new Error('SSH da VPS ainda não foi configurado.'));
  return new Promise((resolve, reject) => {
    const args = [
      '-T', '-p', String(settings.port),
      '-i', settings.key,
      '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'UserKnownHostsFile=' + settings.hosts,
      '-o', 'ConnectTimeout=5',
      '-o', 'ConnectionAttempts=1',
      '-o', 'ClearAllForwardings=yes',
      '-o', 'ControlMaster=no',
      '-o', 'PermitLocalCommand=no',
      '-o', 'ProxyCommand=none',
      '-o', 'PasswordAuthentication=no',
      '--', settings.user + '@' + settings.host, 'sh', '-s'
    ];
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
    let output = ''; let size = 0; let truncated = false; let timedOut = false;
    let settled = false;
    const clock = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 18_000);
    const finish = (error?: Error, code?: number | null) => {
      if (settled) return; settled = true; clearTimeout(clock);
      if (error) reject(error);
      else resolve({ output: output.slice(0, MAX_OUTPUT), exitCode: Number.isInteger(code) ? code as number : -1, timedOut, truncated });
    };
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (part: Buffer) => {
        size += part.length;
        if (size > MAX_OUTPUT) {
          truncated = true;
          const left = MAX_OUTPUT - output.length;
          if (left > 0) output += part.toString('utf8').slice(0, left);
          child.kill('SIGKILL');
        } else output += part.toString('utf8');
      });
    }
    child.on('error', (err: Error) => finish(err));
    child.on('close', code => finish(undefined, code));
    child.stdin.on('error', () => { /* SSH connection may close during startup */ });
    child.stdin.end(command + '\n');
  });
}
export async function handleSshTerminalRoute(req: IncomingMessage, res: ServerResponse, deps: Deps): Promise<boolean> {
  const path = new URL(req.url || '/', 'http://panel.local').pathname;
  if (!['/terminal/ssh/status', '/terminal/ssh/exec'].includes(path))
    return false;
  const enabled = deps.enabled ?? process.env.PANEL_TERMINAL_SSH_ENABLED === '1';
  if (path === '/terminal/ssh/status' && req.method === 'GET') {
    deps.send(res, 200, {
      enabled, configured: enabled && (deps.execute ? true : config().valid)
    });
    return true;
  }
  if (!enabled) { deps.send(res, 403, { error: 'Terminal Linux não habilitado na VPS.' }); return true; }
  if (!deps.execute && !config().valid) {
    deps.send(res, 503, { error: 'Falta configurar o acesso SSH da VPS. Confira o manual do Terminal.' }); return true;
  }
  if (path === '/terminal/ssh/exec' && req.method === 'POST') {
    const data = await deps.body(req);
    if (typeof data.command !== 'string' || !data.command.trim() || Buffer.byteLength(data.command, 'utf8') > MAX_COMMAND_BYTES ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(data.command) ||
      Object.keys(data).join(',') !== 'command') {
      deps.send(res, 400, { error: 'Comando inválido. Scripts até 4 MB; caracteres de controle inválidos não são aceitos.' }); return true;
    }
    if (executing) { deps.send(res, 429, { error: 'Já existe um comando Linux em execução. Tente novamente após concluí-lo.' }); return true; }
    executing = true;
    const fingerprint = createHash('sha256').update(data.command).digest('hex').slice(0, 16);
    const started = Date.now();
    try {
      const result = await (deps.execute || executeSshCommand)(data.command);
      console.log(JSON.stringify({ event: 'panel_ssh_command', fingerprint, exitCode: result.exitCode,
        durationMs: Date.now() - started, at: new Date().toISOString() }));
      deps.send(res, 200, result);
    } catch (error) {
      console.error('SSH terminal execution failed:', error instanceof Error ? error.message : 'unknown error');
      deps.send(res, 502, { error: 'Falha na comunicação SSH da VPS. Confira a instalação e tente novamente.' });
    } finally { executing = false; }
    return true;
  }
  deps.send(res, 405, { error: 'Método não permitido.' });
  return true;
}
