#!/usr/bin/python3
"""Private, forced-command SSH broker. No shell, environment forwarding or Docker access for its user."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.request
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives import hashes

# Python isolated mode deliberately excludes cwd; this directory is root-owned.
sys.path.insert(0, str(Path(__file__).resolve().parent))

ISSUER = 'https://token.actions.githubusercontent.com'
AUDIENCE = 'vps-operations:164.163.9.7'
ROOT = Path('/var/lib/vps-operations')

def decode(value):
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))

def get_json(url, token=None):
    headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'vps-operations'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20) as response:
        return json.load(response)

def validate_claims(claims, policy, project, operation, now=None):
    now = time.time() if now is None else now
    if claims.get('iss') != ISSUER or claims.get('aud') != AUDIENCE:
        raise ValueError('OIDC issuer/audience rejected')
    if not (claims.get('nbf', now + 1) <= now < claims.get('exp', 0)) or not 0 <= now - claims.get('iat', 0) < 600:
        raise ValueError('OIDC expired or issued in future')
    if str(claims.get('actor_id')) not in policy['actor_ids']:
        raise ValueError('Actor not authorized')
    repo = policy['repositories'].get(str(claims.get('repository_id')))
    if not repo or claims.get('repository') != repo['name']:
        raise ValueError('Repository rejected')
    if claims.get('ref') != 'refs/heads/main' or claims.get('event_name') not in ('push', 'workflow_dispatch', 'issues'):
        raise ValueError('Only trusted main events allowed')
    if claims.get('workflow_ref') not in [repo['name'] + '/.github/workflows/' + name + '@refs/heads/main' for name in repo['workflows']]:
        raise ValueError('Workflow rejected')
    if project not in repo['projects'] or operation not in repo['operations']:
        raise ValueError('Project/operation not authorized')
    if operation == 'maintain':
        gate = policy.get('maintenance') or {}
        if (project != 'infrastructure' or claims.get('repository') != 'Softdown-prog/Painel'
            or str(claims.get('actor_id')) not in gate.get('actor_ids',[])
            or claims.get('event_name') != 'workflow_dispatch'
            or claims.get('environment') != 'vps-maintenance'
            or claims.get('workflow_ref') != 'Softdown-prog/Painel/.github/workflows/vps-maintenance.yml@refs/heads/main'):
            raise ValueError('Maintenance requires the approved administrative workflow')
    if not re.fullmatch(r'[0-9a-f]{40}', claims.get('sha', '')):
        raise ValueError('Invalid commit')
    return repo

def verify_oidc(token, policy, project, operation):
    if not isinstance(token, str) or len(token) > 20000:
        raise ValueError('Invalid token')
    header, body, signature = token.split('.')
    h, claims = json.loads(decode(header)), json.loads(decode(body))
    if h.get('alg') != 'RS256':
        raise ValueError('Unsupported signature')
    # Fixed HTTPS endpoint: token-controlled jku/x5u are never used.
    keys = get_json(ISSUER + '/.well-known/jwks')['keys']
    key = next(k for k in keys if k['kid'] == h.get('kid') and k['kty'] == 'RSA')
    public = rsa.RSAPublicNumbers(int.from_bytes(decode(key['e']), 'big'), int.from_bytes(decode(key['n']), 'big')).public_key()
    public.verify(decode(signature), (header + '.' + body).encode(), padding.PKCS1v15(), hashes.SHA256())
    repo = validate_claims(claims, policy, project, operation)
    return claims, repo

def inventory():
    ids = subprocess.check_output(['docker', 'ps', '-aq'], text=True).split()
    result = []
    if not ids:
        return result
    for item in json.loads(subprocess.check_output(['docker', 'inspect', *ids])):
        image = json.loads(subprocess.check_output(['docker', 'image', 'inspect', item['Image']]))[0]
        labels, il = item['Config'].get('Labels') or {}, image['Config'].get('Labels') or {}
        result.append({'name': item['Name'].lstrip('/'), 'id': item['Id'], 'image': item['Config']['Image'],
                       'imageId': item['Image'], 'digests': image.get('RepoDigests') or [],
                       'revision': il.get('org.opencontainers.image.revision'), 'source': il.get('org.opencontainers.image.source'),
                       'composeProject': labels.get('com.docker.compose.project'), 'service': labels.get('com.docker.compose.service'),
                       'status': item['State']['Status'], 'health': item['State'].get('Health', {}).get('Status'),
                       'networks': list(item['NetworkSettings']['Networks']), 'ports': item['HostConfig']['PortBindings'],
                       'memory': item['HostConfig']['Memory'], 'nanoCpus': item['HostConfig']['NanoCpus']})
    return result

def reserve(db, key, digest):
    previous = db.execute('select digest,result from jobs where id=?', (key,)).fetchone()
    if previous:
        if previous[0] != digest:
            raise ValueError('Request ID reused with different content')
        if previous[1] is None:
            raise ValueError('Request already running or interrupted; inspect audit before retry')
        return json.loads(previous[1])
    db.execute('insert into jobs values (?,?,NULL)', (key, digest))
    db.commit()
    return None

def main():
    import fcntl
    os.umask(0o077)
    def interrupted(signum, frame):
        raise InterruptedError('Executor deadline/cancellation')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    signal.alarm(60)
    policy = json.loads(Path('/etc/vps-operations/policy.json').read_text())
    # Read bounded input; no command text, file paths or env from SSH is interpreted.
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError('Request too large')
    request = json.loads(raw)
    operation, project = request.get('operation'), request.get('project')
    claims, repo = verify_oidc(request.get('oidc'), policy, project, operation)
    signal.alarm(1500)
    request_id = request.get('id', '')
    if not re.fullmatch(r'[a-zA-Z0-9_.:-]{8,120}', request_id):
        raise ValueError('Invalid request ID')
    if str(claims['run_id']) not in request_id:
        raise ValueError('Request not bound to workflow run')
    args = request.get('args') or {}
    # A deploy can only install the commit authenticated by GitHub, never an arbitrary caller revision.
    if operation == 'deploy' and args.get('sha') != claims['sha']:
        raise ValueError('Deploy commit differs from authenticated workflow')
    if operation == 'deploy' and policy['projects'].get(project, {}).get('repository') != claims['repository']:
        raise ValueError('A repository may only deploy its own project')
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = open(ROOT / (project + '.lock'), 'a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    db = sqlite3.connect(ROOT / 'audit.sqlite')
    db.execute('create table if not exists jobs (id text primary key,digest text not null,result text)')
    digest = hashlib.sha256(json.dumps({'operation': operation, 'project': project, 'args': args}, sort_keys=True).encode()).hexdigest()
    key = str(claims['repository_id']) + ':' + request_id
    previous = reserve(db, key, digest)
    if previous is not None:
        print(json.dumps(dict(previous, duplicate=True))); return
    started = time.monotonic()
    result = {'id': request_id, 'project': project, 'operation': operation, 'runId': claims['run_id'],
              'actorId': claims['actor_id'], 'commit': claims['sha']}
    try:
        if operation == 'inventory':
            result['containers'] = inventory()
        elif operation == 'deploy':
            from driver import deploy
            # Registry token is ephemeral, never stored in audit/history or returned.
            result.update(deploy(policy['projects'][project], args, request.get('registry_token'), ROOT))
        elif operation == 'verify':
            from driver import verify_project
            result.update(verify_project(policy['projects'][project], args))
        elif operation == 'maintain':
            from maintenance import run_maintenance
            result.update(run_maintenance(policy, args, ROOT))
        else:
            raise ValueError('Operation unavailable')
        result['exitCode'] = 0
    except Exception as error:
        # Administrative logs stay private on the host; no process output or credentials go to GitHub.
        result['exitCode'] = 1
        result['error'] = type(error).__name__ + ': operation failed; inspect private host log'
    result['durationSeconds'] = round(time.monotonic() - started, 3)
    encoded = json.dumps(result)
    db.execute('update jobs set result=? where id=?', (encoded, key)); db.commit()
    print(encoded)
    sys.exit(result['exitCode'])

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'exitCode': 1, 'error': type(error).__name__ + ': request rejected'}))
        sys.exit(1)
