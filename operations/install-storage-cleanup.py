#!/usr/bin/env python3
"""Install only the fixed housekeeping unit; never replace the deploy broker."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess

SOURCE = Path(__file__).resolve().parent
DATA = Path('/var/lib/docker/volumes/softload_panel_data/_data')
EXECUTABLE = Path('/usr/local/sbin/vps-storage-cleanup')
SYSTEMD = Path('/etc/systemd/system')

def install(expected_sha=None):
    if os.geteuid() != 0:
        raise PermissionError('Host administrator required')
    root=Path('/var/lib/vps-storage-cleanup')
    root.mkdir(mode=0o700,exist_ok=True)
    with (root/'cleanup.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        install_checked(expected_sha)


def install_checked(expected_sha):
    if os.geteuid() != 0:
        raise PermissionError('Host administrator required')
    source = SOURCE
    volume = json.loads(subprocess.check_output([
        'docker', 'volume', 'inspect', 'softload_panel_data'], text=True))[0]
    if Path(volume['Mountpoint']).resolve() != DATA or not DATA.is_dir():
        raise ValueError('Unexpected Panel data volume; no installation performed')
    files = {'storage_cleanup.py': EXECUTABLE}
    for suffix in ['service', 'timer', 'path']:
        name = 'vps-storage-cleanup.' + suffix
        files[name] = SYSTEMD / name
    for name, destination in files.items():
        if destination.is_symlink():
            raise ValueError('Refusing symlink installation')
        if destination.exists() and destination.read_bytes() != (source / name).read_bytes():
            if name != 'storage_cleanup.py' or expected_sha != hashlib.sha256(destination.read_bytes()).hexdigest():
                raise ValueError('Existing housekeeping installation requires checksum-reviewed update')
    for name, destination in files.items():
        temporary = destination.with_name('.' + destination.name + '.install-' + str(os.getpid()))
        data = (source / name).read_bytes()
        with temporary.open('xb') as output:
            output.write(data); output.flush(); os.fsync(output.fileno())
        temporary.chmod(0o755 if name.endswith('.py') else 0o644)
        os.replace(temporary, destination)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'enable', '--now', 'vps-storage-cleanup.timer',
                    'vps-storage-cleanup.path'], check=True)
    print(json.dumps({'installed': True, 'sha256': hashlib.sha256((source / 'storage_cleanup.py').read_bytes()).hexdigest()}))


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--expected-installed-sha256')
    install(parser.parse_args().expected_installed_sha256)
