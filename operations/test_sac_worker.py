"""SAC-008: read-only GitHub Actions -> vpsops -> worker checkpoint queries."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import receiver
import sac_worker

POLICY = json.loads((Path(__file__).parent / "policy.example.json").read_text())


class SacWorkerQueryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.sha = "a" * 40
        self.run_id = "1234-" + "b" * 16

    def _checkpoint(self, finished=True):
        (self.state / "checkpoint.json").write_text(json.dumps({
            "schema_version": 1, "signature": "c" * 64, "revision": self.sha,
            "run_id": self.run_id, "started_at": 100, "finished_at": 200 if finished else None,
            "counts": {"pass": 1, "fail": 0, "compile-only": 1}
        }))

    def _summary(self):
        folder = self.state / "runs" / self.run_id
        folder.mkdir(parents=True)
        (folder / "summary.json").write_text(json.dumps({
            "schema_version": 1, "source_sha": self.sha, "total_queued": 2, "completed": 2,
            "queue_exhausted": True, "counts": {"pass": 1, "fail": 0, "compile-only": 1},
            "private": "MUST_NOT_LEAK"
        }))

    def _query(self, action):
        return sac_worker.query_sac_worker(POLICY, {"action": action}, state_dir=self.state)["sacWorker"]

    def test_absent_checkpoint_is_not_reported_online(self):
        self.assertFalse(self._query("status")["available"])
        self.assertEqual(self._query("report")["code"], "checkpoint-not-found")

    def test_status_has_only_safe_checkpoint_metadata(self):
        self._checkpoint()
        out = self._query("status")
        self.assertTrue(out["cycleFinished"])
        self.assertEqual(out["serviceRunning"], "unknown")
        self.assertEqual(out["counts"]["compile-only"], 1)
        self.assertNotIn("private", json.dumps(out))

    def test_report_returns_bounded_summary_not_raw_files(self):
        self._checkpoint()
        self._summary()
        out = self._query("report")
        self.assertEqual(out["summary"]["totalQueued"], 2)
        self.assertNotIn("MUST_NOT_LEAK", json.dumps(out))
        self.assertNotIn("private", json.dumps(out))

    def test_incomplete_cycle_never_returns_old_report(self):
        self._checkpoint(finished=False)
        self._summary()
        self.assertEqual(self._query("report")["code"], "cycle-not-finished")

    def test_rejects_unapproved_actions_fields_and_paths(self):
        for args in ({"action": "shell"}, {"action": "run"}, {"action": "report", "path": "/etc/passwd"},
                     {"action": "report", "command": "id"}, {"action": "report", "project": "Terrania"}):
            with self.subTest(args=args), self.assertRaises(ValueError):
                sac_worker.validate_args(POLICY, args)
        policy = copy.deepcopy(POLICY)
        policy["sac_worker"]["state_dir"] = "/tmp/escape"
        with self.assertRaises(ValueError):
            sac_worker.validate_args(policy, {"action": "status"})

    def test_readonly_paths_reject_symlink_and_invalid_runs(self):
        self._checkpoint()
        with (self.state / "checkpoint.json").open("w") as stream:
            stream.write(json.dumps({"schema_version": 1, "run_id": "../../etc",
                                     "signature": "c" * 64, "revision": self.sha}))
        with self.assertRaises(ValueError):
            self._query("report")
        (self.state / "checkpoint.json").unlink()
        (self.state / "checkpoint.json").symlink_to("/etc/passwd")
        self.assertFalse(self._query("report")["available"])

    def test_summary_must_match_worker_revision(self):
        self._checkpoint()
        self._summary()
        p = self.state / "runs" / self.run_id / "summary.json"
        s = json.loads(p.read_text())
        s["source_sha"] = "f" * 40
        p.write_text(json.dumps(s))
        with self.assertRaises(ValueError):
            self._query("report")

    def test_catalog_and_job_query_paths_are_separated(self):
        self.assertEqual(str(sac_worker.WORKER_STATE_ROOT), "/var/lib/data-library-worker/state")
        self.assertEqual(str(sac_worker.SAC_BUILDER_STATE_ROOT), "/var/lib/sac-builder/state")
        self.assertEqual(POLICY["sac_worker"]["job_state_dir"], str(sac_worker.SAC_BUILDER_STATE_ROOT))
        bad = copy.deepcopy(POLICY)
        bad["sac_worker"]["job_state_dir"] = str(sac_worker.WORKER_STATE_ROOT)
        with self.assertRaises(ValueError):
            sac_worker.validate_args(bad, {"action": "job", "job_id": "gha-222-1"})

    def test_job_query_returns_only_safe_summary(self):
        jobs = self.state / "sac-results"
        jobs.mkdir()
        job_id = "gha-222-1"
        report = {"schema_version": 1, "job_id": job_id, "project_id": "demo-app",
                  "profile_id": "angular-root", "source_sha": "a" * 40, "status": "pass",
                  "static_pipeline_pass": True, "browser_pass": True,
                  "deployment_authorized": False, "execution": "sac-audit",
                  "code": "isolated-browser-pass", "secret": "must-not-leak"}
        (jobs / (job_id + ".json")).write_text(json.dumps(report))
        result = sac_worker.query_sac_worker(POLICY, {"action": "job", "job_id": job_id},
                                             state_dir=self.state)["sacWorker"]
        self.assertEqual(result["status"], "pass")
        self.assertTrue(result["browserPass"])
        self.assertNotIn("must-not-leak", json.dumps(result))
        self.assertFalse(result["deploymentAuthorized"])

    def test_job_report_not_ready_and_bad_ids_fail_closed(self):
        job = {"action": "job", "job_id": "gha-222-1"}
        self.assertEqual(sac_worker.query_sac_worker(POLICY, job,
                          state_dir=self.state)["sacWorker"]["status"], "not-recorded")
        for val in ("../etc", "gha-0-0", "gha-222-1.json", " gha-222-1"):
            with self.assertRaises(ValueError):
                sac_worker.validate_args(POLICY, {"action": "job", "job_id": val})
        (self.state / "sac-results").symlink_to("/etc")
        with self.assertRaises(ValueError):
            sac_worker.query_sac_worker(POLICY, job, state_dir=self.state)

    def test_forged_job_result_cannot_claim_pass(self):
        jobs = self.state / "sac-results"
        jobs.mkdir()
        job_id = "gha-222-1"
        p = jobs / (job_id + ".json")
        p.write_text(json.dumps({"schema_version": 1, "job_id": job_id, "project_id": "demo",
            "profile_id": "root", "source_sha": "b" * 40, "status": "pass",
            "static_pipeline_pass": True, "browser_pass": False,
            "deployment_authorized": False, "execution": "sac-audit", "code": "isolated-browser-pass"}))
        with self.assertRaises(ValueError):
            sac_worker.query_sac_worker(POLICY, {"action": "job", "job_id": job_id}, state_dir=self.state)

    def test_build_and_audit_pass_requires_distinct_code(self):
        directory = self.state / "sac-results"
        directory.mkdir()
        job = "gha-777-2"
        proof = {"schema_version": 1, "job_id": job, "project_id": "demo-app",
            "profile_id": "angular-root", "source_sha": "a" * 40, "status": "pass",
            "static_pipeline_pass": True, "browser_pass": True,
            "deployment_authorized": False, "execution": "sac-build-audit",
            "code": "isolated-build-browser-pass"}
        file = directory / (job + ".json")
        file.write_text(json.dumps(proof))
        result = sac_worker.query_sac_worker(POLICY, {"action": "job", "job_id": job},
                                             state_dir=self.state)["sacWorker"]
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["execution"], "sac-build-audit")
        self.assertFalse(result["deploymentAuthorized"])
        file.write_text(json.dumps({**proof, "code": "isolated-browser-pass"}))
        with self.assertRaises(ValueError):
            sac_worker.query_sac_worker(POLICY, {"action": "job", "job_id": job},
                                         state_dir=self.state)

    def test_job_query_exposes_actionable_diagnostic_only(self):
        results = self.state / "sac-results"
        results.mkdir()
        job = "gha-222-1"
        diagnostic = {
            "schema_version": 1, "status": "fail",
            "checks": {"pre": "pass", "build": "pass", "post": "pass", "browser": "fail"},
            "findings": [{"phase": "browser", "status": "fail",
                "code": "required-assertion-failed", "assertion": "inventory-panel",
                "title": "Elemento ou ação não comprovada",
                "next_step": "Confira seletor, evento e visibilidade no cenário."}],
            "truncated": False, "location_verified": False,
            "deployment_authorized": False
        }
        record = {"schema_version": 1, "job_id": job, "project_id": "demo",
                  "profile_id": "angular-root", "source_sha": "a" * 40,
                  "status": "fail", "static_pipeline_pass": True,
                  "browser_pass": False, "deployment_authorized": False,
                  "execution": "sac-build-audit", "code": "audit-not-verified",
                  "diagnostic": diagnostic, "secret": "never-return"}
        filename = results / (job + ".json")
        filename.write_text(json.dumps(record))
        actual = sac_worker.query_sac_worker(POLICY,
                       {"action": "job", "job_id": job}, state_dir=self.state)["sacWorker"]
        self.assertEqual(actual["diagnostic"]["findings"][0]["assertion"], "inventory-panel")
        self.assertEqual(actual["diagnostic"]["checks"]["browser"], "fail")
        self.assertNotIn("never-return", json.dumps(actual))
        self.assertFalse(actual["deploymentAuthorized"])
        for wrong in (
            {**diagnostic, "status": "pass"},
            {**diagnostic, "workspace_path": "/etc/passwd"},
            {**diagnostic, "findings": [{**diagnostic["findings"][0],
                "next_step": "Read https://secret.example"}]},
        ):
            filename.write_text(json.dumps({**record, "diagnostic": wrong}))
            with self.assertRaises(ValueError):
                sac_worker.query_sac_worker(POLICY,
                    {"action": "job", "job_id": job}, state_dir=self.state)

    def test_oidc_only_main_approved_actor_and_workflow(self):
        c = {"iss": receiver.ISSUER, "aud": receiver.AUDIENCE, "iat": 1000,
             "nbf": 999, "exp": 1200, "actor_id": "189416996",
             "repository_id": "1433232532", "repository": "Softdown-prog/Painel",
             "ref": "refs/heads/main", "event_name": "issues",
             "workflow_ref": "Softdown-prog/Painel/.github/workflows/vps-command.yml@refs/heads/main",
             "sha": "a" * 40, "run_id": "54321"}
        self.assertEqual(receiver.validate_claims(c, POLICY, "infrastructure", "sac_worker", now=1100)["name"], "Softdown-prog/Painel")
        for mutation in ({"actor_id": "000"}, {"event_name": "pull_request"},
                         {"workflow_ref": "Softdown-prog/Painel/.github/workflows/deploy-vps.yml@refs/heads/main"},
                         {"ref": "refs/heads/feature"}):
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                receiver.validate_claims({**c, **mutation}, POLICY, "infrastructure", "sac_worker", now=1100)
        off = copy.deepcopy(POLICY)
        off["sac_worker"]["enabled"] = False
        with self.assertRaises(ValueError):
            receiver.validate_claims(c, off, "infrastructure", "sac_worker", now=1100)


if __name__ == "__main__":
    unittest.main()
