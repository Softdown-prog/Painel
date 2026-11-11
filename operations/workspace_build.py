#!/usr/bin/env python3
"""Fixed-purpose, one-job-at-a-time isolated LHS build executor for the Panel VPS.

The host script is a trusted broker: never run untrusted commands on the host,
pass the Docker socket into the job, or expose this script as unauthenticated HTTP.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time

WORKSPACES = Path('/srv/panel-codex/workspace')
JOBS = Path('/srv/panel-workspace-builds')
IMAGE = 'node:24-bookworm-slim'
PROJECT_RE = re.compile(r'^(?!Geral$|AdministracaoVPS$)[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')
JOB_RE = re.compile(r'^[a-f0-9]{16}$')
PROFILES = {
    'lhs-quick': (
        ('install', 'npm ci --no-audit --no-fund', 600, 'bridge'),
        ('typecheck', 'npm run typecheck', 300, 'none'),
        ('build', 'npm run build', 300, 'none'),
        ('poster-regression', 'node --test tests/poster-modules.test.mjs', 120, 'none'),
    ),
    'lhs-core': (
        ('install', 'npm ci --no-audit --no-fund', 600, 'bridge'),
        ('typecheck', 'npm run typecheck', 300, 'none'),
        ('build', 'npm run build', 300, 'none'),
        ('test', 'npm test', 1800, 'none'),
    ),
    'lhs-angular': (
        ('install', 'npm ci --no-audit --no-fund', 600, 'bridge'),
        ('install-angular', 'npm ci --prefix frontend-angular --no-audit --no-fund', 900, 'bridge'),
        ('typecheck', 'npm run typecheck', 300, 'none'),
        ('build', 'npm run build', 300, 'none'),
        ('angular-lint', 'npm run lint --prefix frontend-angular', 300, 'none'),
        ('angular-build', 'npm run build --prefix frontend-angular', 900, 'none'),
    ),
}


def project_dir(name: str, root: Path = WORKSPACES) -> Path:
    if not isinstance(name, str) or not PROJECT_RE.fullmatch(name):
        raise ValueError('Projeto inválido')
    if root.is_symlink():
        raise ValueError('Raiz de workspaces não confiável')
    path = root / name
    if not path.is_dir() or path.is_symlink():
        raise ValueError('Workspace indisponível ou simbólico')
    return path


def docker_args(work: Path, *, source: Path | None, phase: str, network='none') -> list[str]:
    # No ports, Docker socket, host filesystem root, privileged mode or extra capabilities.
    if network not in ('none', 'bridge'):
        raise ValueError('Rede não autorizada')
    argv = ['docker', 'run', '--rm', '--init', '--read-only', '--cap-drop=ALL',
            '--security-opt=no-new-privileges:true', '--pids-limit=128',
            '--cpus=1.5', '--memory=1536m', '--memory-swap=1536m',
            '--network='+network, '--user=61110:61110',
            '--tmpfs=/tmp:rw,nosuid,nodev,size=128m',
            '--env=HOME=/work/.home', '--env=npm_config_cache=/work/.npm-cache',
            '--mount=type=bind,src='+str(work)+',dst=/work',
            '--workdir=/work/games/lan_house_simulator']
    if source is not None:
        argv += ['--mount=type=bind,src='+str(source)+',dst=/source,readonly']
    argv += [IMAGE, 'sh', '-eu', '-c', phase]
    return argv


def clean_copy_command() -> str:
    # The source is mounted only with --network=none. Dependency installs and
    # tests see the *sanitized copy*, never the private project mount.
    return ("test -f /source/games/lan_house_simulator/package.json; "
            "cp -R /source/. /work/; "
            "find /work -type d \\( -name .git -o -name node_modules -o -name .codex \\) -prune -exec rm -rf {} +; "
            "find /work -type f \\( -name .env -o -name '.env.*' -o -name .npmrc -o -name auth.json \\) -delete; "
            "mkdir -p /work/.home /work/.npm-cache")


def write_state(job: Path, **values: object) -> None:
    path = job / 'status.json'
    previous = json.loads(path.read_text()) if path.exists() else {}
    previous.update(values)
    temp = job / 'status.tmp'
    temp.write_text(json.dumps(previous, sort_keys=True))
    os.replace(temp, path)


def run_pipeline(job_id: str, root: Path = WORKSPACES, jobs: Path = JOBS) -> None:
    folder = jobs / job_id
    state = json.loads((folder / 'status.json').read_text())
    try:
        source = project_dir(state['project'], root)
        profile = state['profile']
        if profile not in PROFILES:
            raise ValueError('Perfil desconhecido')
    except (ValueError, KeyError) as exc:
        write_state(folder, status='failed', success=False, error=str(exc)[:400], finished=time.time())
        return
    lock_path = jobs / '.active.lock'
    lock_path.touch(exist_ok=True)
    with lock_path.open('r+') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            write_state(folder, status='busy', finished=time.time(), success=False)
            return
        work = folder / 'source'
        work.mkdir(mode=0o700)
        # The trusted supervisor must create the writable bind mount for the
        # unprivileged Docker user; root credentials are never mounted.
        os.chown(work, 61110, 61110)
        write_state(folder, status='running', started=time.time(), current='snapshot')
        steps = [('snapshot', clean_copy_command(), 120, 'none', source),
                 *[(name, command, timeout, network, None)
                   for name, command, timeout, network in PROFILES[profile]]]
        try:
            for name, command, limit, network, snapshot_source in steps:
                write_state(folder, current=name)
                print('=== '+name+' ===', flush=True)
                argv = docker_args(work, source=snapshot_source, phase=command, network=network)
                try:
                    result = subprocess.run(argv, stdin=subprocess.DEVNULL, timeout=limit, check=False)
                    if result.returncode != 0:
                        raise RuntimeError(f'{name}: código de saída {result.returncode}')
                except subprocess.TimeoutExpired as exc:
                    raise RuntimeError(f'{name}: excedeu {limit} segundos') from exc
            write_state(folder, status='passed', current=None, success=True, finished=time.time())
            print('RESULTADO: APROVADO', flush=True)
        except Exception as exc:
            write_state(folder, status='failed', current=name, success=False, error=str(exc)[:400], finished=time.time())
            print('RESULTADO: FALHOU - '+str(exc)[:400], flush=True)
        finally:
            shutil.rmtree(work, ignore_errors=True)


def start(project: str, profile: str, root: Path = WORKSPACES, jobs: Path = JOBS) -> str:
    project_dir(project, root)
    if profile not in PROFILES:
        raise ValueError('Perfil inválido')
    if os.geteuid() != 0:
        raise PermissionError('Execute somente pelo broker administrativo autorizado da VPS')
    jobs.mkdir(parents=True, exist_ok=True)
    job_id = secrets.token_hex(8)
    folder = jobs / job_id
    folder.mkdir(mode=0o700)
    write_state(folder, status='queued', success=None, project=project, profile=profile, created=time.time())
    output = (folder / 'output.log').open('wb')
    try:
        worker = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '_worker', job_id],
                                  stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                  close_fds=True, start_new_session=True)
        write_state(folder, pid=worker.pid)
    except Exception as exc:
        write_state(folder, status='failed', success=False, error='Não foi possível iniciar o supervisor')
        raise RuntimeError('Falha ao iniciar supervisor do workspace') from exc
    finally:
        output.close()
    return job_id


def redact(text: str) -> str:
    text = re.sub(r'\b(?:gh[pousr]_|github_pat_|sk-proj-|APP_USR-|cfat_)[A-Za-z0-9_\/-]{10,}', '[TOKEN OCULTO]', text)
    return re.sub(r'((?:password|secret|authorization|api[_-]?key|access[_-]?token)\s*[:=]\s*)[^\r\n]+',
                  r'\1[OCULTO]', text, flags=re.IGNORECASE)

def status(job_id: str, jobs: Path = JOBS) -> dict:
    if not JOB_RE.fullmatch(job_id):
        raise ValueError('Identificador inválido')
    folder = jobs / job_id
    if not folder.is_dir() or folder.is_symlink():
        raise ValueError('Job não encontrado')
    state = json.loads((folder / 'status.json').read_text())
    log = folder / 'output.log'
    if log.exists():
        with log.open('rb') as source:
            source.seek(max(0, source.seek(0, 2) - 5000))
            tail = source.read().decode('utf8', 'replace')
        # Return only a bounded log excerpt; never print raw workspace files.
        state['logTail'] = redact(tail[-4000:])
    return {k: v for k, v in state.items() if k != 'pid'}


def main() -> int:
    parser = argparse.ArgumentParser(description='Workspace de build isolado; somente perfis fixos')
    sub = parser.add_subparsers(dest='action', required=True)
    begin = sub.add_parser('start');begin.add_argument('project');begin.add_argument('profile', choices=PROFILES)
    check = sub.add_parser('status');check.add_argument('job_id')
    worker = sub.add_parser('_worker', help=argparse.SUPPRESS);worker.add_argument('job_id')
    args = parser.parse_args()
    try:
        if args.action == 'start':
            print(json.dumps({'jobId': start(args.project, args.profile), 'status':'queued'}))
        elif args.action == 'status':
            print(json.dumps(status(args.job_id)))
        else:
            if not JOB_RE.fullmatch(args.job_id):
                raise ValueError('Job inválido')
            run_pipeline(args.job_id)
    except Exception as exc:
        print(json.dumps({'error':str(exc)[:300]}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
