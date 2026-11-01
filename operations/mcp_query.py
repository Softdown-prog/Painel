"""Read-only MCP code navigation through the authenticated vpsops broker.

Only fixed source-metadata tools may return results to a GitHub Issue.
Never return raw source code, snippets, MCP credentials or arbitrary stdout.
"""
import json
from pathlib import Path
import re
import urllib.request

MCP_URL = 'http://127.0.0.1:8789/mcp'
TOKEN_PATH = Path('/etc/vps-operations/code-mcp-token')
PROTOCOL = '2025-11-25'
ALLOWED = frozenset({
    'repo_list', 'repo_stats', 'repo_find_files', 'repo_find_symbols',
    'repo_search_text', 'repo_dependencies',
})
PATTERN = re.compile(r'^[\w./:@ -]{1,180}$', re.UNICODE)
PATH = re.compile(r'^[A-Za-z0-9_./@+-]{1,200}$')


def validate_args(policy, args):
    config = policy.get('mcp_query') or {}
    if not config.get('enabled', False):
        raise PermissionError('MCP query not enabled by root-owned policy')
    if not isinstance(args, dict) or set(args) - {'repo','tool','query','prefix','path','limit'}:
        raise ValueError('Unexpected MCP query arguments')
    tool = args.get('tool')
    repo = args.get('repo')
    if not isinstance(tool, str) or tool not in ALLOWED:
        raise ValueError('MCP tool not approved for GitHub bridge')
    if not isinstance(repo, str) or repo not in config.get('repos', []):
        raise ValueError('Repository not approved for MCP bridge')
    if tool == 'repo_list':
        if set(args) != {'repo','tool'}:
            raise ValueError('repo_list takes no search fields')
        return tool, {}
    if tool == 'repo_stats':
        if set(args) != {'repo','tool'}:
            raise ValueError('repo_stats takes no search fields')
        return tool, {'repo': repo}
    if tool == 'repo_dependencies':
        if set(args) != {'repo','tool','path'} or not isinstance(args['path'],str) or not PATH.fullmatch(args['path']) or '..' in args['path'].split('/'):
            raise ValueError('Invalid dependency path')
        return tool, {'repo': repo, 'path': args['path']}
    if not set(args).issubset({'repo','tool','query','prefix','limit'}):
        raise ValueError('Unexpected search arguments')
    query = args.get('query', '')
    if not isinstance(query,str) or len(query)>100 or (tool != 'repo_find_files' and not query):
        raise ValueError('Invalid search query')
    if query and (not PATTERN.fullmatch(query) or any(c in query for c in '\r\n\t')):
        raise ValueError('Invalid search characters')
    prefix = args.get('prefix', '')
    if not isinstance(prefix,str) or len(prefix)>150 or (prefix and (not PATH.fullmatch(prefix) or '..' in prefix.split('/'))):
        raise ValueError('Invalid search prefix')
    limit = args.get('limit', 10)
    if type(limit) is not int or not 1 <= limit <= 20:
        raise ValueError('Search limit must be 1-20')
    return tool, {'repo': repo, 'query': query, 'prefix': prefix, 'limit': limit}


def query_mcp(tool, arguments):
    token = TOKEN_PATH.read_text().strip()
    if not 32 <= len(token) <= 512:
        raise ValueError('MCP token is not available')
    headers = {'Authorization': 'Bearer ' + token,
               'Content-Type': 'application/json',
               'Accept': 'application/json, text/event-stream',
               'MCP-Protocol-Version': PROTOCOL,
               'User-Agent': 'VPS-Operations-MCPQuery/1.0'}
    payload = json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/call',
                          'params': {'name':tool,'arguments':arguments}}).encode()
    req = urllib.request.Request(MCP_URL, data=payload, headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=12) as response:
        if response.status != 200:
            raise RuntimeError('Local MCP rejected query')
        raw = response.read(32769)
    if len(raw)>32768:
        raise ValueError('MCP response exceeds limit')
    rpc = json.loads(raw)
    if not isinstance(rpc,dict) or rpc.get('id')!=1 or rpc.get('jsonrpc')!='2.0':
        raise ValueError('Untrusted MCP RPC response')
    result = rpc.get('result') or {}
    if not isinstance(result,dict) or result.get('isError') or not isinstance(result.get('content'),list):
        raise ValueError('MCP tool returned error')
    parts = result['content']
    if len(parts)!=1 or parts[0].get('type')!='text' or not isinstance(parts[0].get('text'),str):
        raise ValueError('Unexpected MCP content type')
    return json.loads(parts[0]['text'])


def safe_path(value):
    return value if isinstance(value,str) and len(value)<=200 and PATH.fullmatch(value) and '..' not in value.split('/') else None


def safe_result(tool, raw, repo, limit):
    """Explicitly project safe metadata: never copy raw response into public output."""
    if tool == 'repo_list':
        if not isinstance(raw,list):
            raise ValueError('Invalid repository list')
        return {'repositories':[s for s in raw[:50] if isinstance(s,str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,72}',s)]}
    if tool == 'repo_stats':
        if not isinstance(raw,dict):
            raise ValueError('Invalid MCP stats')
        return {'repo':repo,'fileCount':safe_count(raw.get('fileCount')),
                'symbolCount':safe_count(raw.get('symbolCount')), 'readOnly':raw.get('readOnly') is True}
    if tool in {'repo_find_files','repo_find_symbols'}:
        if not isinstance(raw,list):
            raise ValueError('Invalid MCP index output')
        entries = []
        for obj in raw[:limit]:
            if not isinstance(obj,dict) or not safe_path(obj.get('path')):
                continue
            entry = {'path':obj['path']}
            if tool == 'repo_find_files':
                entry.update(lines=safe_count(obj.get('lines')),bytes=safe_count(obj.get('bytes')),symbols=safe_count(obj.get('symbols')))
            else:
                name = obj.get('name')
                if not isinstance(name,str) or len(name)>120:
                    continue
                entry.update(name=name,line=safe_count(obj.get('line')))
            entries.append(entry)
        return {'repo':repo,'items':entries,'count':len(entries)}
    if tool == 'repo_search_text':
        if not isinstance(raw,dict) or not isinstance(raw.get('matches'),list):
            raise ValueError('Invalid MCP search output')
        # Deliberately OMIT previews, which can contain credentials or source text.
        matches = [{'path':v['path'],'line':safe_count(v.get('line'))}
                   for v in raw['matches'][:limit]
                   if isinstance(v,dict) and safe_path(v.get('path'))]
        return {'repo':repo,'matches':matches,'count':len(matches),
                'truncated':raw.get('truncated') is True}
    if tool == 'repo_dependencies':
        if not isinstance(raw,dict) or not safe_path(raw.get('path')):
            raise ValueError('Invalid MCP dependency output')
        incoming = raw.get('incoming') or []
        refs = raw.get('localReferences') or []
        if not isinstance(incoming,list) or not isinstance(refs,list):
            raise ValueError('Invalid MCP dependency relations')
        return {'repo':repo,'path':raw['path'],
                'incoming':[p for p in incoming[:20] if safe_path(p)],
                'localReferences':[v['target'] for v in refs[:20]
                                   if isinstance(v,dict) and safe_path(v.get('target'))]}
    raise ValueError('Unsupported MCP tool')


def safe_count(n):
    return n if type(n) is int and 0 <= n <= 100000000 else 0


def run_mcp_query(policy, args):
    tool, arguments = validate_args(policy, args)
    raw = query_mcp(tool, arguments)
    result = safe_result(tool, raw, args['repo'], arguments.get('limit', 10))
    # The caller is a public GitHub issue: reject oversized results rather than leaking data.
    if len(json.dumps(result))>12000:
        raise ValueError('Sanitized MCP result too large')
    return {'tool':tool, 'mcpQuery':result, 'readOnly':True}
