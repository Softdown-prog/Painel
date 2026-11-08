#!/usr/bin/env python3
"""Install only the fixed housekeeping unit; never replace the deploy broker."""
import hashlib
import json
import os
from pathlib import Path
import subprocess


def install():
    if os.geteuid() != 0:
        raise PermissionError('Host administrator required')
    source = Path(__file__).resolve().parent
    volume = json.loads(subprocess.check_output([
        'docker', 'volume', 'inspect', 'softload_panel_data'], text=True))[0]
    expected = Path('/var/lib/docker/volumes/softload_panel_data/_data')
    if Path(volume['Mountpoint']).resolve() != expected or not expected.is_dir():
        raise ValueError('Unexpected Panel data volume; no installation performed')
    files = {'storage_cleanup.py': Path('/usr/local/sbin/vps-storage-cleanup')}
    for suffix in ['service', 'timer', 'path']:
        name = 'vps-storage-cleanup.' + suffix
        files[name] = Path('/etc/systemd/system') / name
    for name, destination in files.items():
        if destination.is_symlink() or (destination.exists() and destination.read_bytes() != (source / name).read_bytes()):
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
    install()
