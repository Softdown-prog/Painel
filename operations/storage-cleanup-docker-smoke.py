"""Only disposable GC fixtures on CI Docker, never production/global prune."""
import json
from pathlib import Path
import subprocess
import tempfile
import storage_cleanup as cleanup
from storage_cleanup import docker, inventory, plan, remove_target

name = 'vps-gc-disposable-fixture'
tags = ['vps-gc-fixture:current', 'vps-gc-fixture:old']
try:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory)
        cleanup.ROOT = path / 'cleanup-state'
        cleanup.ROOT.mkdir(mode=0o700)
        cleanup.DATA = path / 'panel-data'
        cleanup.DATA.mkdir()
        for index, tag in enumerate(tags):
            (path / 'Dockerfile').write_text(f'FROM busybox:1.37\nLABEL test.revision="{index}"\n')
            docker('build', '-t', tag, str(path))
        docker('create', '--name', name, '--network', 'none', tags[0], 'true')
        images = json.loads(docker('image', 'inspect', *tags).stdout)
        containers = json.loads(docker('inspect', name).stdout)
        old = images[1]['Id']
        _, targets = plan(images, containers, {old: 0}, 30000)
        assert len(targets) == 1 and targets[0]['id'] == old
        assert remove_target(targets[0])
        assert json.loads(docker('inspect', name).stdout)[0]['Image'] == images[0]['Id']
        print('Disposable Docker cleanup passed: old image removed; stopped container/current image preserved.')
finally:
    docker('rm', name, check=False)
    for tag in tags:
        docker('image', 'rm', '--no-prune', tag, check=False)
