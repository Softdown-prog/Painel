"""Fixed HTTP contracts; invoked in candidate network namespace only. No raw response logs."""
import http.client
import json
import sys


def test_contract(rule, sha, key):
    port = {'panel-api': 8080, 'panel-web': 8081}.get(rule['profile'], rule.get('port'))

    def call(path, method='GET', body=None, cookie=None, edge=True):
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
        headers = {'content-type': 'application/json'}
        if edge:
            headers['x-panel-edge-key'] = key
        if cookie:
            headers['cookie'] = cookie
        try:
            conn.request(method, path, None if body is None else json.dumps(body), headers)
            response = conn.getresponse()
            data = response.read(65537)
            if len(data) > 65536:
                raise ValueError('Response exceeds contract size')
            result = json.loads(data) if data else None
            return response.status, result, response.getheader('set-cookie')
        finally:
            conn.close()

    if rule['profile'] == 'panel-web':
        status, payload, _ = call('/__panel_web_health', edge=False)
        if status != 200 or payload.get('ok') is not True or payload.get('revision') != sha:
            raise ValueError('Frontend contract mismatch')
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
        try:
            conn.request('GET', '/angular/')
            response = conn.getresponse()
            if response.status != 200 or b'panel-app' not in response.read(65536):
                raise ValueError('Angular entry missing')
        finally:
            conn.close()
        return
    if rule['profile'] == 'http-json':
        status, payload, _ = call(rule['path'], edge=False)
        if status != 200 or not isinstance(payload, dict) or payload.get(rule['revisionField']) != sha:
            raise ValueError('HTTP revision contract mismatch')
        return
    status, auth, _ = call('/session')
    if status != 200 or auth.get('authenticated') is not False or auth.get('revision') != sha:
        raise ValueError('Session contract mismatch')
    if auth.get('setupRequired') is True:
        # Setup token is intentionally not copied from production. The isolated test
        # validates the pre-authentication contract; login is covered by existing Docker CI.
        pass
    elif auth.get('setupRequired') is not False:
        raise ValueError('Invalid setupRequired')
    if call('/containers')[0] != 401 or call('/services')[0] != 401:
        raise ValueError('Administrative data exposed without session')
    if call('/session', edge=False)[0] != 404:
        raise ValueError('Edge authentication bypass')


if __name__ == '__main__':
    try:
        data = json.loads(sys.stdin.buffer.read(4097))
        test_contract(data['rule'], data['sha'], data['key'])
    except Exception:
        sys.exit(1)
