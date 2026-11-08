"""Roll out ONLY the Codex sidecar through the existing verified Panel Compose overlays.

The root-owned host broker must opt in explicitly. Never change any other service,
production volume, network, login, Docker daemon or existing application image.
"""
import copy
import fcntl
import json
import os
from pathlib import Path
import re
import tempfile
from driver import atomic_json, inspect, run, verify_project, wait_healthy

CONTAINER = 'vps-panel-codex'
API = 'softload-panel-api'
SERVICE = 'codex-agents'
PROJECT = 'softload-panel'
# Same lock that receiver.py holds during API/executor deployment.
PANEL_DEPLOY_LOCK = Path('/var/lib/vps-operations/panel.lock')
PANEL_CURRENT = Path('/opt/vps-panel/current')
SECRET = '/etc/softload-panel/agent-key'
BINDS = {
    '/workspace': ('/srv/panel-codex/workspace', False),
    '/home/node/.codex': ('/srv/panel-codex/home', False),
    '/state': ('/srv/panel-codex/state', False),
    '/run/secrets/panel-agent-key': (SECRET, True),
}


def _assert_container(container, *, api=False):
    labels = container['Config'].get('Labels') or {}
    if labels.get('com.docker.compose.project') != PROJECT or labels.get('com.docker.compose.service') != ('api' if api else SERVICE):
        raise ValueError('Installed Compose ownership differs')
    if not container['State']['Running'] or container['State'].get('Health', {}).get('Status') != 'healthy':
        raise ValueError('Current container is not healthy')
    if not api:
        host = container['HostConfig']
        if (container['Config'].get('User') != '61110:61110' or
            not host.get('ReadonlyRootfs') or host.get('Privileged') or host.get('CapAdd') or
            host.get('PortBindings') or host.get('Binds') and any('docker.sock' in x for x in host['Binds']) or
            host.get('Memory') != 1024**3 or host.get('NanoCpus') != 1500000000 or
            host.get('PidsLimit') != 128 or
            'ALL' not in (host.get('CapDrop') or []) or
            'apparmor=panel-codex' not in (host.get('SecurityOpt') or []) or
            'seccomp=/etc/softload-panel/codex-seccomp.json' not in (host.get('SecurityOpt') or [])):
            raise ValueError('Codex host security differs from registered profile')
        mounts = {m['Destination']: (m.get('Source'), not m.get('RW', True)) for m in container.get('Mounts', []) if m.get('Type') == 'bind'}
        if mounts != BINDS:
            raise ValueError('Codex persistent binds or read-only secret differ')


def _root_owned(path):
    value = path.stat()
    return value.st_uid == 0 and not value.st_mode & 0o022


def _compose_args(api):
    labels = api['Config']['Labels']
    paths = labels.get('com.docker.compose.project.config_files', '').split(',')
    if not paths or len(paths) > 32:
        raise ValueError('Missing registered Compose configuration')
    current = PANEL_CURRENT.resolve()
    if not current.is_dir():
        raise ValueError('Canonical Panel deployment pointer missing')
    for path in paths:
        p = Path(path)
        if (p.parent.resolve() != current or
            not re.fullmatch(r'compose(?:\.[a-z-]+)?\.yaml', p.name) or not p.is_file() or p.is_symlink() or
            not _root_owned(p)):
            raise ValueError('Unrecognized Compose overlay')
    if len(set(paths)) != len(paths) or not any(Path(x).name in ('compose.agents.yaml', 'compose.codex-local.yaml') for x in paths):
        raise ValueError('Codex Compose profile absent or duplicated')
    # The installed API can have many independent overlays. Change the last
    # registered JSON image override for this service, never a guessed base file.
    install = []
    for path in map(Path, paths):
        if path.name in ('compose.install.yaml', 'compose.agent-operations-local.yaml'):
            doc = json.loads(path.read_text())
            if isinstance(doc.get('services', {}).get(SERVICE, {}).get('image'), str):
                install.append(path)
    if not install:
        raise ValueError('Registered Codex image override missing')
    prefix = ['docker', 'compose', '--project-name', PROJECT,
              '--env-file', '/etc/softload-panel/runtime.env', '--project-directory', str(current)]
    return prefix + [arg for path in paths for arg in ('-f', path)], install[-1]


def _assert_idle():
    # Credentials remain inside the existing trusted API, not command arguments.
    source = "import {agentBridge} from './agents.ts';const s=await agentBridge('/status');console.log(JSON.stringify({ready:s.ready,active:s.active}));"
    state = json.loads(run(['docker','exec',API,'node','--input-type=module','-e',source],text=True))
    if state.get('ready') is not True or state.get('active') is not False:
        raise ValueError('Codex unavailable or task active; retry after it finishes')


def _check_compose(args, image):
    doc = json.loads(run(args + ['config', '--format', 'json']))
    services = doc.get('services', {})
    codex = services.get(SERVICE)
    if not isinstance(codex, dict) or codex.get('image') != image:
        raise ValueError('Codex image not selected in Compose')
    if (codex.get('user') != '61110:61110' or codex.get('read_only') is not True or
        codex.get('privileged') or codex.get('ports') or codex.get('network_mode') or
        set(codex.get('networks') or []) != {'proxy', 'codex_egress'} or
        'ALL' not in (codex.get('cap_drop') or []) or
        'apparmor=panel-codex' not in (codex.get('security_opt') or []) or
        'seccomp=/etc/softload-panel/codex-seccomp.json' not in (codex.get('security_opt') or []) or
        codex.get('pids_limit') != 128):
        raise ValueError('Codex Compose isolation changed')
    volumes = codex.get('volumes') or []
    mounts = {}
    for m in volumes:
        if not isinstance(m,dict) or m.get('type') != 'bind':
            raise ValueError('Unexpected Codex mount')
        target = m.get('target')
        if target in mounts:
            raise ValueError('Duplicate Codex mount')
        mounts[target] = (m.get('source'), m.get('read_only', False))
    if mounts != BINDS:
        raise ValueError('Codex mounts or secret permissions changed')
    if 'docker.sock' in json.dumps(codex):
        raise ValueError('Docker socket exposed to Codex')


def _other_ids():
    return {item['Name'].lstrip('/'): item['Id'] for item in
            [inspect(cid) for cid in run(['docker','ps','-aq'], text=True).split()]
            if item['Name'].lstrip('/') != CONTAINER}


def _restore_overlay(path, original):
    with tempfile.NamedTemporaryFile(dir=path.parent,prefix='.codex-rollback-',delete=False) as temp:
        temp.write(original)
        temp.flush()
        os.fsync(temp.fileno())
        os.chmod(temp.name, 0o600)
        name = temp.name
    os.replace(name, path)


def codex_activate(project, sha, images, log):
    # The receiver already holds panel-codex.lock. Also acquire panel.lock:
    # API rollouts copy this very Compose overlay into future releases.
    with PANEL_DEPLOY_LOCK.open('a') as panel_lock:
        fcntl.flock(panel_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            return _codex_activate_locked(project, sha, images, log)
        finally:
            fcntl.flock(panel_lock, fcntl.LOCK_UN)


def _codex_activate_locked(project, sha, images, log):
    if project.get('adapter') != 'codex' or set(project.get('containers',{})) != {SERVICE}:
        raise ValueError('Only Codex sidecar deployment allowed')
    old_api, old_codex = inspect(API), inspect(CONTAINER)
    _assert_container(old_api,api=True)
    _assert_container(old_codex)
    _assert_idle()
    args, overlay = _compose_args(old_api)
    old_bytes = overlay.read_bytes()
    local = json.loads(old_bytes)
    if not isinstance(local,dict) or not isinstance(local.get('services'),dict):
        raise ValueError('Invalid administrative Compose overlay')
    previous_image = old_codex['Config']['Image']
    # Confirm the existing canonical overlay actually describes the installed
    # sidecar before writing it. Never repair a drifting host by guessing.
    prior_config = json.loads(run(args + ['config','--format','json']))
    configured = prior_config.get('services',{}).get(SERVICE,{})
    if configured.get('image') != previous_image:
        raise ValueError('Codex image differs from current Compose source; operator must reconcile')
    _check_compose(args, previous_image)
    new_image = images[SERVICE]
    if new_image == previous_image:
        return dict(verify_project(project,{'sha':sha}),unrelatedServicesPreserved=True)
    new_overlay = copy.deepcopy(local)
    new_overlay['services'].setdefault(SERVICE,{})['image'] = new_image
    new_overlay['services'][SERVICE].setdefault('labels',{})['org.opencontainers.image.revision'] = sha
    before = _other_ids()
    updated = False
    activation_attempted = False
    try:
        atomic_json(overlay,new_overlay)
        updated = True
        _check_compose(args,new_image)
        activation_attempted = True
        run(args + ['up','-d','--no-deps','--no-build','--pull','never',SERVICE],log=log,timeout=120)
        wait_healthy([CONTAINER],seconds=120)
        new = inspect(CONTAINER)
        _assert_container(new)
        if new['Config']['Image'] != new_image:
            raise RuntimeError('Codex running unexpected image')
        result = verify_project(project,{'sha':sha})
        if _other_ids() != before:
            raise RuntimeError('Unrelated container changed during Codex rollout')
        return dict(result,unrelatedServicesPreserved=True)
    except BaseException:
        if updated:
            _restore_overlay(overlay,old_bytes)
            # A failed offline config check has not touched Docker production;
            # restore the config only, without interrupting an active chat.
            if activation_attempted:
                run(args + ['up','-d','--no-deps','--no-build','--pull','never',SERVICE],log=log,timeout=120)
                wait_healthy([CONTAINER],seconds=120)
                _assert_container(inspect(CONTAINER))
                if _other_ids() != before:
                    raise RuntimeError('Unrelated container changed during rollback')
        raise
