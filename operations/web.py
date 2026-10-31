"""Isolated GHCR-only Panel web staging. No npm/build, DNS or shared service changes on VPS."""
import json
from pathlib import Path
import re
import secrets
import subprocess

from driver import atomic_json, image_info, inspect, run, wait_healthy

CONTAINER = 'softload-panel-web'
NETWORK = 'vps_panel_control'
API = 'softload-panel-api'
SECRET = '/etc/softload-panel/edge-key'
ORIGIN = 'https://panel.analysepro.com'
COMPOSE_PROJECT = 'softload-panel'
SOURCE = 'https://github.com/Softdown-prog/Painel'
SHA = re.compile(r'[0-9a-f]{40}\Z')
PROBE_JS = r"""
(async () => {
  const base = 'http://127.0.0.1:8081';
  const [health, session, angular] = await Promise.all([
    fetch(base+'/__panel_web_health', {signal:AbortSignal.timeout(15000)}),
    fetch(base+'/api/session', {signal:AbortSignal.timeout(15000)}),
    fetch(base+'/angular/', {signal:AbortSignal.timeout(15000)})
  ]);
  if (health.status!==200 || session.status!==200 || angular.status!==200)
    throw Error('Frontend/API health invalid');
  const meta=await health.json(), auth=await session.json(), html=await angular.text();
  if (meta.ok!==true || meta.revision!==process.env.EXPECTED_SHA ||
      typeof auth.authenticated!=='boolean' || typeof auth.setupRequired!=='boolean' ||
      !html.includes('panel-app')) throw Error('Frontend revision or Angular contract mismatch');
  const assets=[...html.matchAll(/<script[^>]+src=["']([^"']+\.js)["']/g)].map(match=>match[1]);
  if(!assets.length || !assets.every(x=>/^(?:\.\/)?[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.js$/.test(x)))
    throw Error('Angular bundle absent or unsafe');
  for(const asset of assets) {
    const res=await fetch(base+'/angular/'+asset.replace(/^\.\//,''),{signal:AbortSignal.timeout(15000)});
    if(res.status!==200 || !(await res.text()).length) throw Error('Angular JavaScript asset missing');
  }
})().catch(error=>{console.error(error.message);process.exit(1)});
"""

def optional_inspect(name):
    try:
        return inspect(name)
    except subprocess.CalledProcessError:
        return None

def preflight():
    run(['docker', 'network', 'inspect', NETWORK], timeout=20)
    if not Path(SECRET).is_file():
        raise ValueError('Panel edge secret not provisioned')
    api = inspect(API)
    if not api['State']['Running'] or api['State'].get('Health', {}).get('Status') != 'healthy':
        raise ValueError('Panel API is not healthy')
    if NETWORK not in api['NetworkSettings']['Networks']:
        raise ValueError('Panel API is not on the authorized network')

def web_probe(name, sha):
    run(['docker', 'exec', '-e', 'EXPECTED_SHA='+sha, name, 'node', '-e', PROBE_JS], timeout=80)

def verify_web(project, args):
    sha=args.get('sha')
    if not isinstance(sha, str) or not SHA.fullmatch(sha):
        raise ValueError('Full expected SHA required')
    if project['adapter']!='web' or project['containers']!={'web':CONTAINER}:
        raise ValueError('Invalid frontend project policy')
    c=inspect(CONTAINER)
    il=image_info(c['Image'])['Config'].get('Labels') or {}
    labels=c['Config'].get('Labels') or {}
    if labels.get('com.docker.compose.project')!=COMPOSE_PROJECT or labels.get('com.docker.compose.service')!='panel-web':
        raise ValueError('Panel web container ownership mismatch')
    if not c['State']['Running'] or c['State'].get('Health', {}).get('Status')!='healthy':
        raise ValueError('Frontend not healthy')
    if il.get('org.opencontainers.image.revision')!=sha or il.get('org.opencontainers.image.source')!=SOURCE:
        raise ValueError('Frontend image revision/source mismatch')
    if set(c['NetworkSettings']['Networks']) != {NETWORK} or c['HostConfig'].get('PortBindings'):
        raise ValueError('Frontend network/public ports differ')
    web_probe(CONTAINER,sha)
    return {
        'services':[{'service':'web','container':CONTAINER,'revision':sha,
                     'imageId':c['Image'],'image':c['Config']['Image'],
                     'digests':image_info(c['Image']).get('RepoDigests') or [],'health':'healthy'}],
        'stagingVerified':True,'publicVerified':False
    }

def web_config(image,sha,origin=ORIGIN):
    if not SHA.fullmatch(sha):
        raise ValueError('Invalid revision')
    if origin != ORIGIN:
        raise ValueError('Origin must match the existing protected panel')
    return {'name':COMPOSE_PROJECT,
      'services':{'panel-web':{
        'image':image,'container_name':CONTAINER,'restart':'unless-stopped',
        'environment':{
          'PORT':'8081','PANEL_STATIC_DIR':'/app/public',
          'PANEL_EDGE_KEY_FILE':'/run/secrets/panel-edge-key',
          'PANEL_PUBLIC_ORIGIN':origin,'PANEL_WEB_REVISION':sha
        },
        'volumes':[SECRET+':/run/secrets/panel-edge-key:ro'],
        'networks':['proxy'],'read_only':True,
        'tmpfs':['/tmp:size=8m,mode=1777'],
        'mem_limit':'128m','cpus':0.5,'pids_limit':64,
        'security_opt':['no-new-privileges:true'],
        'cap_drop':['ALL'],'cap_add':['SETUID','SETGID'],
        'labels':{'org.opencontainers.image.revision':sha},
        'healthcheck':{'test':['CMD','node','-e',
          "fetch('http://127.0.0.1:8081/__panel_web_health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
          'interval':'30s','timeout':'5s','retries':3}
      }},
      'networks':{'proxy':{'external':True,'name':NETWORK}}
    }

def unrelated_ids():
    ids=run(['docker','ps','-aq'],text=True).split()
    return {c['Name'].lstrip('/'):c['Id'] for c in
            (json.loads(run(['docker','inspect',*ids])) if ids else [])
            if c['Name'].lstrip('/')!=CONTAINER}

def web_activate(project,sha,images,log):
    if project['adapter']!='web' or project['containers']!={'web':CONTAINER} or set(images)!={'web'}:
        raise ValueError('Invalid web project/service mapping')
    preflight()
    previous=optional_inspect(CONTAINER)
    previous_image=None
    previous_sha=None
    if previous:
        labels=previous['Config'].get('Labels') or {}
        if labels.get('com.docker.compose.project')!=COMPOSE_PROJECT or labels.get('com.docker.compose.service')!='panel-web':
            raise ValueError('Refusing to replace unowned frontend container')
        env=dict(item.split('=',1) for item in previous['Config'].get('Env',[]) if '=' in item)
        previous_sha=env.get('PANEL_WEB_REVISION')
        if not previous_sha or not SHA.fullmatch(previous_sha) or env.get('PANEL_PUBLIC_ORIGIN')!=ORIGIN:
            raise ValueError('Previous frontend cannot be rolled back safely')
        if not previous['State']['Running'] or previous['State'].get('Health',{}).get('Status')!='healthy':
            raise ValueError('Previous frontend must be healthy before replacement')
        previous_image=previous['Image']
        image_info(previous_image)
    root=Path(project['releases'])
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    release=root/sha
    release.mkdir(mode=0o700,exist_ok=True)
    config=release/'panel-web.json'
    atomic_json(config,web_config(images['web'],sha))
    command=['docker','compose','-p',COMPOSE_PROJECT,'-f',str(config)]
    # Check that the isolated Compose file includes exactly the authorized service and network.
    effective=json.loads(run(command+['config','--format','json'],log=log))
    if set(effective['services'])!={'panel-web'} or set(effective['networks'])!={'proxy'}:
        raise ValueError('Unexpected Compose services/network')
    candidate='panel-web-check-'+secrets.token_hex(8)
    run(['docker','run','-d','--name',candidate,'--network',NETWORK,
         '--read-only','--tmpfs','/tmp:size=8m,mode=1777',
         '--cap-drop','ALL','--cap-add','SETUID','--cap-add','SETGID',
         '--security-opt','no-new-privileges','--memory','128m','--cpus','0.5',
         '--pids-limit','64','--mount','type=bind,src='+SECRET+',dst=/run/secrets/panel-edge-key,readonly',
         '-e','PANEL_PUBLIC_ORIGIN='+ORIGIN,'-e','PANEL_WEB_REVISION='+sha,
         images['web']],log=log,timeout=45)
    try:
        web_probe(candidate,sha)
    finally:
        run(['docker','rm','-f',candidate],log=log,timeout=45)
    before=unrelated_ids()
    promoted=False
    try:
        promoted=True
        run(command+['up','-d','--no-deps','--no-build','--pull','never','panel-web'],log=log,timeout=120)
        wait_healthy([CONTAINER])
        result=verify_web(project,{'sha':sha})
        if unrelated_ids()!=before:
            raise RuntimeError('Unrelated container changed during frontend rollout')
        return dict(result,unrelatedServicesPreserved=True)
    except BaseException:
        if promoted:
            if previous_image:
                rollback=release/'panel-web.rollback.json'
                atomic_json(rollback,web_config(previous_image,previous_sha))
                old=['docker','compose','-p',COMPOSE_PROJECT,'-f',str(rollback)]
                run(old+['up','-d','--no-deps','--no-build','--pull','never','panel-web'],log=log,timeout=120)
                wait_healthy([CONTAINER])
                web_probe(CONTAINER,previous_sha)
            else:
                run(command+['stop','panel-web'],log=log,timeout=50)
                run(command+['rm','-f','panel-web'],log=log,timeout=50)
        raise
