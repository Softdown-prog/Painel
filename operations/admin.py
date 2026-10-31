"""Full root administration via the EXISTING forced-command vpsops broker.
Only a signed, registered GitHub admin workflow may request this operation.
Raw output stays on the host unless explicitly marked publish_output.
"""
import hashlib
import os
from pathlib import Path
import resource
import signal
import subprocess

MAX_COMMAND_BYTES = 8192
MAX_LOG_BYTES = 1024 * 1024
MAX_SECONDS = 240

def validate_admin_args(args):
    if not isinstance(args, dict) or set(args) != {'command', 'publish_output'}:
        raise ValueError('Admin request must contain only command and publish_output')
    command, output = args['command'], args['publish_output']
    if not isinstance(command, str) or not command.strip() or len(command.encode('utf-8')) > MAX_COMMAND_BYTES or '\x00' in command:
        raise ValueError('Invalid admin command or command too long')
    if not isinstance(output, bool):
        raise ValueError('publish_output must be a boolean')
    return command, output

def limit_output():
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_LOG_BYTES, MAX_LOG_BYTES))

def execute_admin(args, state, request_id):
    command, publish_output = validate_admin_args(args)
    path = Path(state) / ('admin-' + request_id + '.log')
    env = {
        'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'HOME': '/root', 'USER': 'root', 'LOGNAME': 'root', 'LANG': 'C.UTF-8'
    }
    # The receiver already runs as root. Keep SSH forced-command and vpsops sudoers intact.
    # No command is executed by GitHub runner; only the private root-owned receiver.
    with path.open('xb') as log:
        os.chmod(path, 0o600)
        process = subprocess.Popen(
            ['/bin/bash', '-e', '-o', 'pipefail', '-c', command],
            cwd='/', env=env, stdin=subprocess.DEVNULL, stdout=log,
            stderr=subprocess.STDOUT, start_new_session=True, preexec_fn=limit_output
        )
        timed_out = False
        try:
            code = process.wait(timeout=MAX_SECONDS)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            code = 124
    data = path.read_bytes()
    result = {
        'commandExitCode': code, 'timedOut': timed_out,
        'commandSha256': hashlib.sha256(command.encode()).hexdigest(),
        'outputBytes': len(data), 'outputSha256': hashlib.sha256(data).hexdigest(),
        'outputStoredPrivately': True,
    }
    # Do not accidentally publish passwords, .env contents or session tokens in a public GitHub run/issue.
    if publish_output:
        result['outputExcerpt'] = data[-4096:].decode('utf-8', errors='replace')
        result['outputMayContainSecrets'] = True
    return result
