"""ChatGPT -> GitHub Issue -> VPS Docker tests. No Codex, arbitrary shell or deploy."""
from __future__ import annotations
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

PROJECTS = {
    'lhs': ('Softdown-prog/A7-forge-2D-', 'lhs-precommit'),
    'terrania': ('Softdown-prog/Terrania', 'terrania-precommit'),
}
SHA = re.compile(r'[a-f0-9]{40}\Z')
JOB = re.compile(r'[a-f0-9]{16}\Z')
STATE = Path('/var/lib/panel-chatgpt-workspaces')
SOURCES = Path('/srv/panel-chatgpt-sources')
SUPERVISOR = Path('/usr/local/lib/panel-workspaces/workspace_build.py')


def authorize(policy, args):
    gate = policy.get('workspace') or {}
    if not gate.get('enabled'):
        raise PermissionError('Workspace bridge disabled by root policy')
    if not isinstance(args, dict):
        raise ValueError('Invalid request')
    action = args.get('action')
    if action == 'check' and set(args) == {'action'}:
        return 'check', None
    if action == 'start' and set(args) == {'action','project','profile','sha'}:
        project = args['project']
        if type(project) is not str or project not in PROJECTS:
            raise ValueError('Unknown game')
        if args['profile'] != PROJECTS[project][1]:
            raise ValueError('Only complete precommit profiles allowed')
        if type(args['sha']) is not str or not SHA.fullmatch(args['sha']):
            raise ValueError('Full immutable source SHA required')
        if project not in gate.get('projects', []):
            raise PermissionError('Game not approved by root policy')
        return 'start', project
    if action == 'status' and set(args) == {'action','jobId'} and type(args['jobId']) is str and JOB.fullmatch(args['jobId']):
        return 'status', None
    raise ValueError('Unsupported or malformed operation')


def supervisor():
    if not SUPERVISOR.is_file() or SUPERVISOR.is_symlink():
        raise RuntimeError('Root-owned Node24 supervisor is unavailable')
    spec = importlib.util.spec_from_file_location('chatgpt_supervisor', SUPERVISOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(argv, cwd):
    env = {'PATH':'/usr/bin:/bin', 'HOME':str(STATE), 'GIT_CONFIG_NOSYSTEM':'1',
           'GIT_CONFIG_GLOBAL':'/dev/null', 'GIT_TERMINAL_PROMPT':'0',
           'GIT_LFS_SKIP_SMUDGE':'1'}
    p = subprocess.run(['/usr/bin/git', *argv], cwd=str(cwd), env=env,
                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                       stderr=subprocess.DEVNULL, timeout=240, check=False)
    if p.returncode:
        raise RuntimeError('Git fetch failed; no build started')
    return p.stdout.decode('utf-8', 'replace').strip()


def source_checkout(project, sha):
    if SOURCES.is_symlink() or not SOURCES.is_dir() or SOURCES.stat().st_uid != 0 or SOURCES.stat().st_mode & 0o022:
        raise RuntimeError('Root-owned source workspace root is unavailable or writable')
    if shutil.disk_usage(SOURCES).free < 6 * 1024**3:
        raise RuntimeError('At least 6 GiB free disk required')
    name = 'cg_' + project + '_' + sha[:16]
    dest = SOURCES / name
    marker = STATE / ('source-' + name + '.json')
    if dest.exists() or dest.is_symlink():
        if dest.is_symlink() or not dest.is_dir() or not marker.is_file() or marker.is_symlink():
            raise RuntimeError('Source provenance not trusted')
        if json.loads(marker.read_text()) != {'project':project,'sha':sha}:
            raise RuntimeError('Source revision mismatch')
        return name
    # Separate, root-owned repository snapshot. No dependency on the Codex runtime.
    with tempfile.TemporaryDirectory(prefix='.chatgpt-fetch-', dir=SOURCES) as folder:
        work = Path(folder)
        git(['init','-q'], work)
        git(['-c','core.hooksPath=/dev/null','fetch','--no-tags','--depth=1',
             'https://github.com/' + PROJECTS[project][0] + '.git', sha], work)
        git(['-c','core.hooksPath=/dev/null','checkout','-q','--detach','FETCH_HEAD'], work)
        if git(['rev-parse','HEAD'],work) != sha:
            raise RuntimeError('Git commit did not match requested revision')
        shutil.rmtree(work / '.git')
        count = size = 0
        for entry in work.rglob('*'):
            count += 1
            if count > 12000 or entry.is_symlink():
                raise RuntimeError('Unsafe repository snapshot')
            if entry.is_file():
                size += entry.stat().st_size
            if size > 512 * 1024**2:
                raise RuntimeError('Repository exceeds source size cap')
        required = (work/'games/lan_house_simulator/package.json' if project=='lhs'
                    else work/'angular.json')
        if not required.is_file():
            raise RuntimeError('Revision not from expected game')
        if project == 'terrania':
            if json.loads((work/'package.json').read_text()).get('name') != 'terrania-origins':
                raise RuntimeError('Unexpected game manifest')
        work.chmod(0o755)  # Readable by isolated Docker UID 61110.
        os.rename(work, dest)
    marker.write_text(json.dumps({'project':project,'sha':sha}))
    marker.chmod(0o600)
    return name


def run_workspace(policy, args):
    action, project = authorize(policy, args)
    if STATE.is_symlink():
        raise RuntimeError('Unsafe state directory')
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    ws = supervisor()
    if getattr(ws, 'CHATGPT_WORKSPACES', None) != SOURCES:
        raise RuntimeError('Installed supervisor does not support isolated ChatGPT workspace')
    if action == 'check':
        return {'action':'check','supervisorInstalled':True,
                'profiles':[x[1] for x in PROJECTS.values()], 'changed':False}
    if action == 'status':
        jid = args['jobId']
        receipt = STATE/('job-'+jid+'.json')
        if receipt.is_symlink() or not receipt.is_file():
            raise ValueError('Unknown ChatGPT job')
        registered = json.loads(receipt.read_text())
        state = ws.status(jid)
        if state.get('project') != registered['workspace'] or state.get('profile') != registered['profile']:
            raise RuntimeError('Job identity does not match request')
        stages = {'snapshot'} | {s[0] for s in ws.PROFILES[registered['profile']]}
        step = state.get('current')
        status = state.get('status')
        return {'action':'status','jobId':jid,'project':registered['project'],
                'sourceSha':registered['sha'],'profile':registered['profile'],
                'status':status if status in ('queued','running','passed','failed','busy') else 'unknown',
                'passed':status=='passed' and state.get('success') is True,
                'step':step if step in stages else None,
                'diagnostic':'inspect-private-job-logs' if status=='failed' else None,
                'changed':False}
    with (STATE/'start.lock').open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Refuse a second test during a queued/running build instead of starving 4 GB VPS.
        for entry in ws.JOBS.iterdir():
            if entry.is_dir() and JOB.fullmatch(entry.name) and (entry/'status.json').is_file():
                if json.loads((entry/'status.json').read_text()).get('status') in ('queued','running'):
                    raise RuntimeError('Another workspace build is active')
        work = source_checkout(project,args['sha'])
        jid = ws.start(work,args['profile'],root=ws.CHATGPT_WORKSPACES)
        receipt = STATE/('job-'+jid+'.json')
        with receipt.open('x') as file:
            json.dump({'project':project,'sha':args['sha'],
                       'profile':args['profile'],'workspace':work},file)
        receipt.chmod(0o600)
        return {'action':'start','jobId':jid,'project':project,'sourceSha':args['sha'],
                'profile':args['profile'],'status':'queued','passed':False,'changed':True}
