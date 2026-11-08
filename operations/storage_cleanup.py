#!/usr/bin/env python3
"""Host-only, fixed Docker garbage collection. No containers/volumes/files pruned."""
import argparse
from contextlib import ExitStack
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

ROOT = Path('/var/lib/vps-storage-cleanup')
DATA = Path('/var/lib/docker/volumes/softload_panel_data/_data')
BROKER = Path('/var/lib/vps-operations')
INTERVAL = 6 * 3600
REPORT = 'host-storage-cleanup-report.json'
REQUEST = 'host-storage-cleanup-request.json'
IMAGE_ID = re.compile(r'^sha256:[a-f0-9]{64}$')
REFERENCE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,350}$')


def read_json(path, default):
    try:
        if path.is_symlink() or path.stat().st_size > 1024 * 1024:
            raise ValueError('Invalid maintenance file')
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def atomic(path, value, mode=0o600):
    if path.is_symlink():
        raise ValueError('Refusing a symlink')
    temporary = path.with_name('.' + path.name + '.' + str(os.getpid()))
    with temporary.open('x') as output:
        json.dump(value, output); output.flush(); os.fsync(output.fileno())
    temporary.chmod(mode)
    os.replace(temporary, path)


def docker(*args, check=True):
    result = subprocess.run(['/usr/bin/docker', *args], capture_output=True, text=True,
                            timeout=120, env={'PATH': '/usr/bin:/bin',
                            'DOCKER_HOST': 'unix:///var/run/docker.sock'})
    if check and result.returncode:
        raise RuntimeError('Docker maintenance query failed')
    return result


def image_refs(image):
    return sorted({r for r in (image.get('RepoTags') or []) + (image.get('RepoDigests') or [])
                   if isinstance(r, str) and r != '<none>:<none>' and REFERENCE.fullmatch(r)})


def repository(ref):
    ref = ref.split('@', 1)[0]
    prefix, _, leaf = ref.rpartition('/')
    leaf = leaf.split(':', 1)[0]
    return (prefix + '/' if prefix else '') + leaf


def inventory():
    container_ids = docker('ps', '-aq', '--no-trunc').stdout.split()
    ids = sorted(set(docker('image', 'ls', '-q', '--no-trunc').stdout.split()))
    if len(ids) > 1000 or len(container_ids) > 500:
        raise ValueError('Maintenance inventory limit exceeded')
    if not all(IMAGE_ID.fullmatch(i) for i in ids):
        raise ValueError('Invalid image identity')
    images = json.loads(docker('image', 'inspect', *ids).stdout) if ids else []
    containers = json.loads(docker('inspect', *container_ids).stdout) if container_ids else []
    if not isinstance(images, list) or not isinstance(containers, list):
        raise ValueError('Invalid Docker inventory')
    return images, containers


def plan(images, containers, first_unused, now, minimum_age=INTERVAL, protected_refs=()):
    """Age means continuously observed unused, never the image's build timestamp."""
    used = {c['Image'] for c in containers}  # Includes stopped and rollback containers.
    repos = {repository(r) for i in images if i['Id'] in used for r in image_refs(i)}
    protected = set(protected_refs)
    state, targets = {}, []
    for image in images:
        identity = image['Id']
        if not IMAGE_ID.fullmatch(identity):
            raise ValueError('Invalid image identity')
        refs = image_refs(image)
        if identity in used or protected.intersection(refs):
            continue
        stamp = first_unused.get(identity, now)
        if not isinstance(stamp, (int, float)) or isinstance(stamp, bool) or stamp > now:
            stamp = now
        state[identity] = stamp
        # Unknown repositories are reported, never silently garbage-collected.
        if refs and all(repository(r) in repos for r in refs) and now - stamp >= minimum_age:
            targets.append({'id': identity, 'refs': refs})
    return state, targets


def busy_process():
    for directory in Path('/proc').iterdir():
        if not directory.name.isdigit():
            continue
        try:
            args = (directory / 'cmdline').read_bytes().split(b'\0')
            name = (directory / 'comm').read_text().strip()
            if name == 'Runner.Worker':
                return True
            if args and os.path.basename(args[0].decode()) == 'docker':
                values = {a.decode(errors='replace') for a in args[1:]}
                if values.intersection({'build', 'buildx', 'pull', 'load', 'import', 'up', 'create', 'run'}):
                    return True
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
    return False


def deployment_locks():
    paths = set(BROKER.glob('*.lock'))
    policy = read_json(Path('/etc/vps-operations/policy.json'), {})
    for name in policy.get('projects', {}):
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', name):
            raise ValueError('Invalid deployment identity')
        paths.add(BROKER / (name + '.lock'))
    paths.update(Path('/run/lock') / name for name in [
        'softload-actions-deploy.lock', 'vps-panel-api-rollout.lock', 'vps-panel-install.lock'])
    paths.add(Path('/run/lock/softload-panel/panel-web-deploy.lock'))
    return paths


def lock_deployments(stack):
    import fcntl
    paths = deployment_locks()
    for path in sorted(paths):
        if path.parent.exists():
            lock = stack.enter_context(path.open('a'))
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    # Fail closed if a new deployment identity appeared during lock acquisition.
    if not set(BROKER.glob('*.lock')).issubset(paths):
        raise BlockingIOError('Deployment lock set changed')


def protected_imports():
    rows = read_json(DATA / 'image-imports.json', [])
    if not isinstance(rows, list):
        raise ValueError('Invalid import ledger')
    refs = []
    for row in rows:
        if isinstance(row, dict) and isinstance(row.get('repository'), str) and isinstance(row.get('digest'), str):
            refs.append('ghcr.io/' + row['repository'].lower() + '@' + row['digest'])
    return refs


def remove_target(target):
    for ref in target['refs']:
        # Refresh ALL containers and the resolved reference before every mutation.
        images, containers = inventory()
        if any(c['Image'] == target['id'] for c in containers):
            return False
        current = docker('image', 'inspect', ref, check=False)
        if current.returncode:  # A preceding untag may already have removed the digest.
            continue
        if json.loads(current.stdout)[0]['Id'] != target['id']:
            return False
        if ref in protected_imports():
            return False
        # No force and no recursive parent deletion. Docker independently refuses use.
        if docker('image', 'rm', '--no-prune', ref, check=False).returncode:
            return False
    return docker('image', 'inspect', target['id'], check=False).returncode != 0


def execute(apply=False, minimum_age=INTERVAL, scheduled=False):
    if os.geteuid() != 0:
        raise PermissionError('Host administrator required')
    ROOT.mkdir(mode=0o700, exist_ok=True)
    state = read_json(ROOT / 'state.json', {})
    now = int(time.time())
    request = read_json(DATA / REQUEST, {})
    requested = (isinstance(request, dict)
                 and isinstance(request.get('id'), str)
                 and re.fullmatch(r'[a-f0-9-]{36}', request['id'])
                 and request['id'] != state.get('lastRequestId')
                 and isinstance(request.get('requestedAt'), (int, float))
                 and 0 <= now - request['requestedAt'] / 1000 <= 86400)
    settings = read_json(DATA / 'revision-cleanup-settings.json', {})
    if scheduled and not requested:
        if settings.get('automatic') is False or now - state.get('lastCompletedAt', 0) < INTERVAL:
            return {'status': 'not-due'}
    report = {'installed': True, 'status': 'planned', 'checkedAt': now * 1000,
              'intervalHours': 6, 'removed': 0, 'failed': 0, 'bytesFreed': 0,
              'source': 'manual' if requested or not scheduled else 'automatic'}
    if requested:
        report['requestId'] = request['id']
    with ExitStack() as stack:
        import fcntl
        own_lock = stack.enter_context((ROOT / 'cleanup.lock').open('a'))
        try:
            fcntl.flock(own_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            lock_deployments(stack)
            if busy_process():
                raise BlockingIOError('Build or runner job active')
        except BlockingIOError:
            report['status'] = 'waiting-deploy'
            if apply:
                atomic(DATA / REPORT, report, 0o644)
            return report
        before = shutil.disk_usage('/').used
        images, containers = inventory()
        first_unused, targets = plan(images, containers, state.get('firstUnused', {}),
                                     now, minimum_age, protected_imports())
        report['considered'] = len(targets)
        report['imageCount'] = len(images)
        report['targets'] = targets
        if apply:
            for target in targets:
                # Respect pause immediately during scheduled runs, not only next interval.
                if scheduled and not requested and read_json(DATA / 'revision-cleanup-settings.json', {}).get('automatic') is False:
                    report['status'] = 'paused'
                    break
                if remove_target(target):
                    report['removed'] += 1
                    first_unused.pop(target['id'], None)
                else:
                    report['failed'] += 1
            if report['status'] != 'paused':
                result = docker('builder', 'prune', '--all', '--force', '--filter', 'until=30m', check=False)
                report['cacheCleaned'] = result.returncode == 0
                if result.returncode:
                    report['failed'] += 1
                report['status'] = 'completed' if not report['failed'] else 'partial'
            # containerd garbage collection can finish asynchronously after image removal.
            for _ in range(3 if report['removed'] else 1):
                time.sleep(2)
                report['bytesFreed'] = max(0, before - shutil.disk_usage('/').used)
            report['diskUsedBefore'] = before
            report['diskUsedAfter'] = shutil.disk_usage('/').used
            state['firstUnused'] = first_unused
            if report['status'] == 'completed':
                state['lastCompletedAt'] = now
            if requested and report['status'] in ('completed', 'partial'):
                state['lastRequestId'] = request['id']
            atomic(ROOT / 'state.json', state)
            # Only bounded, credential-free maintenance metadata is shared with the API.
            report.pop('targets')
            atomic(DATA / REPORT, report, 0o644)
            atomic(ROOT / 'last-result.json', report)
        return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--scheduled', action='store_true')
    parser.add_argument('--min-unused-hours', type=float, default=6)
    args = parser.parse_args()
    if not 0 <= args.min_unused_hours <= 720:
        parser.error('Invalid unused-image grace period')
    try:
        outcome = execute(args.apply or args.scheduled, args.min_unused_hours * 3600, args.scheduled)
        print(json.dumps(outcome))
    except Exception as error:
        # No raw subprocess output, account configuration or credential values in logs.
        failure = {'installed': True, 'status': 'failed', 'checkedAt': int(time.time() * 1000),
                   'errorType': type(error).__name__, 'removed': 0, 'bytesFreed': 0}
        if args.apply or args.scheduled:
            try:
                atomic(DATA / REPORT, failure, 0o644)
            except Exception:
                pass
        print(json.dumps(failure)); raise SystemExit(1)
