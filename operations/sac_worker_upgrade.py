"""Read-only SAC broker upgrade planner; requires separate root operator approval.

Never called by the GitHub SSH broker or Actions. The installed root-owned
policy is the source of truth; this module must not make a denied request pass.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import sys
import tempfile

PANEL_ID = "1433232532"
ACTOR = "189416996"
WORKFLOW = "vps-command.yml"
OPERATION = "sac_worker"
WORKER_ROOT = "/var/lib/data-library-worker/state"
BUILDER_ROOT = "/var/lib/sac-builder/state"


def plan_policy(current, expected):
    """Return a conservative policy *copy*, enabling only sac_worker read access."""
    if type(current) is not dict or type(expected) is not dict:
        raise ValueError("invalid-policy")
    registered = current.get("repositories")
    if type(registered) is not dict or type(registered.get(PANEL_ID)) is not dict:
        raise ValueError("unrecognized-repository")
    repo = registered[PANEL_ID]
    if (repo.get("name") != "Softdown-prog/Painel"
            or type(repo.get("projects")) is not list
            or "infrastructure" not in repo["projects"]
            or type(repo.get("operations")) is not list
            or "inventory" not in repo["operations"]
            or type(repo.get("workflows")) is not list
            or WORKFLOW not in repo["workflows"]
            or current.get("actor_ids") != [ACTOR]):
        raise ValueError("existing-broker-policy-mismatch")
    if expected.get("actor_ids") != [ACTOR]:
        raise ValueError("unexpected-example-policy")
    reference = expected.get(OPERATION)
    if (type(reference) is not dict or reference.get("enabled") is not True
            or reference.get("actor_ids") != [ACTOR]
            or reference.get("output") != "summary-only"
            or reference.get("state_dir") != WORKER_ROOT
            or reference.get("job_state_dir") != BUILDER_ROOT
            or set(reference) != {"enabled", "actor_ids", "output",
                                  "state_dir", "job_state_dir"}):
        raise ValueError("unsupported-sac-policy")
    existing = current.get(OPERATION)
    if existing is not None and existing != reference:
        raise ValueError("sac-worker-policy-conflict")
    updated = copy.deepcopy(current)
    updated[OPERATION] = copy.deepcopy(reference)
    if OPERATION not in updated["repositories"][PANEL_ID]["operations"]:
        updated["repositories"][PANEL_ID]["operations"].append(OPERATION)
    return updated


def _safe_file(path, *, owner_uid, required=True):
    if path.is_symlink():
        raise ValueError("symlink-is-not-a-trusted-installation")
    if not path.exists():
        if required:
            raise ValueError("missing-installed-broker-file")
        return None
    data = path.stat()
    if not path.is_file() or data.st_uid != owner_uid or data.st_mode & 0o022:
        raise ValueError("unsafe-broker-file-ownership-or-mode")
    if data.st_size > 262144:
        raise ValueError("oversized-broker-file")
    return path.read_bytes()


def _write_atomic(path, data, mode):
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".sac-worker-upgrade-",
                                         dir=str(path.parent), delete=False) as out:
            tmp = Path(out.name)
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)


def upgrade(mode, source_dir, installed_dir, policy_file, *, owner_uid=0):
    """Check or install only two broker modules and a narrow policy extension.

    Preconditions apply to check AND apply. No SSH, sudoers, Docker, credentials,
    daemon restarts, source checkout, arbitrary commands or job submission.
    """
    if mode not in ("check", "apply"):
        raise ValueError("unsupported-mode")
    src = Path(source_dir)
    dst = Path(installed_dir)
    policy_path = Path(policy_file)
    if dst.is_symlink() or policy_path.parent.is_symlink():
        raise ValueError("untrusted-installation-dir")
    if not dst.is_dir() or not policy_path.parent.is_dir():
        raise ValueError("missing-installed-broker-dir")
    if dst.stat().st_uid != owner_uid or policy_path.parent.stat().st_uid != owner_uid:
        raise ValueError("broker-dir-owner-mismatch")
    expected = json.loads((src / "operations/policy.example.json").read_text("utf8"))
    before = _safe_file(policy_path, owner_uid=owner_uid)
    policy = json.loads(before)
    new_policy = plan_policy(policy, expected)
    modules = ("sac_worker.py", "receiver.py")
    replacement = {}
    old = {}
    for name in modules:
        target = dst / name
        old[name] = _safe_file(target, owner_uid=owner_uid,
                               required=(name == "receiver.py"))
        candidate = src / "operations" / name
        if candidate.is_symlink() or not candidate.is_file():
            raise ValueError("missing-trusted-source-code")
        replacement[name] = candidate.read_bytes()
        if not replacement[name] or len(replacement[name]) > 262144:
            raise ValueError("invalid-source-size")
    # The current installed broker must already be able to serve its allowed
    # operations; installing SAC does not repair/replace unrelated modules.
    required_modules = {"admission.py", "driver.py"}
    if "mcp_query" in policy["repositories"][PANEL_ID]["operations"]:
        required_modules.add("mcp_query.py")
    if "code_mcp" in policy["repositories"][PANEL_ID]["operations"]:
        required_modules.add("code_mcp.py")
    if "maintain" in policy["repositories"][PANEL_ID]["operations"]:
        required_modules.add("maintenance.py")
    # A previously registered but DISABLED submit operation is harmless:
    # its module can legitimately be absent on an older broker installation.
    # Only an enabled operation must already have its handler installed.
    if ("sac_submit" in policy["repositories"][PANEL_ID]["operations"]
            and (policy.get("sac_submit") or {}).get("enabled") is True):
        required_modules.add("sac_submit.py")
    for module in required_modules:
        _safe_file(dst / module, owner_uid=owner_uid)
    encoded = (json.dumps(new_policy, indent=2, ensure_ascii=True) + "\n").encode("utf8")
    needed = (new_policy != policy or
              any(old[name] != replacement[name] for name in modules))
    if mode == "check":
        return {"operation": OPERATION, "mode": "check", "safeToApply": True,
                "changesRequired": needed, "readOnly": True, "deployAuthorized": False}
    # Stage the handler BEFORE enabling its policy. Preserve other root policy
    # values verbatim; on an exception, roll back in memory (no retained backup).
    try:
        for name in modules:
            _write_atomic(dst / name, replacement[name], 0o644)
        _write_atomic(policy_path, encoded, 0o600)
    except BaseException:
        for name in modules:
            if old[name] is None:
                (dst / name).unlink(missing_ok=True)
            else:
                _write_atomic(dst / name, old[name], 0o644)
        _write_atomic(policy_path, before, 0o600)
        raise
    return {"operation": OPERATION, "mode": "apply", "installed": True,
            "changed": needed, "containersChanged": False,
            "shellAccess": False, "deploymentAuthorized": False}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 4 or sys.argv[1] not in ("check", "apply"):
            raise ValueError("invalid-arguments")
        if os.geteuid() != 0:
            raise ValueError("root-approval-required")
        result = upgrade(sys.argv[1], sys.argv[2],
                         "/usr/local/lib/vps-operations",
                         "/etc/vps-operations/policy.json")
        print(json.dumps(result))
    except (ValueError, OSError, KeyError, TypeError, json.JSONDecodeError):
        print("SAC Worker upgrade denied; inspect installed broker policy locally.",
              file=sys.stderr)
        sys.exit(2)
