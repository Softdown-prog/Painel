"""Explicit root bootstrap; preserves installed project adapters and permissions.

The previous installer replaced driver.py wholesale, dropping host-only shadow
support. Only insert a Codex dispatch into the existing authenticated driver.
Admission can be upgraded only when its AST matches the known prior or current
implementation. Unknown drift is a blocker, never permission to overwrite it.
"""
import ast
import copy
import fcntl
import json
import os
from pathlib import Path
import tempfile


def patch_driver(source):
    tree = ast.parse(source)
    deploy = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'deploy')
    imports = [n for n in ast.walk(deploy) if isinstance(n, ast.ImportFrom) and n.module == 'codex']
    if imports:
        if len(imports) != 1 or [n.name for n in imports[0].names] != ['codex_activate']:
            raise ValueError('Unknown existing Codex handler')
        return source
    anchors = [n for n in ast.walk(deploy) if isinstance(n, ast.Assign) and
               len(n.targets) == 1 and isinstance(n.targets[0], ast.Name) and
               n.targets[0].id == 'admission' and isinstance(n.value, ast.Call) and
               ast.unparse(n.value) == 'admit(project, sha, images)']
    if len(anchors) != 1:
        raise ValueError('Unique authenticated admission anchor missing')
    anchor = anchors[0]
    lines = source.splitlines(keepends=True)
    indent = ' ' * anchor.col_offset
    block = ["if project['adapter'] == 'codex':\n",
             '    from codex import codex_activate\n',
             '    return dict(codex_activate(project, sha, images, log), admission=admission)\n']
    lines[anchor.end_lineno:anchor.end_lineno] = [indent + line for line in block]
    result = ''.join(lines)
    ast.parse(result)
    return result


class WithoutCodex(ast.NodeTransformer):
    """Derive the supported legacy admission AST, not a broad migration."""
    def visit_If(self, node):
        if ast.unparse(node.test) == "profile == 'codex-bridge'" or ast.unparse(node.test) == "rule['profile'] == 'codex-bridge'":
            return [self.visit(n) for n in node.orelse]
        return self.generic_visit(node)

    def visit_Set(self, node):
        node.elts = [n for n in node.elts if not isinstance(n, ast.Constant) or n.value != 'codex-bridge']
        return self.generic_visit(node)

    def visit_Dict(self, node):
        pairs = [(k, v) for k, v in zip(node.keys, node.values)
                 if not isinstance(k, ast.Constant) or k.value != 'codex-bridge']
        node.keys, node.values = [k for k, _ in pairs], [v for _, v in pairs]
        return self.generic_visit(node)


def patch_admission(installed, reference):
    current, expected = ast.parse(installed), ast.parse(reference)
    legacy = WithoutCodex().visit(copy.deepcopy(expected))
    if ast.dump(current) not in (ast.dump(expected), ast.dump(legacy)):
        raise ValueError('Unknown admission changes; preserve host and request review')
    return installed if ast.dump(current) == ast.dump(expected) else reference


def plan(source, installed, policy):
    ident = '1433232532'
    repo = policy.get('repositories', {}).get(ident, {})
    if (repo.get('name') != 'Softdown-prog/Painel' or
            '189416996' not in policy.get('actor_ids', []) or
            not {'deploy', 'inventory', 'verify'}.issubset(repo.get('operations', [])) or
            'panel' not in repo.get('projects', []) or 'panel' not in policy.get('projects', {})):
        raise ValueError('Existing authenticated Panel identity missing')
    expected = json.loads((source / 'operations/policy.example.json').read_text())['projects']['panel-codex']
    new_policy = copy.deepcopy(policy)
    prior = new_policy.setdefault('projects', {}).get('panel-codex')
    if prior is not None and prior != expected:
        raise ValueError('Codex policy already exists with different scope')
    new_policy['projects']['panel-codex'] = expected
    target = new_policy['repositories'][ident]
    for field, value in [('workflows', 'stage-codex-bridge.yml'), ('projects', 'panel-codex')]:
        if value not in target.setdefault(field, []):
            target[field].append(value)
    return {
        installed / 'driver.py': patch_driver((installed / 'driver.py').read_text()).encode(),
        installed / 'admission.py': patch_admission((installed / 'admission.py').read_text(),
                                                   (source / 'operations/admission.py').read_text()).encode(),
        installed / 'codex.py': (source / 'operations/codex.py').read_bytes(),
    }, new_policy


def atomic(path, content, mode):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        os.fchmod(stream.fileno(), mode)
        stream.write(content); stream.flush(); os.fsync(stream.fileno())
        name = stream.name
    os.replace(name, path)


def install(source):
    if os.geteuid() != 0:
        raise ValueError('Root operator required')
    installed = Path('/usr/local/lib/vps-operations')
    policy_path = Path('/etc/vps-operations/policy.json')
    with Path('/var/lib/vps-operations/panel.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # The receiver holds this separate lock while installing Codex.
        with Path('/var/lib/vps-operations/panel-codex.lock').open('a') as codex_lock:
            fcntl.flock(codex_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            targets, policy = plan(source, installed, json.loads(policy_path.read_text()))
            targets[policy_path] = (json.dumps(policy, indent=2) + '\n').encode()
            for path, content in targets.items():
                if path.is_symlink() or (path.exists() and (path.stat().st_uid != 0 or path.stat().st_mode & 0o022)):
                    raise ValueError('Unsafe installed ownership or permissions')
                if path.suffix == '.py':
                    ast.parse(content)
            before = {path: (path.read_bytes(), path.stat().st_mode & 0o777) if path.exists() else None for path in targets}
            try:
                for path, content in targets.items():
                    atomic(path, content, 0o600 if path == policy_path else 0o644)
            except BaseException:
                for path, previous in before.items():
                    if previous is None:
                        path.unlink(missing_ok=True)
                    else:
                        atomic(path, *previous)
                raise


if __name__ == '__main__':
    import sys
    if len(sys.argv) != 2:
        raise SystemExit('Expected trusted source directory')
    install(Path(sys.argv[1]).resolve())
    print('Codex capability installed; other adapters preserved; no containers restarted.')
