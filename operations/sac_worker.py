"""SAC-008: private read-only worker checkpoint queries via authenticated GitHub Actions.

This module never executes shell, docker, compilers, code or remote commands.
Only the root-owned broker reads the dedicated worker's pre-existing metadata.
"""
from __future__ import annotations
import json
from pathlib import Path
import re

RUN_ID = re.compile(r"[0-9]{1,15}-[0-9a-f]{16}\Z")
SIGNATURE = re.compile(r"[0-9a-f]{64}\Z")
SHA = re.compile(r"[0-9a-f]{40}\Z")
JOB_ID = re.compile(r"gha-[0-9]{1,15}-[1-9][0-9]{0,3}\Z")
RESULT_CODE = re.compile(r"[a-z][a-z0-9-]{0,63}\Z")
MAX_INPUT_BYTES = 32768
WORKER_STATE_ROOT = Path("/var/lib/data-library-worker/state")
SAC_BUILDER_STATE_ROOT = Path("/var/lib/sac-builder/state")


def validate_args(policy, args):
    settings = policy.get("sac_worker") or {}
    if not settings.get("enabled") or settings.get("output") != "summary-only":
        raise PermissionError("SAC query disabled")
    if not isinstance(args, dict):
        raise ValueError("Only fixed SAC query action accepted")
    if args.get("action") == "job":
        if (set(args) != {"action", "job_id"} or type(args.get("job_id")) is not str
                or JOB_ID.fullmatch(args["job_id"]) is None):
            raise ValueError("Invalid SAC job identity")
    elif set(args) != {"action"} or args["action"] not in ("status", "report"):
        raise ValueError("Unsupported SAC query action")
    # Installed policy is root-owned; refuse arbitrary paths even if it was misconfigured.
    if settings.get("state_dir") != str(WORKER_STATE_ROOT):
        raise ValueError("SAC query state path differs from catalog worker")
    if args["action"] == "job" and settings.get("job_state_dir") != str(SAC_BUILDER_STATE_ROOT):
        raise ValueError("SAC job state must use dedicated builder")
    return args["action"]


def read_json(path):
    if path.is_symlink() or not path.is_file():
        return None
    with path.open("rb") as handle:
        raw = handle.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError("Worker metadata too large")
    value = json.loads(raw)
    if type(value) is not dict:
        raise ValueError("Invalid worker metadata")
    return value


def _count(value):
    return value if type(value) is int and 0 <= value <= 1000000 else None


def _checkpoint(state):
    raw = read_json(state / "checkpoint.json")
    if raw is None:
        return None
    if (raw.get("schema_version") != 1
            or not isinstance(raw.get("run_id"), str)
            or not RUN_ID.fullmatch(raw["run_id"])
            or not isinstance(raw.get("signature"), str)
            or not SIGNATURE.fullmatch(raw["signature"])
            or not isinstance(raw.get("revision"), str)
            or not SHA.fullmatch(raw["revision"])):
        raise ValueError("Invalid worker checkpoint")
    finished = raw.get("finished_at")
    if finished is not None and (type(finished) not in (int, float) or not 0 <= finished <= 99999999999):
        raise ValueError("Invalid worker finish timestamp")
    return raw


def _counts(raw):
    if type(raw) is not dict or not {"pass", "fail", "compile-only"}.issubset(raw):
        return None
    values = {k: _count(raw.get(k)) for k in ("pass", "fail", "compile-only")}
    return values if all(v is not None for v in values.values()) else None


def _job_diagnostic(value, status):
    """Project only bounded structured evidence, never source text or host logs."""
    if type(value) is not dict or set(value) != {
            "schema_version", "status", "checks", "findings", "truncated",
            "location_verified", "deployment_authorized"}:
        raise ValueError("Invalid SAC diagnostic")
    if (type(value["schema_version"]) is not int or value["schema_version"] != 1
            or value["status"] != status or value["location_verified"] is not False
            or value["deployment_authorized"] is not False
            or type(value["truncated"]) is not bool):
        raise ValueError("Inconsistent SAC diagnostic")
    valid = ("pass", "fail", "unverified", "infra-error")
    checks = value["checks"]
    if (type(checks) is not dict or set(checks) != {"pre", "build", "post", "browser"}
            or any(type(v) is not str or v not in valid for v in checks.values())):
        raise ValueError("Invalid diagnostic checks")
    findings = value["findings"]
    if type(findings) is not list or len(findings) > 8:
        raise ValueError("Invalid diagnostic findings")
    safe = []
    for item in findings:
        if type(item) is not dict or set(item) != {
                "phase", "status", "code", "assertion", "title", "next_step"}:
            raise ValueError("Invalid diagnostic entry")
        if (item["phase"] not in checks or item["status"] not in valid
                or type(item["code"]) is not str
                or RESULT_CODE.fullmatch(item["code"]) is None):
            raise ValueError("Invalid diagnostic code")
        assertion = item["assertion"]
        if (assertion is not None and (type(assertion) is not str or
                re.fullmatch(r"[A-Za-z][A-Za-z0-9-]{0,63}", assertion) is None)):
            raise ValueError("Invalid diagnostic assertion")
        for field, limit in (("title", 95), ("next_step", 170)):
            content = item[field]
            if (type(content) is not str or not 4 <= len(content) <= limit or
                    any(c in content for c in ("\n", "\r", "\x00", "\\", "<", ">"))
                    or "://" in content):
                raise ValueError("Unsafe diagnostic text")
        safe.append({k: item[k] for k in (
            "phase", "status", "code", "assertion", "title", "next_step")})
    if len(json.dumps(value, ensure_ascii=True)) > 4096:
        raise ValueError("Diagnostic exceeds bounds")
    return {
        "schema_version": 1, "status": status, "checks": dict(checks),
        "findings": safe, "truncated": value["truncated"],
        "location_verified": False, "deployment_authorized": False
    }


def query_sac_worker(policy, args, *, state_dir=None):
    action = validate_args(policy, args)
    state = (SAC_BUILDER_STATE_ROOT if action == "job" else WORKER_STATE_ROOT) if state_dir is None else Path(state_dir)
    if state.is_symlink():
        raise ValueError("Symlink worker state forbidden")
    if action == "job":
        results = state / "sac-results"
        job_id = args["job_id"]
        if results.is_symlink():
            raise ValueError("SAC results is symlink")
        if not results.exists():
            return {"sacWorker": {"action": "job", "jobId": job_id, "status": "not-recorded", "readOnly": True}}
        result_path = results / (job_id + ".json")
        if result_path.is_symlink():
            raise ValueError("SAC job report is symlink")
        result = read_json(result_path)
        if result is None:
            return {"sacWorker": {"action": "job", "jobId": job_id, "status": "not-recorded", "readOnly": True}}
        if (result.get("schema_version") != 1 or result.get("job_id") != job_id
                or type(result.get("project_id")) is not str
                or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", result["project_id"])
                or type(result.get("profile_id")) is not str
                or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", result["profile_id"])
                or type(result.get("source_sha")) is not str
                or SHA.fullmatch(result["source_sha"]) is None
                or result.get("status") not in ("pass", "fail", "infra-error", "unverified")
                or type(result.get("static_pipeline_pass")) is not bool
                or type(result.get("browser_pass")) is not bool
                or result.get("deployment_authorized") is not False
                or result.get("execution") not in ("sac-audit", "sac-build-audit")
                or type(result.get("code")) is not str
                or RESULT_CODE.fullmatch(result["code"]) is None):
            raise ValueError("Invalid SAC job result")
        if (result["browser_pass"] and not result["static_pipeline_pass"]
                or result["status"] == "pass" and not (result["static_pipeline_pass"] and result["browser_pass"]
                                                     and result["code"] == ("isolated-build-browser-pass"
                            if result["execution"] == "sac-build-audit"
                            else "isolated-browser-pass"))):
            raise ValueError("False SAC success")
        view = {
            "action": "job", "jobId": job_id, "projectId": result["project_id"],
            "profileId": result["profile_id"], "sourceSha": result["source_sha"],
            "status": result["status"], "code": result["code"], "execution": result["execution"],
            "staticPipelinePass": result["static_pipeline_pass"],
            "browserPass": result["browser_pass"], "deploymentAuthorized": False, "readOnly": True,
        }
        if "diagnostic" in result:
            view["diagnostic"] = _job_diagnostic(result["diagnostic"], result["status"])
        return {"sacWorker": view}
    checkpoint = _checkpoint(state)
    if checkpoint is None:
        return {"sacWorker": {"available": False, "action": action, "code": "checkpoint-not-found",
                              "readOnly": True}}
    run_id = checkpoint["run_id"]
    current = {
        "available": True, "action": action, "readOnly": True,
        "runId": run_id, "sourceSha": checkpoint["revision"],
        "checkpointRecorded": True,
        # A checkpoint is not a health check: do not infer systemd is online.
        "serviceRunning": "unknown",
        "cycleFinished": checkpoint.get("finished_at") is not None,
    }
    if action == "status":
        if checkpoint.get("finished_at") is not None:
            counts = _counts(checkpoint.get("counts"))
            if counts is not None:
                current["counts"] = counts
        return {"sacWorker": current}
    if checkpoint.get("finished_at") is None:
        current["code"] = "cycle-not-finished"
        return {"sacWorker": current}
    # No caller path, run id or source text can choose a report location.
    runs = state / "runs"
    if runs.is_symlink() or (runs / run_id).is_symlink():
        raise ValueError("Worker report path is a symlink")
    summary = read_json(runs / run_id / "summary.json")
    if summary is None:
        current["code"] = "report-not-found"
        return {"sacWorker": current}
    counts = _counts(summary.get("counts"))
    if (summary.get("schema_version") != 1 or summary.get("source_sha") != checkpoint["revision"]
            or counts is None or _count(summary.get("total_queued")) is None
            or _count(summary.get("completed")) is None
            or summary["completed"] > summary["total_queued"]):
        raise ValueError("Invalid worker summary")
    current["summary"] = {
        "totalQueued": summary["total_queued"],
        "completed": summary["completed"],
        "counts": counts,
        "queueExhausted": summary.get("queue_exhausted") is True,
    }
    return {"sacWorker": current}
