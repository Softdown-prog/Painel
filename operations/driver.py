"""Root-owned deployment adapters: fixed projects/services, immutable image digests and rollback."""
import contextlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request

def run(argv, log=None, **kwargs):
    return subprocess.check_output(argv, stderr=log or subprocess.STDOUT, timeout=kwargs.pop('timeout', 180), **kwargs)

def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]

def image_info(ref):
    return json.loads(run(['docker', 'image', 'inspect', ref]))[0]

def wait_healthy(names, seconds=150):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if all((c := inspect(name))['State']['Running'] and c['State'].get('Health', {}).get('Status') == 'healthy' for name in names):
            return
        time.sleep(3)
    raise RuntimeError('Service failed healthcheck')

def verify_project(project, args):
    if project['adapter'] == 'web':
        from web import verify_web
        return verify_web(project, args)
    sha = args.get('sha')
    if not isinstance(sha, str) or not re.fullmatch('[0-9a-f]{40}', sha):
        raise ValueError('A full expected SHA is required')
    services = []
    for service, name in project['containers'].items():
        c = inspect(name)
        im = image_info(c['Image'])
        revision = (im['Config'].get('Labels') or {}).get('org.opencontainers.image.revision')
        if not c['State']['Running'] or c['State'].get('Health', {}).get('Status') != 'healthy' or revision != sha:
            raise RuntimeError('Installed revision/health differs from expected')
        services.append({'service': service, 'container': name, 'revision': revision, 'imageId': c['Image'],
                         'image': c['Config']['Image'], 'digests': im.get('RepoDigests') or [], 'health': 'healthy'})
    if project.get('public_url'):
        request = urllib.request.Request(project['public_url'] + '?revision=' + sha,
                                         headers={'User-Agent': 'VPS-Operations-Healthcheck/1.0',
                                                  'Accept': 'application/json', 'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.load(response)
        if project['adapter'] == 'panel' and payload.get('revision') != sha:
            raise RuntimeError('Public API serves a different revision')
        if project['adapter'] == 'compose' and payload.get('revision') != sha:
            raise RuntimeError('Public service serves a different revision')
    return {'services': services, 'publicUrl': project.get('public_url'), 'publicVerified': bool(project.get('public_url'))}

def prepare_images(project, args, token, log):
    sha, images = args['sha'], args.get('images', {})
    if set(images) != set(project['images']):
        raise ValueError('Image set differs from authorized project services')
    with tempfile.TemporaryDirectory(prefix='vps-registry-') as directory:
        env = dict(os.environ, DOCKER_CONFIG=directory)
        if not token or len(token) > 4096:
            raise ValueError('Ephemeral registry credential required')
        subprocess.run(['docker', 'login', 'ghcr.io', '--username', 'github', '--password-stdin'],
                       input=token.encode(), stdout=log, stderr=log, env=env, check=True, timeout=30)
        for service, repository in project['images'].items():
            ref = images[service]
            if not re.fullmatch(re.escape(repository) + r'@sha256:[0-9a-f]{64}', ref):
                raise ValueError('Unauthorized registry/digest')
            run(['docker', 'pull', ref], log=log, env=env, timeout=600)
            labels = image_info(ref)['Config'].get('Labels') or {}
            if labels.get('org.opencontainers.image.revision') != sha or labels.get('org.opencontainers.image.source') != 'https://github.com/' + project['repository']:
                raise ValueError('Image revision/source label mismatch')
    return images

def prepare_release(project, sha):
    root = Path(project['releases'])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    release = root / sha
    if release.exists():
        # Only immutable, fully unpacked revisions created by this installer may be reused.
        if (release / '.vps-operations-complete').read_text() != sha:
            raise ValueError('Existing incomplete release')
        return release
    with tempfile.TemporaryDirectory(dir=root, prefix='.incoming-') as staging:
        archive = Path(staging) / 'source.tar.gz'
        url = 'https://codeload.github.com/' + project['repository'] + '/tar.gz/' + sha
        with urllib.request.urlopen(url, timeout=120) as response, archive.open('wb') as output:
            shutil.copyfileobj(response, output)
        source = Path(staging) / 'source'
        source.mkdir()
        with tarfile.open(archive) as tar:
            tar.extractall(source, filter='data')
        top = list(source.iterdir())
        if len(top) != 1 or not top[0].is_dir():
            raise ValueError('Invalid source archive')
        (top[0] / '.vps-operations-complete').write_text(sha)
        os.rename(top[0], release)
    return release

def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_name('.' + path.name + '.next')
    with temporary.open('w') as output:
        json.dump(value, output); output.flush(); os.fsync(output.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)

def panel_activate(project, sha, images, log):
    release = prepare_release(project, sha) / 'server'
    old = inspect(project['containers']['api'])
    old_files = old['Config']['Labels']['com.docker.compose.project.config_files'].split(',')
    current = Path('/opt/vps-panel/current').resolve()
    if any(Path(f).parent != current for f in old_files):
        raise ValueError('Installed API overlays not aligned with current pointer')
    existing = [inspect(cid) for cid in run(['docker', 'ps', '-aq'], text=True).split()]
    before = {c['Name'].lstrip('/'): c['Id'] for c in existing if c['Name'].lstrip('/') not in project['containers'].values()}
    new_files = []
    for old_file in old_files:
        name = Path(old_file).name
        if not re.fullmatch(r'compose(?:\.[a-z-]+)?\.yaml', name):
            raise ValueError('Unexpected overlay')
        dest = release / name
        if name == 'compose.install.yaml' or not dest.exists():
            shutil.copy2(old_file, dest)
        new_files.append(str(dest))
    install = release / 'compose.install.yaml'
    overlay = json.loads(install.read_text())
    for service in project['containers']:
        overlay['services'].setdefault(service, {})['image'] = images[service]
        overlay['services'][service].setdefault('labels', {})['org.opencontainers.image.revision'] = sha
    overlay['services']['api'].setdefault('environment', {})['PANEL_RELEASE_SHA'] = sha
    atomic_json(install, overlay)
    base = ['docker', 'compose', '--project-name', old['Config']['Labels']['com.docker.compose.project'],
            '--env-file', '/etc/softload-panel/runtime.env']
    old_args = base + [v for f in old_files for v in ('-f', f)]
    new_args = base + [v for f in new_files for v in ('-f', f)]
    config = json.loads(run(new_args + ['config', '--format', 'json'], log=log))
    if set(config['services']['api']['networks']) != {'proxy', 'postgres_shared'} or config['services']['executor']['network_mode'] != 'none':
        raise ValueError('Administrative network isolation changed')
    if config['volumes']['panel_data']['name'] != 'softload_panel_data' or config['services']['api'].get('ports'):
        raise ValueError('Data volume or public exposure changed')
    activated = False
    registry_path = Path('/etc/softload-panel/compose-production-files.json')
    previous_registry = json.loads(registry_path.read_text())
    registry_changed = False
    try:
        activated = True
        for service in ('executor', 'api'):
            run(new_args + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', service], log=log)
            wait_healthy([project['containers'][service]])
        result = verify_project(project, {'sha': sha})
        run(['docker', 'exec', project['containers']['api'], 'node', '--input-type=module', '-e',
             'import {getDatabaseStatus} from "./database.ts";process.exit((await getDatabaseStatus()).integration==="connected"?0:1)'], log=log)
        after = {name: inspect(name)['Id'] for name in before}
        if after != before:
            raise RuntimeError('Unrelated service changed during rollout')
        registry = previous_registry
        # Update all registered overlay paths together, preserving local-only overlays and env-file flags.
        registry = json.loads(json.dumps(registry).replace(str(current), str(release)))
        atomic_json(registry_path, registry)
        registry_changed = True
        pointer = Path('/opt/vps-panel/.operations-next')
        pointer.unlink(missing_ok=True); pointer.symlink_to(release); os.replace(pointer, '/opt/vps-panel/current')
        return dict(result, unrelatedServicesPreserved=True)
    except BaseException:
        if activated:
            for service in ('executor', 'api'):
                run(old_args + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', service], log=log)
            wait_healthy(list(project['containers'].values()))
        if registry_changed:
            atomic_json(registry_path, previous_registry)
            pointer = Path('/opt/vps-panel/.operations-rollback')
            pointer.unlink(missing_ok=True); pointer.symlink_to(current); os.replace(pointer, '/opt/vps-panel/current')
        raise

def compose_activate(project, sha, images, log):
    # Dedicated single-project Compose; never invokes down/orphans/prune or changes shared services.
    release = prepare_release(project, sha)
    container = inspect(project['containers']['multiplayer'])
    labels = container['Config']['Labels']
    old_files = labels['com.docker.compose.project.config_files'].split(',')
    old_args = ['docker', 'compose', '--project-name', labels['com.docker.compose.project'],
                '--env-file', project['env_file']] + [v for f in old_files for v in ('-f', f)]
    old_image = container['Config']['Image']
    # Snapshot only the existing effective service config, not env secrets to GitHub.
    config = json.loads(run(old_args + ['config', '--format', 'json'], log=log))
    config['services']['multiplayer'].pop('build', None)
    config['services']['multiplayer']['image'] = images['multiplayer']
    config['services']['multiplayer'].setdefault('environment', {})['GIT_SHA'] = sha
    config['services']['multiplayer'].setdefault('labels', {})['org.opencontainers.image.revision'] = sha
    path = release / 'vps-production.json'
    atomic_json(path, config)
    command = ['docker', 'compose', '--project-name', labels['com.docker.compose.project'], '-f', str(path)]
    try:
        run(command + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'multiplayer'], log=log)
        wait_healthy(list(project['containers'].values()))
        return verify_project(project, {'sha': sha})
    except BaseException:
        # The prior effective Compose is retained by its immutable release path.
        # On the first migration the legacy mutable image remains untouched by digest-based pulls.
        run(old_args + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'multiplayer'], log=log)
        wait_healthy(list(project['containers'].values()))
        raise

def deploy(project, args, token, state):
    sha = args.get('sha', '')
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('Invalid SHA')
    with open(state / ('deploy-' + project['adapter'] + '-' + sha + '.log'), 'ab', buffering=0) as log:
        try:
            images = prepare_images(project, args, token, log)
            if project['adapter'] == 'web':
                from web import web_activate
                return web_activate(project, sha, images, log)
            if project['adapter'] == 'panel':
                return panel_activate(project, sha, images, log)
            if project['adapter'] == 'compose':
                return compose_activate(project, sha, images, log)
            raise ValueError('Unauthorized deployment adapter')
        except BaseException:
            import traceback
            log.write(traceback.format_exc().encode())
            raise
