"""SAC v2: prove the public Actions transport without SSH, OIDC or VPS access.

The fixture is a synthetic Compiler -> Worker record. The real read-only
query validates it before passing through the real GitHub-hosted client.
"""
import contextlib
from io import BytesIO, StringIO
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import client
import sac_worker
from test_sac_worker import POLICY, SacWorkerQueryTests


class PublicBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.state = self.directory / "sac"
        (self.state / "sac-results").mkdir(parents=True)
        self.source_record = SacWorkerQueryTests()._v2_record()
        self.job_id = self.source_record["job_id"]

    def _worker_result(self):
        (self.state / "sac-results" / (self.job_id + ".json")).write_text(
            json.dumps(self.source_record))
        return sac_worker.query_sac_worker(
            POLICY, {"action":"job","job_id":self.job_id},
            state_dir=self.state
        )

    def _invoke_client(self, response, *, expect_technical=True):
        envelope = {
            "id": "415-1-sac_worker-infrastructure",
            "project":"infrastructure", "operation":"sac_worker",
            "runId":"415", "actorId":"189416996", "commit":"b"*40,
            "exitCode":0, "durationSeconds":0.1,
            **response
        }
        secret = "SSH_PRIVATE_KEY_SYNTHETIC_NEVER_EXPOSE"
        env = {
            "ACTIONS_ID_TOKEN_REQUEST_URL":"https://synthetic.invalid/oidc?token=a",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN":"SYNTHETIC_OIDC_REQUEST_NEVER_EXPOSE",
            "VPS_OPERATION":"sac_worker",
            "VPS_PROJECT":"infrastructure",
            "VPS_SAC_ACTION":"job",
            "VPS_SAC_JOB_ID":self.job_id,
            "GITHUB_RUN_ID":"415", "GITHUB_RUN_ATTEMPT":"1",
            "VPS_SSH_KEY":secret,
            "VPS_KNOWN_HOSTS":"SYNTHETIC_KNOWN_HOSTS_NEVER_EXPOSE",
            "GITHUB_STEP_SUMMARY":str(self.directory/"summary.md"),
        }
        current = Path.cwd()
        try:
            os.chdir(self.directory)
            with patch.dict(os.environ,env,clear=True), \
                 patch.object(client.urllib.request,"urlopen",
                    return_value=BytesIO(json.dumps(
                        {"value":"SYNTHETIC_OIDC_TOKEN_NEVER_EXPOSE"}).encode())), \
                 patch.object(client.subprocess,"run",return_value=SimpleNamespace(
                    stdout=json.dumps(envelope),stderr="SSH_PRIVATE_KEY_SYNTHETIC_NEVER_EXPOSE",
                    returncode=0)) as ssh, \
                 contextlib.redirect_stdout(StringIO()) as stdout:
                self.assertEqual(client.main(),0)
            request=json.loads(ssh.call_args.kwargs["input"])
            self.assertEqual(request["args"],{"action":"job","job_id":self.job_id})
            self.assertEqual(request["operation"],"sac_worker")
            self.assertNotIn("registry_token",json.dumps(request["args"]))
            output=(self.directory/"vps-result.json").read_text()
            summary=(self.directory/"summary.md").read_text()
            self.assertEqual(json.loads(output),envelope)
            if expect_technical:
                self.assertIn("technicalReport",summary)
                self.assertIn("TS2322",output)
                self.assertIn("src/mode.ts",output)
                self.assertIn("linha 1, coluna 13",output)
            else:
                self.assertNotIn("technicalReport",summary)
            self.assertIn("status",output)
            for forbidden in (
                secret,"SYNTHETIC_KNOWN_HOSTS_NEVER_EXPOSE",
                "SYNTHETIC_OIDC_TOKEN_NEVER_EXPOSE",
                "SYNTHETIC_OIDC_REQUEST_NEVER_EXPOSE",
                "MUST_NOT_LEAK"
            ):
                self.assertNotIn(forbidden,output)
                self.assertNotIn(forbidden,summary)
                self.assertNotIn(forbidden,stdout.getvalue())
            return output
        finally:
            os.chdir(current)

    def test_worker_v2_through_real_actions_client_is_factual(self):
        self._invoke_client(self._worker_result())

    def test_legacy_v1_passes_without_v2_and_extra_secret_fields(self):
        old=dict(self.source_record)
        old.pop("technical_report")
        old["code"]="audit-not-verified"
        old["secret"]="NO_PUBLIC_SECRET"
        self.source_record=old
        result=self._worker_result()
        self.assertNotIn("technicalReport",result["sacWorker"])
        value=self._invoke_client(result,expect_technical=False)
        self.assertNotIn("NO_PUBLIC_SECRET",value)

    def test_tampered_compiler_result_rejected_before_transport(self):
        self.source_record["technical_report"]["text"] = "SECRET_CODE_SKIPPED"
        with self.assertRaises(ValueError):
            self._worker_result()

    def test_public_issue_comment_workflow_only_accepts_explicit_job_id(self):
        workflow=(Path(__file__).resolve().parent.parent /
                  ".github/workflows/vps-command.yml").read_text()
        self.assertIn("'[VPS] sac-job'",workflow)
        self.assertIn("VPS_SAC_ACTION:",workflow)
        self.assertIn("VPS_SAC_JOB_ID:",workflow)
        self.assertIn("gh issue comment",workflow)
        self.assertNotIn("SAC_APPROVE_DEPLOY",workflow)


if __name__=="__main__":
    unittest.main()
