"""SAC-008B Actions -> SSH broker -> One Worker durable queue contract."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import receiver
import sac_submit

POLICY = json.loads((Path(__file__).parent / "policy.example.json").read_text())


class SacSubmitTests(unittest.TestCase):
    def setUp(self):
        self.policy = copy.deepcopy(POLICY)
        self.policy["sac_submit"]["enabled"] = True
        self.policy["sac_submit"]["projects"] = [{"project_id": "demo-a", "profile_id": "angular-root"},
                                                {"project_id": "demo-b", "profile_id": "angular-subpath"}]
        self.args = {"project_id": "demo-a", "profile_id": "angular-root", "source_sha": "a" * 40}
        self.claims = {"run_id": "777", "run_attempt": "1"}
        self.request_id = "777-1-sac_submit-infrastructure"
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        (self.state / "sac-inbox").mkdir()

    def submit(self, **kwargs):
        return sac_submit.submit_job(self.policy, kwargs.get("args", self.args),
                                     kwargs.get("claims", self.claims),
                                     kwargs.get("request_id", self.request_id),
                                     state_dir=self.state, worker_uid=os.getuid())

    def test_write_once_and_receipt_does_not_claim_compilation(self):
        output = self.submit()["sacJob"]
        self.assertEqual(output["status"], "queued")
        self.assertFalse(output["executed"])
        self.assertFalse(output["deploymentAuthorized"])
        saved = json.loads((self.state / "sac-inbox" / (output["jobId"] + ".json")).read_text())
        self.assertEqual(saved["kind"], "angular-validate")
        self.assertEqual(saved["source_sha"], self.args["source_sha"])
        self.assertEqual(self.submit()["sacJob"]["jobId"], output["jobId"])

    def test_dedup_id_cannot_replace_sha(self):
        self.submit()
        with self.assertRaises(ValueError):
            self.submit(args={**self.args, "source_sha": "b" * 40})
        saved = json.loads((self.state / "sac-inbox" / "gha-777-1.json").read_text())
        self.assertEqual(saved["source_sha"], "a" * 40)

    def test_disabled_or_unknown_profile_rejected(self):
        self.policy["sac_submit"]["enabled"] = False
        with self.assertRaises(PermissionError):
            self.submit()
        self.policy["sac_submit"]["enabled"] = True
        with self.assertRaises(PermissionError):
            self.submit(args={**self.args, "project_id": "other"})
        with self.assertRaises(PermissionError):
            self.submit(args={**self.args, "profile_id": "wrong"})

    def test_shell_fields_and_repo_urls_forbidden(self):
        for item in (
            {**self.args, "command": "id"},
            {**self.args, "project_id": "../escape"},
            {**self.args, "source_sha": "main"},
            {**self.args, "source_sha": "git:aaaaaaaa"},
            {**self.args, "image": "alpine"},
        ):
            with self.assertRaises(ValueError):
                self.submit(args=item)

    def test_oidc_run_bound_and_retry_separated(self):
        with self.assertRaises(ValueError):
            self.submit(request_id="888-1-sac_submit-infrastructure")
        with self.assertRaises(ValueError):
            self.submit(request_id="777-2-sac_submit-infrastructure")
        with self.assertRaises(ValueError):
            self.submit(claims={**self.claims, "run_id": "invalid"})
        changed = {**self.claims, "run_attempt": "2"}
        output = self.submit(claims=changed, request_id="777-2-sac_submit-infrastructure")
        self.assertEqual(output["sacJob"]["jobId"], "gha-777-2")

    def test_symlink_inbox_rejected_without_writing_outside(self):
        (self.state / "sac-inbox").rmdir()
        target = self.state / "external"
        target.mkdir()
        (self.state / "sac-inbox").symlink_to(target)
        with self.assertRaises(ValueError):
            self.submit()
        self.assertEqual(list(target.iterdir()), [])

    def test_existing_symlink_receipt_is_rejected(self):
        target = self.state / "other"
        target.write_text("do-not-touch")
        (self.state / "sac-inbox" / "gha-777-1.json").symlink_to(target)
        with self.assertRaises(OSError):
            self.submit()
        self.assertEqual(target.read_text(), "do-not-touch")

    def test_policy_must_be_allowlisted_and_disabled_by_default(self):
        self.assertFalse(POLICY["sac_submit"]["enabled"])
        self.assertEqual(POLICY["sac_submit"]["projects"], [])
        bad = copy.deepcopy(self.policy)
        bad["sac_submit"]["projects"].append(bad["sac_submit"]["projects"][0])
        with self.assertRaises(ValueError):
            sac_submit.validate_args(bad, self.args)

    def test_trusted_main_workflow_and_actor_only(self):
        c = {"iss": receiver.ISSUER, "aud": receiver.AUDIENCE, "iat": 1000, "nbf": 999,
             "exp": 1200, "actor_id": "189416996", "repository_id": "1433232532",
             "repository": "Softdown-prog/Painel", "ref": "refs/heads/main",
             "event_name": "issues", "sha": "a" * 40, "run_id": "777",
             "workflow_ref": "Softdown-prog/Painel/.github/workflows/vps-command.yml@refs/heads/main"}
        self.assertEqual(receiver.validate_claims(c, self.policy, "infrastructure", "sac_submit", now=1100)["name"], "Softdown-prog/Painel")
        for change in ({"actor_id": "1"}, {"ref": "refs/heads/feature"},
                       {"event_name": "push"}, {"repository": "evil/Painel"}):
            with self.assertRaises(ValueError):
                receiver.validate_claims({**c, **change}, self.policy, "infrastructure", "sac_submit", now=1100)

if __name__ == "__main__":
    unittest.main()
