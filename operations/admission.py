"""Server-owned, fail-closed deployment admission. Never executes a submitted test command.

Candidates have no network, published port, production mount/secret or Docker socket.
Tests are fixed here; the root-owned project policy chooses a profile per service.
The existing activation/rollback adapters run only after EVERY candidate passes.
"""
import json
from pathlib import Path
import re
import secrets
import subprocess
import time

VERSION = 1
PROFILES = {'panel-api', 'panel-executor', 'panel-web', 'http-json'}
REMEDIATION = {
    'contract': 'Configure na VPS um contrato v1 para todos os serviços deste projeto.',
    'identity': 'Confira digest, origem e SHA das imagens publicadas pelo workflow.',
    'isolation': 'A candidata não atende ao isolamento obrigatório; produção preservada.',
    'runtime': 'Confira inicialização, autenticação e contrato HTTP da imagem candidata.',
    'cleanup': 'A candidata de teste não pôde ser removida; ativação bloqueada.',
}


class AdmissionRejected(RuntimeError):
    def __init__(self, receipt):
        super().__init__('Deployment rejected before activation')
        self.receipt = receipt


def rejected(check, checks, service=None):
    entry = {'check': check, 'status': 'failed', 'action': REMEDIATION[check]}
    if service:
        entry['service'] = service
    raise AdmissionRejected({'version': VERSION, 'status': 'rejected',
                             'productionChanged': False, 'checks': checks + [entry]})


def contract(project):
    value = project.get('admission')
    if (not isinstance(value, dict) or set(value) != {'version', 'services'}
            or value['version'] != VERSION or not isinstance(value['services'], dict)
            or not value['services'] or len(value['services']) > 8
            or set(value['services']) != set(project['images'])
            or set(value['services']) != set(project['containers'])):
        rejected('contract', [])
    for service, rule in value['services'].items():
        if (not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', service) or not isinstance(rule, dict)
                or rule.get('profile') not in PROFILES):
            rejected('contract', [])
        if rule['profile'] == 'http-json':
            if (set(rule) != {'profile', 'port', 'path', 'revisionField'}
                    or type(rule['port']) is not int or not 1024 <= rule['port'] <= 65535
                    or not re.fullmatch(r'/[a-zA-Z0-9/_-]{0,100}', rule['path'])
                    or not re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_]{0,40}', rule['revisionField'])):
                rejected('contract', [])
        elif set(rule) != {'profile'}:
            rejected('contract', [])
    return value


API_BOOT = """
import fs from 'node:fs';
fs.writeFileSync('/tmp/admission-edge',process.env.ADMISSION_KEY,{mode:0o600});
process.env.PANEL_EDGE_KEY_FILE='/tmp/admission-edge';
await import('./api.mjs');
"""
EXECUTOR_BOOT = """
import http from 'node:http';
const fake=http.createServer((q,s)=>{
  if(q.method!=='GET'){s.writeHead(405);return s.end();}
  if(q.url==='/_ping')return s.end('OK');
  if(q.url.startsWith('/v1.45/containers/json')){s.setHeader('content-type','application/json');return s.end('[]');}
  s.writeHead(404);s.end('{}');
});
await new Promise(r=>fake.listen('/tmp/admission-daemon.sock',r));
await import('./executor.mjs');
"""
WEB_BOOT = """
import fs from 'node:fs';
fs.writeFileSync('/tmp/admission-edge',process.env.ADMISSION_KEY,{mode:0o600});
process.env.PANEL_EDGE_KEY_FILE='/tmp/admission-edge';
process.argv[1]='/app/server.mjs';
await import('./server.mjs');
"""
EXECUTOR_PROBE = """
import http from 'node:http';
import assert from 'node:assert/strict';
function call(path,method='GET',body){return new Promise((ok,no)=>{
 const r=http.request({socketPath:'/tmp/admission-executor.sock',path,method,timeout:2000,
 headers:{'content-type':'application/json'}},s=>{let b='';s.on('data',x=>{b+=x;if(b.length>65536)r.destroy(Error());});
 s.on('end',()=>ok({status:s.statusCode,body:b}));});
 r.on('error',no);r.on('timeout',()=>r.destroy(Error()));r.end(body?JSON.stringify(body):undefined);
});}
assert.equal((await call('/_executor/health')).status,200);
const list=await call('/v1.45/containers/json?all=1&view=inventory');
assert.equal(list.status,200);assert.deepEqual(JSON.parse(list.body),[]);
assert.equal((await call('/v1.45/containers/create','POST',{Image:'evil',HostConfig:{Privileged:true}})).status,403);
assert.equal((await call('/v1.45/containers/foreign/stop','POST')).status,403);
"""


def docker(argv, *, timeout=20, input=None):
    # Candidate output is never published. Docker logs are capped at creation.
    return subprocess.check_output(['docker', *argv], input=input, stderr=subprocess.DEVNULL, timeout=timeout)


def candidate_command(name, image, rule, sha, key):
    command = ['create', '--name', name, '--label', 'vps.admission.candidate=true',
               '--network', 'none', '--read-only', '--user', '65534:65534',
               '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
               '--memory', '192m', '--memory-swap', '192m', '--cpus', '0.5', '--pids-limit', '64',
               '--restart', 'no', '--no-healthcheck', '--log-driver', 'local',
               '--log-opt', 'max-size=1m', '--log-opt', 'max-file=1',
               '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777',
               '--tmpfs', '/data:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=65534,gid=65534']
    env = {'GIT_SHA': sha, 'NODE_ENV': 'production'}
    profile = rule['profile']
    if profile == 'panel-api':
        env.update(PORT='8080', PANEL_DATA_DIR='/data', PANEL_SOFTLOAD_LEGACY='0',
                   PANEL_RELEASE_SHA=sha, PANEL_POSTGRES_ENABLED='0', ADMISSION_KEY=key)
    elif profile == 'panel-executor':
        env.update(NODE_ENV='test', PANEL_EXECUTOR_SOCKET='/tmp/admission-executor.sock',
                   PANEL_TEST_DOCKER_SOCKET='/tmp/admission-daemon.sock', PANEL_SOFTLOAD_LEGACY='0')
    elif profile == 'panel-web':
        env.update(PORT='8081', ADMISSION_KEY=key, PANEL_WEB_REVISION=sha,
                   PANEL_PUBLIC_ORIGIN='https://panel.example.test')
    else:
        env.update(PORT=str(rule['port']), ALLOWED_ORIGINS='http://127.0.0.1:5173')
    for k, v in env.items():
        command += ['--env', k + '=' + v]
    if profile in ('panel-api', 'panel-executor', 'panel-web'):
        command += ['--entrypoint', 'node', image, '--input-type=module', '-e',
                    {'panel-api': API_BOOT, 'panel-executor': EXECUTOR_BOOT, 'panel-web': WEB_BOOT}[profile]]
    else:
        command += [image]
    return command


def isolation(info):
    cfg = info['HostConfig']
    return (cfg['NetworkMode'] == 'none' and cfg['ReadonlyRootfs']
            and not cfg.get('Privileged') and not cfg.get('PortBindings')
            and not cfg.get('Binds') and all(m.get('Type') == 'tmpfs' and m.get('Destination') in ('/tmp', '/data') for m in info.get('Mounts', []))
            and not cfg.get('VolumesFrom') and not cfg.get('Devices')
            and info['Config']['User'] == '65534:65534' and cfg.get('CapDrop') == ['ALL']
            and not cfg.get('CapAdd') and 'no-new-privileges:true' in cfg['SecurityOpt']
            and 0 < cfg['Memory'] <= 192 * 1024 ** 2 and cfg['MemorySwap'] == cfg['Memory']
            and cfg['NanoCpus'] == 500000000 and 0 < cfg['PidsLimit'] <= 64)


def probe(name, rule, sha, key, info):
    if rule['profile'] == 'panel-executor':
        docker(['exec', '-i', name, 'node', '--input-type=module', '-'],
               input=EXECUTOR_PROBE.encode(), timeout=10)
    else:
        # Enter ONLY the candidate's network namespace. No bridge/egress or host port.
        # HTTP parser/test lives on the host, not in the potentially broken image.
        command = ['nsenter', '--target', str(info['State']['Pid']), '--net',
                   '/usr/bin/python3', '-I', str(Path(__file__).with_name('admission_probe.py'))]
        payload = json.dumps({'rule': rule, 'sha': sha, 'key': key}).encode()
        subprocess.run(command, input=payload, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=12, check=True)


def admit(project, sha, images):
    spec = contract(project)
    checks = [{'check': 'contract', 'status': 'passed'}]
    started = time.monotonic()
    if not re.fullmatch(r'[0-9a-f]{40}', sha) or set(images) != set(spec['services']):
        rejected('identity', checks)
    for service, rule in spec['services'].items():
        ref = images[service]
        if not re.fullmatch(re.escape(project['images'][service]) + r'@sha256:[0-9a-f]{64}', ref):
            rejected('identity', checks, service)
        im = json.loads(docker(['image', 'inspect', ref]))[0]
        labels = im['Config'].get('Labels') or {}
        expected_cmd = {'panel-api': ['node', 'api.mjs'], 'panel-executor': ['node', 'executor.mjs'],
                        'panel-web': ['node', 'server.mjs']}.get(rule['profile'])
        if (labels.get('org.opencontainers.image.revision') != sha
                or labels.get('org.opencontainers.image.source') != 'https://github.com/' + project['repository']
                or im['Config'].get('Volumes')
                or (expected_cmd and im['Config'].get('Cmd') != expected_cmd)):
            rejected('identity', checks, service)
        checks.append({'check': 'identity', 'service': service, 'status': 'passed'})
        name = 'vps-admission-' + secrets.token_hex(12)
        key = secrets.token_hex(32)  # Disposable fixture; never a production secret.
        created = False
        try:
            docker(candidate_command(name, ref, rule, sha, key))
            created = True
            info = json.loads(docker(['inspect', name]))[0]
            if not isolation(info):
                rejected('isolation', checks, service)
            docker(['start', name])
            deadline = time.monotonic() + 35
            passed = False
            while time.monotonic() < deadline:
                info = json.loads(docker(['inspect', name]))[0]
                if not info['State']['Running']:
                    break
                try:
                    probe(name, rule, sha, key, info)
                    passed = True
                    break
                except (subprocess.SubprocessError, OSError):
                    time.sleep(0.5)
            if not passed:
                rejected('runtime', checks, service)
            checks.append({'check': 'runtime', 'service': service, 'status': 'passed'})
        except AdmissionRejected:
            raise
        except (subprocess.SubprocessError, OSError, ValueError, KeyError):
            rejected('runtime', checks, service)
        finally:
            if created:
                try:
                    docker(['rm', '-f', name])  # Only this random disposable candidate; no volumes.
                except (subprocess.SubprocessError, OSError):
                    rejected('cleanup', checks, service)
    return {'version': VERSION, 'status': 'passed', 'checks': checks,
            'durationSeconds': round(time.monotonic() - started, 3)}
