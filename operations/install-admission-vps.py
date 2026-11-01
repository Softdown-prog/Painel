#!/usr/bin/python3
"""Upgrade the existing broker in place, retaining locally installed adapters/policies.

No SSH/privilege changes, Docker operation, production restart or credential read.
Keeps one small private copy of changed broker files for transactional rollback.
Run with the audited installed driver/receiver SHA256 values, never with guesses.
"""
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile


RULES = {
    'panel': {'api': {'profile': 'panel-api'}, 'executor': {'profile': 'panel-executor'}},
    'terrania': {'multiplayer': {'profile': 'http-json', 'port': 8787,
                                'path': '/health', 'revisionField': 'revision'}},
    'terrania-go-shadow': {'engine-go': {'profile': 'http-json', 'port': 8788,
                                      'path': '/health', 'revisionField': 'revision'}},
    'panel-web': {'web': {'profile': 'panel-web'}},
}


def patch_driver(source):
    if '# VPS_ADMISSION_V1' in source:
        raise ValueError('Admission already installed; review instead of patching twice')
    ast.parse(source)
    head, marker, body = source.partition('\ndef deploy(project, args, token, state):')
    if not marker or body.count('images = prepare_images(project, args, token, log)') != 1:
        raise ValueError('Unknown driver activation structure')
    # Reviewed legacy adapters (including shadow) are retained, not overwritten by main.
    before = '            images = prepare_images(project, args, token, log)'
    body = body.replace(before, '            contract(project)\n' + before +
                        '\n            admission = admit(project, sha, images)')
    lines = body.splitlines()
    returns = 0
    for index, line in enumerate(lines):
        if line.startswith('                return ') or line.startswith('            return '):
            indent = line[:len(line) - len(line.lstrip())]
            expression = line.strip()[7:]
            if not expression or expression.endswith(('(', ',')):
                raise ValueError('Unrecognized multi-line activation return')
            lines[index] = indent + 'return dict((' + expression + '), admission=admission)'
            returns += 1
    if not returns:
        raise ValueError('No activation result found')
    result = '# VPS_ADMISSION_V1\nfrom admission import admit, contract\n' + head + marker + '\n'.join(lines) + '\n'
    ast.parse(result)
    return result


def patch_receiver(source):
    anchor = "sys.path.insert(0, str(Path(__file__).resolve().parent))"
    error = "        result['error'] = type(error).__name__ + ': operation failed; inspect private host log'"
    if source.count(anchor) != 1 or source.count(error) != 1 or 'from admission import' in source:
        raise ValueError('Unrecognized receiver structure')
    source = source.replace(anchor, anchor + '\nfrom admission import AdmissionRejected')
    source = source.replace(error, error + "\n        if isinstance(error, AdmissionRejected):\n"
                            "            result['error'] = 'Versão rejeitada pelos testes de entrada; produção preservada.'\n"
                            "            result['admission'] = error.receipt")
    # A duplicate failed request must remain a failed workflow, not transport exit 0.
    duplicate = '        print(json.dumps(dict(previous, duplicate=True))); return'
    if source.count(duplicate) != 1:
        raise ValueError('Unrecognized idempotency structure')
    source = source.replace(duplicate, "        print(json.dumps(dict(previous, duplicate=True)))\n        sys.exit(previous['exitCode'])")
    ast.parse(source)
    return source


def install(src, expected_driver, expected_receiver):
    import fcntl
    if os.geteuid() != 0 or not all(re.fullmatch('[0-9a-f]{64}', v) for v in (expected_driver, expected_receiver)):
        raise ValueError('Root and previously audited SHA256 checksums required')
    directory = Path('/usr/local/lib/vps-operations')
    policy_path = Path('/etc/vps-operations/policy.json')
    original_policy = policy_path.read_bytes()
    policy = json.loads(original_policy)
    # Installer and EVERY project lock. Never modify a broker while a job is running.
    locks = []
    for name in ['.admission-install', *sorted(policy['projects']), 'infrastructure']:
        lock = open(Path('/var/lib/vps-operations') / (name + '.lock'), 'a')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        locks.append(lock)
    old_driver, old_receiver = (directory / 'driver.py').read_bytes(), (directory / 'receiver.py').read_bytes()
    if hashlib.sha256(old_driver).hexdigest() != expected_driver or hashlib.sha256(old_receiver).hexdigest() != expected_receiver:
        raise ValueError('Installed broker changed since audit; installation aborted')
    for name, project in policy['projects'].items():
        if name not in RULES or set(project['containers']) != set(RULES[name]) or set(project['images']) != set(RULES[name]):
            raise ValueError('Unreviewed project/services require a separate contract: ' + name)
        desired = {'version': 1, 'services': RULES[name]}
        if 'admission' in project and project['admission'] != desired:
            raise ValueError('Existing admission contract differs')
        project['admission'] = desired
    changes = {'driver.py': patch_driver(old_driver.decode()).encode(),
               'receiver.py': patch_receiver(old_receiver.decode()).encode()}
    for name in ('admission.py', 'admission_probe.py'):
        data = (src / name).read_bytes()
        ast.parse(data.decode())
        changes[name] = data
    backup = Path('/var/lib/vps-operations/admission-v1-before')
    backup.mkdir(mode=0o700)  # Existing backup means stop, never overwrite it.
    originals = {name: (directory / name).read_bytes() if (directory / name).exists() else None for name in changes}
    for name, data in originals.items():
        if data is not None:
            (backup / name).write_bytes(data); (backup / name).chmod(0o600)
    (backup / 'policy.json').write_bytes(original_policy); (backup / 'policy.json').chmod(0o600)
    try:
        with tempfile.TemporaryDirectory(dir=directory, prefix='.admission-') as temp:
            for name, data in changes.items():
                staged = Path(temp) / name
                staged.write_bytes(data); staged.chmod(0o644)
                os.replace(staged, directory / name)
        # Policy last: the mandatory gate rejects an unconfigured contract during transition.
        fd, path = tempfile.mkstemp(dir=policy_path.parent, prefix='.admission-')
        with os.fdopen(fd, 'w') as out:
            json.dump(policy, out, indent=2); out.flush(); os.fsync(out.fileno())
        os.replace(path, policy_path)
    except BaseException:
        for name, data in originals.items():
            if data is None:
                (directory / name).unlink(missing_ok=True)
            else:
                (directory / name).write_bytes(data); (directory / name).chmod(0o644)
        policy_path.write_bytes(original_policy); policy_path.chmod(0o600)
        raise
    print(json.dumps({'installed': True, 'contracts': sorted(policy['projects']),
                      'backupBytes': sum(p.stat().st_size for p in backup.iterdir()),
                      'backup': str(backup), 'containersRestarted': 0,
                      'files': {k: hashlib.sha256(v).hexdigest() for k, v in changes.items()}}))


if __name__ == '__main__':
    install(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
