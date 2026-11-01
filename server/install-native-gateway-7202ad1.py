#!/usr/bin/env python3
"""One-shot, scoped gateway migration using the already-installed hybrid API image."""
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

SHA = '7202ad14551947d039d13a5a0c04451c6b143223'
NAME = 'softload-panel-app-wake'
RECEIPT = Path('/run/panel-native-wake-7202ad1-result.json')
BACKUP = Path('/run/panel-native-wake-7202ad1-compose.before.json')
REPORT = {'revision': SHA, 'status': 'preflight', 'servicesChanged': []}


def run(args, timeout=60, cwd=None):
    return subprocess.check_output(args, stderr=subprocess.STDOUT, timeout=timeout, cwd=cwd)


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def save():
    pending = RECEIPT.with_suffix('.next')
    pending.write_text(json.dumps(REPORT, indent=2) + '\n')
    os.chmod(pending, 0o600)
    os.replace(pending, RECEIPT)


def write_atomic(path, contents):
    pending = path.with_name(path.name + '.native-next')
    with pending.open('wb') as output:
        output.write(contents)
        output.flush()
        os.fsync(output.fileno())
    os.chmod(pending, 0o600)
    os.replace(pending, path)


def wait_healthy():
    until = time.monotonic() + 150
    while time.monotonic() < until:
        value = inspect(NAME)
        if value['State']['Running'] and value['State'].get('Health', {}).get('Status') == 'healthy':
            return value
        time.sleep(2)
    raise RuntimeError('Gateway health did not become healthy')


def mounts(container):
    return sorted((m['Type'], m['Source'], m['Destination'], m['RW']) for m in container['Mounts'])


def validate_sources(api, gateway, current, files):
    if api['Config']['Labels'].get('org.opencontainers.image.revision') != SHA:
        raise RuntimeError('Expected API revision is not installed')
    if api['State'].get('Health', {}).get('Status') != 'healthy':
        raise RuntimeError('API is not healthy')
    if gateway['State'].get('Health', {}).get('Status') != 'healthy':
        raise RuntimeError('Existing gateway is not healthy')
    if gateway['Config']['Labels'].get('com.docker.compose.project') != 'softload-panel':
        raise RuntimeError('Unexpected gateway project')
    if gateway['Config']['Labels'].get('com.docker.compose.service') != 'app-wake':
        raise RuntimeError('Unexpected gateway service')
    if current != Path('/opt/vps-panel/releases') / SHA / 'server':
        raise RuntimeError('Current release pointer differs')
    if not files or any(Path(file).parent != current for file in files):
        raise RuntimeError('API overlays are not aligned')
    install = current / 'compose.install.yaml'
    if str(install) not in files:
        raise RuntimeError('Installed image override is missing')
    return install


def main():
    import fcntl
    lock = Path('/var/lib/vps-operations/panel.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    api = inspect('softload-panel-api')
    gateway = inspect(NAME)
    current = Path('/opt/vps-panel/current').resolve()
    files = api['Config']['Labels']['com.docker.compose.project.config_files'].split(',')
    install = validate_sources(api, gateway, current, files)
    original = install.read_bytes()
    if len(original) > 1024 * 1024 or BACKUP.exists():
        raise RuntimeError('Review existing backup before repeating')
    previous = json.loads(original)
    project = api['Config']['Labels']['com.docker.compose.project']
    compose = ['docker', 'compose', '--project-name', project,
               '--env-file', '/etc/softload-panel/runtime.env']
    compose += [arg for file in files for arg in ('-f', file)]
    effective_before = json.loads(run(compose + ['config', '--format', 'json'], cwd=current))
    container_ids = run(['docker', 'ps', '-aq']).decode().split()
    all_containers = json.loads(run(['docker', 'inspect'] + container_ids)) if container_ids else []
    other_ids = {c['Name'].lstrip('/'): c['Id'] for c in all_containers if c['Name'] != '/' + NAME}
    source = current / 'app-wake.mjs'
    REPORT.update({'previousImage': gateway['Config']['Image'], 'previousImageId': gateway['Image'],
                   'overlayCount': len(files), 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                   'diskUsedBefore': shutil.disk_usage('/').used})
    REPORT['apiNativeSmoke'] = json.loads(run(['docker', 'exec', 'softload-panel-api',
                                               'node', 'native-runtime-smoke.mjs']))
    save()
    base = 'vps-panel-native-base:' + SHA
    image = 'vps-panel-wake:' + SHA
    run(['docker', 'tag', api['Image'], base])
    with tempfile.TemporaryDirectory(prefix='panel-native-wake-', dir='/run') as temporary:
        context = Path(temporary)
        shutil.copyfile(source, context / 'app-wake.mjs')
        (context / 'Dockerfile').write_text('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'
                                            'COPY app-wake.mjs /app/app-wake.mjs\n'
                                            'ENV PORT=8082\nCMD ["node", "app-wake.mjs"]\n')
        REPORT['status'] = 'building-small-gateway-layer'
        save()
        run(['docker', 'build', '--builder', 'default', '--pull=false', '--network', 'none',
             '--build-arg', 'BASE_IMAGE=' + base, '--label', 'org.opencontainers.image.revision=' + SHA,
             '--label', 'org.opencontainers.image.source=https://github.com/Softdown-prog/Painel',
             '-t', image, str(context)], timeout=240)
    REPORT['candidateNativeSmoke'] = json.loads(run(['docker', 'run', '--rm', '--network', 'none',
                                                    '--read-only', '--cap-drop', 'ALL',
                                                    '--security-opt', 'no-new-privileges', '--memory', '96m',
                                                    '--cpus', '0.25', '--pids-limit', '64', image,
                                                    'node', 'native-runtime-smoke.mjs']))
    BACKUP.write_bytes(original)
    os.chmod(BACKUP, 0o600)
    assert BACKUP.read_bytes() == original
    REPORT.update({'configBackup': str(BACKUP), 'configBackupBytes': len(original),
                   'configBackupSha256': hashlib.sha256(original).hexdigest()})
    updated = copy.deepcopy(previous)
    service = updated['services'].setdefault('app-wake', {})
    service['image'] = image
    service.setdefault('labels', {})['org.opencontainers.image.revision'] = SHA
    changed = False
    try:
        write_atomic(install, (json.dumps(updated, indent=2) + '\n').encode())
        changed = True
        effective_after = json.loads(run(compose + ['config', '--format', 'json'], cwd=current))
        before_without_wake = copy.deepcopy(effective_before)
        after_without_wake = copy.deepcopy(effective_after)
        del before_without_wake['services']['app-wake']
        del after_without_wake['services']['app-wake']
        assert before_without_wake == after_without_wake, 'Unrelated effective config changed'
        assert effective_after['services']['app-wake']['image'] == image
        REPORT['status'] = 'activating-gateway-only'
        save()
        run(compose + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app-wake'],
            timeout=90, cwd=current)
        active = wait_healthy()
        assert active['Config']['Image'] == image
        assert active['Config']['Labels'].get('org.opencontainers.image.revision') == SHA
        assert mounts(active) == mounts(gateway), 'Gateway mounts changed'
        assert set(active['NetworkSettings']['Networks']) == set(gateway['NetworkSettings']['Networks'])
        for limit in ('Memory', 'NanoCpus', 'PidsLimit', 'ReadonlyRootfs', 'CapDrop', 'SecurityOpt'):
            assert active['HostConfig'][limit] == gateway['HostConfig'][limit], 'Gateway limits changed'
        assert {name: inspect(name)['Id'] for name in other_ids} == other_ids
        REPORT['gatewayNativeSmoke'] = json.loads(run(['docker', 'exec', NAME, 'node', 'native-runtime-smoke.mjs']))
        REPORT.update({'status': 'installed', 'servicesChanged': [NAME], 'gatewayImage': image,
                       'gatewayImageId': active['Image'], 'health': 'healthy',
                       'otherContainerIdsPreserved': True, 'volumesAndLimitsPreserved': True,
                       'diskUsedAfter': shutil.disk_usage('/').used})
        save()
    except BaseException:
        if changed:
            write_atomic(install, original)
            run(compose + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app-wake'],
                timeout=90, cwd=current)
            restored = wait_healthy()
            REPORT['rollbackVerified'] = restored['Image'] == gateway['Image']
        raise


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except BaseException as error:
        REPORT.update({'status': 'stopped', 'errorType': type(error).__name__, 'error': str(error)[:500]})
        save()
        raise
