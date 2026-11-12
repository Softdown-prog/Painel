#!/usr/bin/env python3
"""GitHub-hosted client. Credentials only in environment/stdin; public result has no raw shell logs."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request


# Nomes estáveis e públicos: nunca publicar stderr bruto, chave ou endereço da VPS.
SSH_DIAGNOSTIC_HINTS = {
    'host_key_verification_failed': 'Verificar a chave pública genuína do host e VPS_KNOWN_HOSTS; manter StrictHostKeyChecking.',
    'invalid_private_key': 'Verificar o formato da chave privada em VPS_OPERATIONS_SSH_KEY.',
    'authentication_failed': 'Verificar a chave pública autorizada para vpsops e as permissões SSH.',
    'connection_refused': 'Verificar sshd, porta SSH e regras de firewall da VPS.',
    'connection_timed_out': 'Verificar rota de rede, firewall e disponibilidade da VPS.',
    'network_unreachable': 'Verificar conectividade da VPS e do runner.',
    'dns_resolution_failed': 'Verificar o nome do host configurado para o SSH.',
    'connection_closed': 'Verificar sshd, Fail2ban e limites de conexão na VPS.',
    'ssh_command_timeout': 'Verificar a disponibilidade do executor; confirmar o recibo antes de repetir operações.',
    'ssh_client_unavailable': 'Verificar disponibilidade do executável ssh no runner.',
    'invalid_executor_response': 'O comando remoto não devolveu recibo JSON válido; verificar o executor na VPS.',
    'unknown_transport_error': 'Inspecionar sshd, firewall, chave e conectividade na VPS, sem desabilitar a validação do host.',
    'missing_ssh_configuration': 'Configurar as credenciais SSH ausentes nos secrets do GitHub Actions.',
}


def ssh_failure_category(stderr, returncode):
    """Classificação por padrões; stderr é confidencial e jamais é retornado."""
    value = (stderr or '').lower()
    if any(word in value for word in ('remote host identification has changed',
                                       'host key verification failed',
                                       'no matching host key type found',
                                       'no hostkey alg')):
        return 'host_key_verification_failed'
    if any(word in value for word in ('load key ', 'error in libcrypto',
                                       'invalid format', 'bad permissions',
                                       'unprotected private key file')):
        return 'invalid_private_key'
    if any(word in value for word in ('permission denied (publickey',
                                       'too many authentication failures',
                                       'sign_and_send_pubkey: signing failed',
                                       'no more authentication methods to try')):
        return 'authentication_failed'
    if 'connection refused' in value:
        return 'connection_refused'
    if any(word in value for word in ('connection timed out', 'operation timed out',
                                       'connect timed out')):
        return 'connection_timed_out'
    if any(word in value for word in ('network is unreachable', 'no route to host')):
        return 'network_unreachable'
    if any(word in value for word in ('could not resolve hostname',
                                       'name or service not known',
                                       'temporary failure in name resolution')):
        return 'dns_resolution_failed'
    if any(word in value for word in ('connection closed', 'connection reset',
                                       'kex_exchange_identification')):
        return 'connection_closed'
    return 'unknown_transport_error' if returncode == 255 else 'invalid_executor_response'


def transport_error(category, returncode=None, attempts=1, missing=None):
    result = {'exitCode': 1, 'error': 'SSH transport failed; no valid executor result',
              'transportCategory': category, 'diagnosticHint': SSH_DIAGNOSTIC_HINTS[category],
              'attempts': attempts}
    if returncode is not None:
        result['transportExitCode'] = returncode
    if missing:
        result['missingSettings'] = missing
    return result

def execute_ssh(command, payload):
    encoded = json.dumps(payload)
    for attempt in range(2):
        try:
            process = subprocess.run(command, input=encoded, text=True, capture_output=True, timeout=1600)
        except subprocess.TimeoutExpired:
            return transport_error('ssh_command_timeout', attempts=attempt + 1)
        except OSError:
            return transport_error('ssh_client_unavailable', attempts=attempt + 1)
        try:
            result = json.loads(process.stdout)
            if isinstance(result, dict) and result.get('id') == payload['id'] and type(result.get('exitCode')) is int:
                return result
        except (ValueError, TypeError):
            pass
        category = ssh_failure_category(process.stderr, process.returncode)
        # Erros permanentes de chave/autenticação não melhoram com retry.
        permanent = {'host_key_verification_failed', 'invalid_private_key',
                     'authentication_failed', 'dns_resolution_failed'}
        if process.returncode == 255 and attempt == 0 and category not in permanent:
            # Reuse exactly the same request ID. Receiver handles duplicates
            # through its durable receipt; no second deployment identity.
            time.sleep(30)
            continue
        return transport_error(category, process.returncode, attempt + 1)

def main():
    missing = [name for name in ('VPS_SSH_KEY', 'VPS_KNOWN_HOSTS')
               if not os.environ.get(name, '').strip()]
    if missing:
        return publish_result(transport_error('missing_ssh_configuration', missing=missing))
    url = os.environ['ACTIONS_ID_TOKEN_REQUEST_URL'] + '&audience=' + urllib.parse.quote('vps-operations:164.163.9.7')
    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']})
    with urllib.request.urlopen(req, timeout=20) as response:
        oidc = json.load(response)['value']
    operation = os.environ.get('VPS_OPERATION', 'inventory')
    project = os.environ.get('VPS_PROJECT', 'infrastructure')
    request_id = os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT'] + '-' + operation + '-' + project
    if operation == 'code_mcp':
        requested = json.loads(os.environ.get('VPS_IMAGES', '{}'))
        args = {'action': os.environ['VPS_ACTION'],
                'image': requested.get('image',''),
                'sha': os.environ.get('GITHUB_SHA','') if os.environ['VPS_ACTION']=='install' else '',
                'confirm': os.environ.get('VPS_CONFIRM','')}
    elif operation == 'mcp_query':
        raw = os.environ.get('VPS_MCP_ARGS', '')
        if len(raw.encode('utf-8')) > 2500:
            raise ValueError('MCP request exceeds 2500 bytes')
        args = json.loads(raw)
        if not isinstance(args, dict):
            raise ValueError('MCP request must be a JSON object')
    elif operation == 'workspace':
        raw = os.environ.get('VPS_WORKSPACE_ARGS', '')
        if len(raw.encode('utf-8')) > 1024:
            raise ValueError('ChatGPT workspace request exceeds 1024 bytes')
        args = json.loads(raw)
        if not isinstance(args, dict):
            raise ValueError('ChatGPT workspace request must be a JSON object')
    elif operation == 'sac_worker':
        action = os.environ.get('VPS_SAC_ACTION', '')
        if action == 'job':
            args = {'action': action, 'job_id': os.environ.get('VPS_SAC_JOB_ID', '').strip()}
        else:
            args = {'action': action}
    elif operation == 'sac_submit':
        raw = os.environ.get('VPS_SAC_ARGS', '')
        if raw:
            if len(raw.encode('utf-8')) > 1024:
                raise ValueError('SAC request exceeds 1024 bytes')
            args = json.loads(raw)
        else:
            args = {
                'project_id': os.environ.get('VPS_SAC_PROJECT_ID', ''),
                'profile_id': os.environ.get('VPS_SAC_PROFILE_ID', ''),
                'source_sha': os.environ.get('VPS_SAC_SOURCE_SHA', '')
            }
    elif operation == 'maintain':
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
               'registry_token': os.environ.get('GITHUB_TOKEN') if operation in ('deploy','code_mcp') else None}
    with tempfile.TemporaryDirectory() as directory:
        key, hosts = Path(directory) / 'key', Path(directory) / 'known_hosts'
        key.write_text(os.environ['VPS_SSH_KEY'].strip() + '\n'); key.chmod(0o600)
        hosts.write_text(os.environ['VPS_KNOWN_HOSTS'].strip() + '\n'); hosts.chmod(0o600)
        command = ['ssh', '-T', '-i', str(key), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
                   '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(hosts),
                   '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
                   'vpsops@164.163.9.7', 'operations-v1']
        result = execute_ssh(command, payload)
    return publish_result(result)


def publish_result(result):
    """Persist and summarize only allowlisted results, never raw SSH output."""
    Path('vps-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a') as file:
            file.write('## Resultado real da VPS\n```json\n' + json.dumps(result, indent=2) + '\n```\n')
    return result.get('exitCode', 1)

if __name__ == '__main__':
    sys.exit(main())
