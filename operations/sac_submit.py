"""SAC-008B: enqueue a constrained validation request for the dedicated One Worker.

Uses the existing root-owned SSH/OIDC broker. Never executes a command, Docker,
source, build or network request. Only authenticated Actions may call this.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import stat

ROOT = Path("/var/lib/sac-builder/state")
SLUG = re.compile(r"[a-z][a-z0-9-]{0,63}\Z")
SHA = re.compile(r"[0-9a-f]{40}\Z")
RUN = re.compile(r"[0-9]{1,15}\Z")
ATTEMPT = re.compile(r"[1-9][0-9]{0,3}\Z")
MAX_RECORD = 2048


def _identity(value):
    return type(value) is str and SLUG.fullmatch(value) is not None


def validate_args(policy, args):
    config = policy.get("sac_submit") or {}
    if not config.get("enabled", False):
        raise PermissionError("SAC submission is disabled")
    if config.get("state_dir") != str(ROOT):
        raise ValueError("Unexpected SAC state directory")
    if type(args) is not dict or set(args) != {"project_id", "profile_id", "source_sha"}:
        raise ValueError("Unsupported SAC submit fields")
    project, profile, sha = args["project_id"], args["profile_id"], args["source_sha"]
    if not _identity(project) or not _identity(profile) or type(sha) is not str or not SHA.fullmatch(sha):
        raise ValueError("Invalid SAC job identity")
    projects = config.get("projects")
    if type(projects) is not list or len(projects) > 128:
        raise ValueError("Invalid SAC allowlist")
    allowed = set()
    for item in projects:
        if (type(item) is not dict or set(item) != {"project_id", "profile_id"}
                or not _identity(item["project_id"]) or not _identity(item["profile_id"])):
            raise ValueError("Invalid project allowlist entry")
        pair = (item["project_id"], item["profile_id"])
        if pair in allowed:
            raise ValueError("Duplicate project profile")
        allowed.add(pair)
    if (project, profile) not in allowed:
        raise PermissionError("Project/profile is not registered")
    return project, profile, sha


def _run_attempt(claims, request_id):
    run_id = str(claims.get("run_id", ""))
    if not RUN.fullmatch(run_id):
        raise ValueError("Invalid OIDC run id")
    match = re.fullmatch(re.escape(run_id) + r"-([1-9][0-9]{0,3})-sac_submit-infrastructure", request_id)
    if match is None:
        raise ValueError("Request id is not bound to the Actions job")
    attempt = match.group(1)
    oidc_attempt = claims.get("run_attempt")
    if oidc_attempt is not None and str(oidc_attempt) != attempt:
        raise ValueError("OIDC run attempt mismatch")
    return f"gha-{run_id}-{attempt}"


def _safe_dir(path, expected_uid):
    if path.is_symlink():
        raise ValueError("SAC inbox is a symlink")
    s = path.stat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != expected_uid or s.st_mode & (stat.S_IWOTH | stat.S_IWGRP):
        raise ValueError("SAC inbox ownership/permissions invalid")
    return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)


def _existing(fd, filename, data, worker_uid):
    fl = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
    try:
        meta = os.fstat(fl)
        if (not stat.S_ISREG(meta.st_mode) or meta.st_uid != worker_uid
                or meta.st_nlink != 1 or meta.st_size > MAX_RECORD):
            raise ValueError("Unsafe existing SAC request")
        actual = os.read(fl, MAX_RECORD + 1)
        if actual != data:
            raise ValueError("Conflicting SAC request id")
    finally:
        os.close(fl)


def _publish(inbox, job_id, record, worker_uid):
    payload = (json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")
    if len(payload) > MAX_RECORD:
        raise ValueError("SAC request too large")
    dirfd = _safe_dir(inbox, worker_uid)
    name = job_id + ".json"
    tempname = ".sac-publish-" + secrets.token_hex(16)
    created = False
    try:
        fd = os.open(tempname, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=dirfd)
        created = True
        try:
            os.write(fd, payload)
            os.fchown(fd, worker_uid, -1)
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            os.link(tempname, name, src_dir_fd=dirfd, dst_dir_fd=dirfd, follow_symlinks=False)
        except FileExistsError:
            _existing(dirfd, name, payload, worker_uid)
        os.fsync(dirfd)
    finally:
        if created:
            os.unlink(tempname, dir_fd=dirfd)
        os.close(dirfd)


def submit_job(policy, args, claims, request_id, *, state_dir=None, worker_uid=None):
    project, profile, source_sha = validate_args(policy, args)
    job_id = _run_attempt(claims, request_id)
    uid = pwd.getpwnam("sac-builder").pw_uid if worker_uid is None else worker_uid
    state = ROOT if state_dir is None else Path(state_dir)
    if state.is_symlink() or not state.is_dir():
        raise ValueError("Builder state is not installed")
    state_stat = state.stat()
    if (state_stat.st_uid != uid or state_stat.st_mode & (stat.S_IWOTH | stat.S_IWGRP)):
        raise ValueError("Builder state ownership/permissions invalid")
    inbox = state / "sac-inbox"
    record = {
        "schema_version": 1, "job_id": job_id, "project_id": project,
        "profile_id": profile, "source_sha": source_sha, "kind": "angular-validate"
    }
    _publish(inbox, job_id, record, uid)
    return {"sacJob": {"jobId": job_id, "projectId": project, "profileId": profile,
                       "sourceSha": source_sha, "status": "queued",
                       "executed": False, "deploymentAuthorized": False}}
