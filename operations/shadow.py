"""Fixed-scope Terrânia Go shadow deployment: no shell, no shared Docker networks.

Only a digest-pinned image from the signed Terrânia workflow may be installed.
The public Node multiplayer container, Caddy and all unrelated services stay untouched.
"""
import json
import re
import subprocess
import time
import urllib.request

CONTAINER = 'terrania-go-shadow'
PROJECT = 'terrania-go-shadow'
NODE = 'terrania-origins-multiplayer-1'
PORT = '18788'
SOURCE = 'https://github.com/Softdown-prog/Terrania'
HEALTH_URL = 'http://127.0.0.1:' + PORT + '/health'


def _run(*args, log=None, timeout=180):
    from driver import run
    return run(list(args), log=log, timeout=timeout)


def _inspect(name):
    from driver import inspect
    return inspect(name)


def _maybe_inspect(name):
    try:
        return _inspect(name)
    except subprocess.CalledProcessError:
        return None


def _owned(container):
    labels = (container.get('Config') or {}).get('Labels') or {}
    if labels.get('io.softdown.project') != PROJECT:
        raise ValueError('Reserved shadow name belongs to another project')
    if labels.get('org.opencontainers.image.source') != SOURCE:
        raise ValueError('Shadow container source mismatch')


def _unrelated():
    """Capture IDs only: never mutate or inspect environment secrets."""
    ids = _run('docker', 'ps', '-aq', timeout=20).decode().split()
    if not ids:
        return {}
    return {
        c['Name'].lstrip('/'): c['Id']
        for c in json.loads(_run('docker', 'inspect', *ids, timeout=45))
        if c['Name'].lstrip('/') not in (CONTAINER, CONTAINER + '-rollback')
    }


def verify_shadow(project, args):
    if project.get('adapter') != 'shadow':
        raise ValueError('Unsupported project adapter')
    sha = args.get('sha')
    if not isinstance(sha, str) or not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('Full SHA required')
    c = _inspect(CONTAINER)
    _owned(c)
    if not c['State']['Running'] or c['State'].get('Health', {}).get('Status') != 'healthy':
        raise RuntimeError('Go shadow unhealthy')
    from driver import image_info
    image = image_info(c['Image'])
    labels = image['Config'].get('Labels') or {}
    if labels.get('org.opencontainers.image.revision') != sha or labels.get('org.opencontainers.image.source') != SOURCE:
        raise RuntimeError('Installed shadow revision/source mismatch')
    bindings = c['HostConfig'].get('PortBindings') or {}
    if bindings != {'8788/tcp': [{'HostIp': '127.0.0.1', 'HostPort': PORT}]}:
        raise RuntimeError('Shadow is exposed beyond its loopback port')
    networks = set(c['NetworkSettings']['Networks'])
    if networks != {'bridge'}:
        raise RuntimeError('Shadow unexpectedly joined a shared network')
    request = urllib.request.Request(HEALTH_URL, headers={'Cache-Control': 'no-store'})
    with urllib.request.urlopen(request, timeout=8) as response:
        payload = json.load(response)
    if payload.get('status') != 'ok' or payload.get('engine') != 'go' or payload.get('revision') != sha:
        raise RuntimeError('Shadow health endpoint revision mismatch')
    node = _inspect(NODE)
    if not node['State']['Running'] or node['State'].get('Health', {}).get('Status') != 'healthy':
        raise RuntimeError('Production Node became unhealthy')
    return {'services': [{'service': 'engine-go', 'container': CONTAINER, 'revision': sha,
                          'imageId': c['Image'], 'health': 'healthy'}],
            'loopbackVerified': True, 'nodePreserved': True, 'publicExposed': False}


def _wait_shadow(project, sha, seconds=65):
    deadline = time.monotonic() + seconds
    last = 'waiting'
    while time.monotonic() < deadline:
        try:
            return verify_shadow(project, {'sha': sha})
        except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError) as exc:
            last = type(exc).__name__
            time.sleep(2)
    raise RuntimeError('Shadow health check did not pass: ' + last)


def shadow_activate(project, sha, images, log):
    if project.get('adapter') != 'shadow' or project.get('repository') != 'Softdown-prog/Terrania':
        raise ValueError('Shadow project not authorized')
    if set(images) != {'engine-go'}:
        raise ValueError('Only Go engine image is allowed')
    current = _maybe_inspect(CONTAINER)
    if current is not None:
        _owned(current)
        if not current['State']['Running'] or current['State'].get('Health', {}).get('Status') != 'healthy':
            raise RuntimeError('Existing shadow unhealthy; manual review required')
        installed = (current['Config'].get('Image') or '')
        if installed == images['engine-go']:
            return verify_shadow(project, {'sha': sha})
    if _maybe_inspect(CONTAINER + '-rollback') is not None:
        raise RuntimeError('Previous rollback container exists; manual review required')
    before = _unrelated()
    original_node = _inspect(NODE)
    if not original_node['State']['Running'] or original_node['State'].get('Health', {}).get('Status') != 'healthy':
        raise RuntimeError('Production Node unhealthy; refusing staging deployment')
    old_stopped = False
    old_renamed = False
    created = False
    try:
        if current is not None:
            _run('docker', 'stop', '-t', '8', CONTAINER, log=log, timeout=30)
            old_stopped = True
            _run('docker', 'rename', CONTAINER, CONTAINER + '-rollback', log=log)
            old_renamed = True
        argv = [
            'docker', 'run', '-d', '--name', CONTAINER,
            '--label', 'io.softdown.project=' + PROJECT,
            '--label', 'org.opencontainers.image.source=' + SOURCE,
            '--restart', 'unless-stopped',
            '--network', 'bridge',
            '--publish', '127.0.0.1:' + PORT + ':8788',
            '--memory', '128m', '--cpus', '0.50', '--pids-limit', '64',
            '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=8m',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
            '--env', 'NODE_ENV=production', '--env', 'PORT=8788',
            '--env', 'GIT_SHA=' + sha,
            '--env', 'ALLOWED_ORIGINS=https://rpg.analysepro.com',
            images['engine-go'],
        ]
        _run(*argv, log=log, timeout=60)
        created = True
        result = _wait_shadow(project, sha)
        if _unrelated() != before:
            raise RuntimeError('Unrelated container changed during Go staging')
        if _inspect(NODE)['Id'] != original_node['Id']:
            raise RuntimeError('Production Node was unexpectedly replaced')
        if old_renamed:
            _run('docker', 'rm', '-f', CONTAINER + '-rollback', log=log)
        return dict(result, unrelatedContainersPreserved=True)
    except BaseException:
        if created or _maybe_inspect(CONTAINER) is not None:
            # Only the reserved shadow name may be removed.
            try:
                shadow = _maybe_inspect(CONTAINER)
                if shadow is not None and (current is None or shadow['Id'] != current['Id']):
                    _owned(shadow)
                    _run('docker', 'rm', '-f', CONTAINER, log=log, timeout=30)
            except BaseException:
                pass
        if old_renamed:
            _run('docker', 'rename', CONTAINER + '-rollback', CONTAINER, log=log)
            _run('docker', 'start', CONTAINER, log=log)
        elif old_stopped:
            _run('docker', 'start', CONTAINER, log=log)
        raise
