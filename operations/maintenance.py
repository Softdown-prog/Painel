"""Explicitly scoped VPS maintenance for the existing root-owned vpsops broker.

No arbitrary commands, shell, arbitrary paths, env dumping, prune or unlink.
"""
import fcntl
import os
from pathlib import Path
import shutil
import subprocess
import time

from driver import inspect, image_info

ACTIONS = frozenset({'host_summary', 'container_status', 'restart_container'})
TARGETS = frozenset({'panel-api','panel-executor','panel-web','terrania-multiplayer'})

def check_args(args):
    if not isinstance(args, dict) or set(args) != {'action','target','confirm'}:
        raise ValueError('Only action, target and confirm are supported')
    action, target, confirm = args['action'], args['target'], args['confirm']
    if action not in ACTIONS or not isinstance(target,str) or not isinstance(confirm,str):
        raise ValueError('Unrecognized maintenance request')
    if action == 'host_summary':
        if target != 'host' or confirm:
            raise ValueError('Host report must not have a service target/confirmation')
    elif target not in TARGETS:
        raise ValueError('Service target not allowed')
    if action == 'restart_container':
        if confirm != 'RESTART:' + target:
            raise ValueError('Explicit exact restart confirmation required')
    elif confirm:
        raise ValueError('Confirmation only accepted for restart')
    return action,target

def host_summary():
    total,used,free = shutil.disk_usage('/')
    mem = {}
    with open('/proc/meminfo',encoding='ascii') as source:
        for line in source:
            key, sep, value = line.partition(':')
            if sep and key in ('MemTotal','MemAvailable','SwapTotal','SwapFree'):
                mem[key] = int(value.strip().split()[0])*1024
    return {'disk':{'totalBytes':total,'usedBytes':used,'freeBytes':free},
            'memoryBytes':mem,'loadAverage1m':round(os.getloadavg()[0],2)}

def validate_target(policy, target):
    registry=(policy.get('maintenance') or {}).get('targets') or {}
    config=registry.get(target)
    if not isinstance(config,dict) or set(config)!={'project','service','compose_project','compose_service'}:
        raise ValueError('Unregistered maintenance target')
    project=policy.get('projects',{}).get(config['project'],{})
    container=project.get('containers',{}).get(config['service'])
    if not isinstance(container,str) or not container:
        raise ValueError('Target has no registered project container')
    return config,container

def container_status(policy,target):
    mapping,name=validate_target(policy,target)
    c=inspect(name)
    labels=c['Config'].get('Labels') or {}
    if labels.get('com.docker.compose.project') != mapping['compose_project'] or labels.get('com.docker.compose.service') != mapping['compose_service']:
        raise ValueError('Installed container ownership does not match policy')
    image=image_info(c['Image'])
    revision=(image['Config'].get('Labels') or {}).get('org.opencontainers.image.revision')
    return {'target':target,'container':name,'status':c['State']['Status'],
            'health':c['State'].get('Health',{}).get('Status'),
            'revision':revision,'imageId':c['Image'],
            'memoryLimitBytes':c['HostConfig']['Memory'],
            'nanoCpus':c['HostConfig']['NanoCpus']}

def run_maintenance(policy,args,state):
    action,target=check_args(args)
    if action=='host_summary':
        return {'action':action,'host':host_summary(),'changed':False}
    current=container_status(policy,target)
    if action=='container_status':
        return {'action':action,'service':current,'changed':False}
    project=policy['maintenance']['targets'][target]['project']
    # Existing receiver holds infrastructure.lock. Serialize with project deployment lock.
    root=Path(state)
    with (root/(project+'.lock')).open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        before=container_status(policy,target)
        if before['status'] not in ('running','exited'):
            raise ValueError('Container is not in a restartable state')
        name=before['container']
        subprocess.check_output(['docker','restart','--time','20',name],stderr=subprocess.STDOUT,timeout=75)
        deadline=time.monotonic()+110
        while time.monotonic()<deadline:
            after=container_status(policy,target)
            if after['status']=='running' and after['health'] in ('healthy',None):
                if after['imageId']!=before['imageId'] or after['revision']!=before['revision']:
                    raise RuntimeError('Container image/revision changed unexpectedly')
                return {'action':action,'before':before,'after':after,'changed':True}
            time.sleep(3)
        raise RuntimeError('Container failed post-restart health verification')
