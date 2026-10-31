#!/usr/bin/env python3
"""GitHub-hosted client. Credentials only in environment/stdin; public result has no raw shell logs."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

def main():
    url = os.environ['ACTIONS_ID_TOKEN_REQUEST_URL'] + '&audience=' + urllib.parse.quote('vps-operations:164.163.9.7')
    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']})
    with urllib.request.urlopen(req, timeout=20) as response:
        oidc = json.load(response)['value']
    operation = os.environ.get('VPS_OPERATION', 'inventory')
    project = os.environ.get('VPS_PROJECT', 'infrastructure')
    request_id = os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT'] + '-' + operation + '-' + project
    if operation == 'maintain':
        args = {
            'action': os.environ['VPS_ACTION'],
            'target': os.environ['VPS_TARGET'],
            'confirm': os.environ.get('VPS_CONFIRM', '')
        }
    else:
        args = {'sha': os.environ.get('VPS_SHA') or os.environ['GITHUB_SHA'],
                'images': json.loads(os.environ.get('VPS_IMAGES', '{}'))}
    payload = {'id': request_id, 'operation': operation, 'project': project, 'oidc': oidc,
               'args': args,
               'registry_token': os.environ.get('GITHUB_TOKEN') if operation == 'deploy' else None}
    with tempfile.TemporaryDirectory() as directory:
        key, hosts = Path(directory) / 'key', Path(directory) / 'known_hosts'
        key.write_text(os.environ['VPS_SSH_KEY'].strip() + '\n'); key.chmod(0o600)
        hosts.write_text(os.environ['VPS_KNOWN_HOSTS'].strip() + '\n'); hosts.chmod(0o600)
        command = ['ssh', '-T', '-i', str(key), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
                   '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(hosts),
                   '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
                   'vpsops@164.163.9.7', 'operations-v1']
        process = subprocess.run(command, input=json.dumps(payload), text=True, capture_output=True, timeout=1600)
    try:
        result = json.loads(process.stdout)
    except (ValueError, TypeError):
        result = {'exitCode': 1, 'error': 'SSH transport failed; no valid executor result', 'transportExitCode': process.returncode}
    # No raw SSH stderr or runner environment is published (may contain sensitive transport details).
    Path('vps-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a') as file:
            file.write('## Resultado real da VPS\n```json\n' + json.dumps(result, indent=2) + '\n```\n')
    return process.returncode or result.get('exitCode', 1)

if __name__ == '__main__':
    sys.exit(main())
