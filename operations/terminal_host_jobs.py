#!/usr/bin/env python3
"""Host-owned terminal jobs. Only invoked through an explicitly installed helper.

Commands and output are transient root-readable files (0600); no command is put
in process arguments or journald. A systemd transient unit owns each job, not
the Panel API process, so restarting the API does not terminate SSH jobs.
"""
from __future__ import annotations
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

ROOT = Path('/var/lib/vps-panel-terminal-jobs')
SELF = '/usr/local/libexec/vps-panel-terminal-jobs'
ID = re.compile(r'^[0-9a-f]{32}$')
FP = re.compile(r'^[0-9a-f]{16}$')
MAX_COMMAND = 4 * 1024 * 1024
MAX_OUTPUT = 64_000  # same limit the Panel UI already expects
MAX_AGE = 3600
MAX_RUNTIME = 1800
MAX_JOBS = 12

def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

def encode(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))

def check_id(value):
    if not ID.fullmatch(value):
        raise ValueError('Invalid job ID')
    return value

def ensure_root():
    if os.geteuid() != 0:
        raise PermissionError('Only host root may manage terminal jobs')
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    if ROOT.is_symlink() or ROOT.stat().st_uid != 0 or ROOT.stat().st_mode & 0o077:
        raise PermissionError('Unsafe terminal jobs directory')

def atomic(path: Path, data: bytes):
    with tempfile.NamedTemporaryFile(prefix='.staging-', dir=ROOT, delete=False) as file:
        stage=Path(file.name)
        os.fchmod(file.fileno(), 0o600)
        file.write(data)
        file.flush()
        os.fsync(file.fileno())
    try:
        os.replace(stage, path)
    finally:
        stage.unlink(missing_ok=True)

def meta_path(job_id):
    return ROOT / ('job-'+check_id(job_id)+'.json')

def read_meta(job_id):
    path=meta_path(job_id)
    if not path.is_file() or path.is_symlink():
        return None
    data=json.loads(path.read_text())
    if data.get('id') != job_id:
        raise ValueError('Job identity mismatch')
    return data

def save(data):
    atomic(meta_path(data['id']), encode(data).encode('utf-8'))

def unit(job_id):
    return 'vps-panel-terminal-'+check_id(job_id)+'.service'

def systemd_state(job_id):
    result=subprocess.run(['systemctl','show',unit(job_id),
                          '--property=ActiveState,Result', '--no-pager'],
                         capture_output=True, text=True, timeout=5)
    if result.returncode:
        return ('unknown','unknown')
    props=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
    return props.get('ActiveState','unknown'),props.get('Result','unknown')

def reconcile(data):
    if data['state'] != 'running':
        return data
    active, result=systemd_state(data['id'])
    if active in ('active','activating'):
        return data
    started=data.get('startedAt')
    seconds=0
    try:
        seconds=time.time()-datetime.fromisoformat(started.replace('Z','+00:00')).timestamp()
    except (TypeError,ValueError,AttributeError):
        seconds=MAX_RUNTIME+1
    # Race immediately after start: systemd-run may have queued the unit.
    if active == 'inactive' and seconds < 5:
        return data
    if active in ('inactive','failed','unknown','deactivating') and seconds>=5:
        data['state']='cancelled' if data.get('cancelRequested') else ('timed_out' if result=='timeout' or seconds>MAX_RUNTIME+5 else 'failed')
        data['finishedAt']=now()
        data['error']=None if data['state'] in ('timed_out','cancelled') else 'SSH job ended without confirmed completion. Verify the VPS.'
        data['exitCode']=None
        save(data)
        # A killed transient unit may have skipped Python's cleanup.
        (ROOT/('script-'+data['id']+'.sh')).unlink(missing_ok=True)
    return data

def prune():
    entries=[]
    for path in ROOT.glob('job-*.json'):
        match=re.fullmatch(r'job-([0-9a-f]{32})\.json',path.name)
        if not match or path.is_symlink():
            continue
        try:
            data=read_meta(match.group(1))
            data=reconcile(data)
            entries.append(data)
        except (OSError,ValueError,KeyError,json.JSONDecodeError):
            continue
    entries.sort(key=lambda d:d['startedAt'],reverse=True)
    for i, entry in enumerate(entries):
        if entry['state']=='running':
            continue
        try:
            age=time.time()-datetime.fromisoformat(entry['finishedAt'].replace('Z','+00:00')).timestamp()
        except (TypeError,ValueError,AttributeError):
            age=MAX_AGE+1
        if age>MAX_AGE or i>=MAX_JOBS:
            for name in ('job-'+entry['id']+'.json','output-'+entry['id']+'.txt',
                         'script-'+entry['id']+'.sh'):
                (ROOT/name).unlink(missing_ok=True)
    return [entry for entry in entries if meta_path(entry['id']).exists()]

def public(data):
    if data is None:
        return None
    output=ROOT/('output-'+data['id']+'.txt')
    content=output.read_bytes()[:MAX_OUTPUT].decode('utf-8','replace') if output.is_file() and not output.is_symlink() else ''
    finished=data.get('finishedAt')
    end=datetime.fromisoformat(finished.replace('Z','+00:00')).timestamp() if finished else time.time()
    start=datetime.fromisoformat(data['startedAt'].replace('Z','+00:00')).timestamp()
    return {'id':data['id'],'state':data['state'],'startedAt':data['startedAt'],
            'finishedAt':finished,'exitCode':data.get('exitCode'),
            'output':content,'truncated':data.get('truncated',False),
            'durationMs':max(0,round((end-start)*1000)),
            'error':data.get('error'),'fingerprint':data['fingerprint']}

def start(job_id, fingerprint):
    check_id(job_id)
    if not FP.fullmatch(fingerprint):
        raise ValueError('Invalid command fingerprint')
    # Shared across API replicas and restarts; do not accept two simultaneous jobs.
    existing=prune()
    if any(entry['state']=='running' for entry in existing):
        return {'busy':True}
    if read_meta(job_id):
        raise ValueError('Job already exists')
    script=sys.stdin.buffer.read(MAX_COMMAND+1)
    if not 0<len(script)<=MAX_COMMAND or not script.strip() or b'\x00' in script:
        raise ValueError('Invalid script length or content')
    if hashlib.sha256(script).hexdigest()[:16]!=fingerprint:
        raise ValueError('Fingerprint does not match script')
    script_path=ROOT/('script-'+job_id+'.sh')
    # Never log the command or put it in systemd unit arguments.
    fd=os.open(script_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as file:
        file.write(script)
        file.write(b'\n')
    data={'id':job_id,'fingerprint':fingerprint,'state':'running','startedAt':now(),
          'finishedAt':None,'exitCode':None,'error':None,'truncated':False,
          'cancelRequested':False}
    save(data)
    cmd=['systemd-run','--quiet','--collect','--unit='+unit(job_id),
         '--property=RuntimeMaxSec=1800','--property=MemoryMax=2147483648',
         '/usr/bin/python3', SELF, 'run',job_id]
    try:
        subprocess.run(cmd,stdin=subprocess.DEVNULL,check=True,timeout=10,
                       capture_output=True)
    except (subprocess.SubprocessError,OSError):
        data['state']='failed'
        data['finishedAt']=now()
        data['error']='Could not start host job supervisor'
        save(data)
        script_path.unlink(missing_ok=True)
        raise RuntimeError('Could not start host job supervisor')
    return {'job':public(data)}

def run(job_id):
    data=read_meta(job_id)
    if data is None or data['state']!='running':
        raise ValueError('Job not running')
    script=ROOT/('script-'+job_id+'.sh')
    output=ROOT/('output-'+job_id+'.txt')
    fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    code=None
    try:
        # systemd owns this process group; API/SSH disconnect cannot kill it.
        # sh reads the script by pathname, never via argv.
        with os.fdopen(fd,'wb',buffering=0) as file:
            process=subprocess.Popen(['/bin/sh',str(script)],stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE,stderr=subprocess.STDOUT,
                                     close_fds=True)
            assert process.stdout is not None
            total=0
            while True:
                block=os.read(process.stdout.fileno(),8192)
                if not block:
                    break
                left=max(0,MAX_OUTPUT-total)
                if left:
                    file.write(block[:left])
                    file.flush()
                    total+=min(len(block),left)
                if len(block)>left and not data['truncated']:
                    data['truncated']=True
                    save(data)
            code=process.wait()
    finally:
        script.unlink(missing_ok=True)
        latest=read_meta(job_id)
        if latest is not None:
            latest['state']='cancelled' if latest.get('cancelRequested') else ('completed' if code==0 else 'failed')
            latest['exitCode']=code
            latest['finishedAt']=now()
            latest['truncated']=data['truncated']
            save(latest)
    return code if code is not None else 1

def cancel(job_id):
    data=read_meta(job_id)
    if data is None:
        return {'notFound':True}
    data=reconcile(data)
    if data['state']=='running':
        data['cancelRequested']=True
        save(data)
        subprocess.run(['systemctl','stop','--no-block',unit(job_id)],
                       capture_output=True,timeout=8,check=False)
    return {'job':public(data)}

def main():
    os.umask(0o077)
    ensure_root()
    action=sys.argv[1] if len(sys.argv)>1 else ''
    with open(ROOT/'operations.lock','a+') as lock:
        if action != 'run':
            fcntl.flock(lock,fcntl.LOCK_EX)
        if action=='start' and len(sys.argv)==4:
            answer=start(sys.argv[2],sys.argv[3])
        elif action=='current' and len(sys.argv)==2:
            entries=prune()
            answer={'job':public(entries[0]) if entries else None}
        elif action=='status' and len(sys.argv)==3:
            entry=read_meta(check_id(sys.argv[2]))
            answer={'job':public(reconcile(entry)) if entry else None}
        elif action=='cancel' and len(sys.argv)==3:
            answer=cancel(check_id(sys.argv[2]))
        elif action=='run' and len(sys.argv)==3:
            sys.exit(run(check_id(sys.argv[2])))
        else:
            raise ValueError('Unsupported action')
    print(encode(answer))

if __name__=='__main__':
    try:
        main()
    except (ValueError,PermissionError) as error:
        print(encode({'error':str(error)}))
        sys.exit(2)
    except Exception:
        print(encode({'error':'Host terminal job operation failed'}))
        sys.exit(1)
