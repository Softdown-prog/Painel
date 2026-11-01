#!/usr/bin/python3
"""Real Linux Docker test: isolated API/executor pass; broken candidate is rejected.

Uses ONLY images in a disposable CI registry, never production services or secrets.
"""
import json
import subprocess
import sys
from pathlib import Path
import admission


def image(service):
    return json.loads(subprocess.check_output(['docker', 'image', 'inspect',
                      '127.0.0.1:5000/admission/' + service + ':test']))[0]['RepoDigests'][0]


def main(sha):
    policy = {'repository': 'Softdown-prog/Painel', 'containers': {'api': 'never-activate-api', 'executor': 'never-activate-executor'},
              'images': {x: '127.0.0.1:5000/admission/' + x for x in ('api', 'executor')},
              'admission': {'version': 1, 'services': {'api': {'profile': 'panel-api'}, 'executor': {'profile': 'panel-executor'}}}}
    good = admission.admit(policy, sha, {x: image(x) for x in policy['images']})
    if good['status'] != 'passed':
        raise RuntimeError('Working candidates failed')
    policy.update(containers={'bad': 'never-activate-bad'}, images={'bad': '127.0.0.1:5000/admission/bad'},
                  admission={'version': 1, 'services': {'bad': {'profile': 'http-json', 'port': 8787,
                      'path': '/health', 'revisionField': 'revision'}}})
    try:
        admission.admit(policy, sha, {'bad': image('bad')})
    except admission.AdmissionRejected as error:
        bad = error.receipt
    else:
        raise RuntimeError('Broken candidate was accepted')
    if bad['status'] != 'rejected' or bad['productionChanged'] is not False:
        raise RuntimeError('Incorrect rejection receipt')
    leftovers = subprocess.check_output(['docker', 'ps', '-aq', '--filter', 'label=vps.admission.candidate=true']).strip()
    if leftovers:
        raise RuntimeError('Candidate cleanup failed')
    Path('admission-docker-result.json').write_text(json.dumps({'good': good, 'broken': bad}, indent=2))
    print('PASS: real Docker API/executor candidates; bad revision rejected; no host mounts, bridge, ports or leftovers')


if __name__ == '__main__':
    main(sys.argv[1])
