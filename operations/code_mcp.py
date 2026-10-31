"""Fixed-purpose, audited MCP container installation via the already-protected vpsops broker.

Never runs arbitrary user-supplied commands, host paths, project names or Docker options.
"""
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import time
import urllib.request

CONTAINER = 'vps-code-mcp'
IMAGE = re.compile(r'^ghcr\.io/softdown-prog/painel-code-mcp@sha256:[a-f0-9]{64}$')
SHA = re.compile(r'^[a-f0-9]{40}$')
TOKEN_PATH = Path('/etc/vps-operations/code-mcp-token')
PORT = 8789
MEMORY = '192m'
CPU = '0.5'

def check_args(args, claim_sha):
    if not isinstance(args, dict) or set(args) != {'action', 'image', 'sha', 'confirm'}:
        raise ValueError('Only fixed MCP action, image, sha and confirm permitted')
    action, image, sha, confirm = (args[k] for k in ('action','image','sha','confirm'))
    if action == 'status' and image == '' and sha == '' and confirm == '':
        return 'status'
    if action != 'install' or not all(isinstance(v,str) for v in (image,sha,confirm)):
        raise ValueError('Unsupported MCP operation')
    if not IMAGE.fullmatch(image) or not SHA.fullmatch(sha) or sha != claim_sha:
        raise ValueError('Untrusted image or revision')
    if confirm != 'INSTALL:code-mcp':
        raise ValueError('Exact installation confirmation required')
    return 'install'

def docker(*args, input=None, timeout=90, env=None):
    output = subprocess.run(['docker', *args], input=input, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, env=env, check=True)
    return output.stdout.strip()

def inspect():
    try:
        raw = json.loads(docker('inspect', CONTAINER,timeout=20))[0]
    except subprocess.CalledProcessError:
        return None
    labels = raw['Config'].get('Labels') or {}
    if labels.get('com.softdown.code-mcp.managed') != 'true':
        raise RuntimeError('Reserved MCP container name belongs to a different owner')
    return raw

def status():
    current = inspect()
    if current is None:
        return {'installed':False, 'container':CONTAINER, 'changed':False}
    labels = current['Config'].get('Labels') or {}
    return {'installed':True,'container':CONTAINER,'status':current['State']['Status'],
            'health':current['State'].get('Health',{}).get('Status'),
            'revision':labels.get('org.opencontainers.image.revision'),
            'image':current['Config']['Image'],'changed':False}

def create_token():
    if TOKEN_PATH.exists():
        if not TOKEN_PATH.is_file() or TOKEN_PATH.is_symlink():
            raise ValueError('MCP token path must be a regular file')
        if len(TOKEN_PATH.read_bytes().strip())<32:
            raise ValueError('Existing MCP token too short')
        return False
    token = secrets.token_urlsafe(48)
    fd = os.open(TOKEN_PATH,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o440)
    try:
        with os.fdopen(fd,'w') as target:target.write(token+'\n')
        os.chown(TOKEN_PATH,0,65534)
        os.chmod(TOKEN_PATH,0o440)
    except BaseException:
        TOKEN_PATH.unlink(missing_ok=True)
        raise
    return True

def pull_image(image, token):
    if not token or len(token)>4096:raise ValueError('Temporary GHCR token required')
    with tempfile.TemporaryDirectory(prefix='code-mcp-ghcr-',dir='/tmp') as config:
        os.chmod(config,0o700)
        env={**os.environ,'DOCKER_CONFIG':config}
        subprocess.run(['docker','login','ghcr.io','--username','x-access-token','--password-stdin'],
                       input=token,text=True,capture_output=True,env=env,check=True,timeout=30)
        docker('pull',image,timeout=240,env=env)

def verify_image(image, revision):
    data=json.loads(docker('image','inspect',image,timeout=30))[0]
    labels=data.get('Config',{}).get('Labels') or {}
    if (labels.get('org.opencontainers.image.source')!='https://github.com/Softdown-prog/Painel'
        or labels.get('org.opencontainers.image.revision')!=revision):
        raise ValueError('Image is not the authenticated Panel revision')
    if image not in (data.get('RepoDigests') or []):
        raise ValueError('Pulled digest does not match immutable expected image')
    return data['Id']

def install(image, revision, token):
    existing=status()
    if existing['installed']:
        raise ValueError('MCP already installed; replacing existing instances is not enabled')
    pull_image(image,token)
    image_id=verify_image(image,revision)
    created_token=create_token()
    created=False
    try:
        docker('create','--name',CONTAINER,'--restart','unless-stopped',
               '--label','com.softdown.code-mcp.managed=true',
               '--label','org.opencontainers.image.revision='+revision,
               '--network','bridge','--publish',f'127.0.0.1:{PORT}:{PORT}',
               '--read-only','--user','65534:65534','--cap-drop','ALL',
               '--security-opt','no-new-privileges:true',
               '--pids-limit','64','--memory',MEMORY,'--cpus',CPU,
               '--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=16m,uid=65534,gid=65534',
               '--mount',f'type=bind,src={TOKEN_PATH},dst=/run/secrets/code-mcp-token,readonly',
               '-e','REPO_MCP_REGISTRY_FILE=/srv/registry.json',
               '-e','REPO_MCP_TOKEN_FILE=/run/secrets/code-mcp-token',
               '-e',f'PORT={PORT}',image,timeout=60)
        created=True
        docker('start',CONTAINER,timeout=45)
        for attempt in range(30):
            c=inspect()
            if c and c['State']['Status']=='running' and c['State'].get('Health',{}).get('Status')=='healthy':
                return {'installed':True,'changed':True,'container':CONTAINER,
                        'revision':revision,'imageId':image_id,'health':'healthy',
                        'endpoint':'127.0.0.1:8789 (loopback only)'}
            time.sleep(2)
        raise RuntimeError('MCP did not become healthy')
    except BaseException:
        if created:
            docker('rm','--force',CONTAINER,timeout=45)
        if created_token:
            TOKEN_PATH.unlink(missing_ok=True)
        raise

def run_code_mcp(policy,args,claims,token):
    config=policy.get('code_mcp') or {}
    if not config.get('enabled',False):
        raise PermissionError('Code MCP installation not enabled by installed root policy')
    action=check_args(args,claims['sha'])
    if action=='status':return status()
    return install(args['image'],args['sha'],token)
