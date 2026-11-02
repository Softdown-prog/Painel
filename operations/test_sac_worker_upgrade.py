"""Regression tests for the opt-in SAC read-only broker upgrade."""
import copy
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sac_worker_upgrade import main, plan_policy, upgrade

EXAMPLE = json.loads((Path(__file__).parent / "policy.example.json").read_text())


class UpgradeSacWorkerTests(unittest.TestCase):
    def test_cli_accepts_exact_arguments_supplied_by_shell_wrapper(self):
        for mode in ("check", "apply"):
            with self.subTest(mode=mode), patch("sac_worker_upgrade.os.geteuid", return_value=0), \
                    patch("sac_worker_upgrade.upgrade", return_value={"mode": mode}) as install, \
                    redirect_stdout(StringIO()) as output:
                self.assertEqual(main(["sac_worker_upgrade.py", mode, "/reviewed/source"]), 0)
                install.assert_called_once_with(mode, "/reviewed/source",
                    "/usr/local/lib/vps-operations", "/etc/vps-operations/policy.json")
                self.assertEqual(json.loads(output.getvalue()), {"mode": mode})

    def test_cli_rejects_wrong_arguments_and_non_root_without_installing(self):
        cases = [(0, []), (0, ["check"]), (0, ["check", "/src", "extra"]),
                 (0, ["shell", "/src"]), (65534, ["apply", "/src"])]
        for uid, args in cases:
            with self.subTest(uid=uid, args=args), \
                    patch("sac_worker_upgrade.os.geteuid", return_value=uid), \
                    patch("sac_worker_upgrade.upgrade") as install, redirect_stderr(StringIO()):
                self.assertEqual(main(["sac_worker_upgrade.py", *args]), 2)
                install.assert_not_called()

    def test_only_adds_readonly_sac_worker_and_preserves_unrelated_policy(self):
        old = copy.deepcopy(EXAMPLE)
        old.pop("sac_worker")
        old["repositories"]["1433232532"]["operations"].remove("sac_worker")
        old["extra_operator_configuration"] = {"keep": "unchanged"}
        before = copy.deepcopy(old)
        plan = plan_policy(old, EXAMPLE)
        self.assertEqual(old, before)
        self.assertEqual(plan["sac_worker"], EXAMPLE["sac_worker"])
        self.assertEqual(plan["extra_operator_configuration"], old["extra_operator_configuration"])
        self.assertEqual(plan["sac_submit"], old["sac_submit"])
        self.assertEqual(plan["sac_submit"]["enabled"], False)
        self.assertIn("sac_worker", plan["repositories"]["1433232532"]["operations"])
        self.assertEqual(len(plan["repositories"]["1433232532"]["operations"]),
                         len(old["repositories"]["1433232532"]["operations"]) + 1)

    def test_idempotent_and_conflicting_policy_rejected(self):
        p = plan_policy(EXAMPLE, EXAMPLE)
        self.assertEqual(p, EXAMPLE)
        bad = copy.deepcopy(EXAMPLE)
        bad["sac_worker"]["state_dir"] = "/tmp/escape"
        with self.assertRaisesRegex(ValueError, "sac-worker-policy-conflict"):
            plan_policy(bad, EXAMPLE)
        for altered in (
            {"actor_ids": ["stranger"]},
            {"repositories": {}},
            {"repositories": {"1433232532": {"name": "unknown"}}}
        ):
            b = copy.deepcopy(EXAMPLE)
            b.update(altered)
            with self.assertRaises(ValueError):
                plan_policy(b, EXAMPLE)

    def test_unexpected_source_policy_cannot_expand_operations(self):
        injected = copy.deepcopy(EXAMPLE)
        injected["sac_worker"]["output"] = "full-logs"
        with self.assertRaisesRegex(ValueError, "unsupported-sac-policy"):
            plan_policy(EXAMPLE, injected)
        injected = copy.deepcopy(EXAMPLE)
        injected["sac_worker"]["enabled"] = False
        with self.assertRaisesRegex(ValueError, "unsupported-sac-policy"):
            plan_policy(EXAMPLE, injected)

    def _fake_install(self, base):
        repo = base / "source"
        (repo / "operations").mkdir(parents=True)
        for name in ("policy.example.json", "receiver.py", "sac_worker.py"):
            src = Path(__file__).with_name(name)
            (repo / "operations" / name).write_bytes(src.read_bytes())
        dst = base / "installed"
        dst.mkdir()
        for name in ("receiver.py", "admission.py", "driver.py", "maintenance.py",
                     "code_mcp.py", "mcp_query.py"):
            (dst / name).write_text("# installed module\n")
        policy = base / "private" / "policy.json"
        policy.parent.mkdir()
        older = copy.deepcopy(EXAMPLE)
        older.pop("sac_worker")
        older["repositories"]["1433232532"]["operations"].remove("sac_worker")
        # The policy may list sac_submit even when disabled and its handler
        # has not been installed; this must not block read-only SAC queries.
        policy.write_text(json.dumps(older))
        policy.chmod(0o600)
        return repo, dst, policy, older

    def test_check_is_readonly_apply_is_explicit_and_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, dst, policy, old = self._fake_install(Path(tmp))
            uid = os.getuid()
            state = (dst / "receiver.py").read_bytes()
            check = upgrade("check", src, dst, policy, owner_uid=uid)
            self.assertTrue(check["safeToApply"])
            self.assertTrue(check["changesRequired"])
            self.assertEqual(json.loads(policy.read_text()), old)
            self.assertEqual((dst / "receiver.py").read_bytes(), state)
            result = upgrade("apply", src, dst, policy, owner_uid=uid)
            self.assertTrue(result["installed"])
            after = json.loads(policy.read_text())
            self.assertTrue(after["sac_worker"]["enabled"])
            self.assertEqual(after["sac_submit"], old["sac_submit"])
            self.assertTrue((dst / "sac_worker.py").is_file())
            again = upgrade("check", src, dst, policy, owner_uid=uid)
            self.assertFalse(again["changesRequired"])

    def test_disabled_submit_module_is_optional_but_enabled_must_be_installed(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, dst, policy, old = self._fake_install(Path(tmp))
            self.assertFalse(old["sac_submit"]["enabled"])
            self.assertFalse((dst / "sac_submit.py").exists())
            self.assertTrue(upgrade("check", src, dst, policy,
                                    owner_uid=os.getuid())["safeToApply"])
            policy_data = json.loads(policy.read_text())
            policy_data["sac_submit"]["enabled"] = True
            policy.write_text(json.dumps(policy_data))
            with self.assertRaisesRegex(ValueError, "missing-installed-broker-file"):
                upgrade("check", src, dst, policy, owner_uid=os.getuid())

    def test_v1_to_v2_upgrade_serves_real_factual_job_without_enabling_submit(self):
        """Simulate existing root-owned broker -> opt-in v2 reader -> job query."""
        import importlib.util
        from test_sac_worker import SacWorkerQueryTests

        with tempfile.TemporaryDirectory() as tmp:
            src, dst, policy_path, original = self._fake_install(Path(tmp))
            uid = os.getuid()
            # Fake an earlier installed v1 handler; only the reviewed v2 source
            # may replace it, and check must not change the old installation.
            previous = b"# installed sac_worker v1 reader\n"
            (dst / "sac_worker.py").write_bytes(previous)
            old_receiver = (dst / "receiver.py").read_bytes()
            before = policy_path.read_bytes()

            checked = upgrade("check", src, dst, policy_path, owner_uid=uid)
            self.assertTrue(checked["safeToApply"])
            self.assertTrue(checked["changesRequired"])
            self.assertEqual((dst / "sac_worker.py").read_bytes(), previous)
            self.assertEqual((dst / "receiver.py").read_bytes(), old_receiver)
            self.assertEqual(policy_path.read_bytes(), before)

            applied = upgrade("apply", src, dst, policy_path, owner_uid=uid)
            self.assertTrue(applied["installed"])
            self.assertFalse(applied["containersChanged"])
            installed = json.loads(policy_path.read_text())
            self.assertEqual(installed, plan_policy(original, EXAMPLE))
            self.assertFalse(installed["sac_submit"]["enabled"])
            self.assertEqual((dst / "sac_worker.py").read_bytes(),
                             (src / "operations/sac_worker.py").read_bytes())
            self.assertEqual((dst / "receiver.py").read_bytes(),
                             (src / "operations/receiver.py").read_bytes())
            self.assertFalse(upgrade("check", src, dst, policy_path,
                                     owner_uid=uid)["changesRequired"])

            # Load the INSTALLED copy, not the source imported by other tests.
            spec = importlib.util.spec_from_file_location("installed_sac_worker_v2",
                                                         dst / "sac_worker.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            data = SacWorkerQueryTests()._v2_record()
            state = Path(tmp) / "job-state"
            results = state / "sac-results"
            results.mkdir(parents=True)
            (results / "gha-222-1.json").write_text(json.dumps(data))
            answer = module.query_sac_worker(installed,
                {"action": "job", "job_id": "gha-222-1"},
                state_dir=state)["sacWorker"]
            self.assertTrue(answer["readOnly"])
            self.assertEqual(answer["status"], "fail")
            self.assertEqual(answer["technicalReport"]["findings"][0]["code"], "TS2322")
            self.assertEqual(answer["technicalReport"]["findings"][0]["file"], "src/mode.ts")
            self.assertIn("linha 1, coluna 13", answer["technicalReport"]["text"])
            self.assertNotIn("MUST_NOT_LEAK", json.dumps(answer))
            self.assertFalse(answer["deploymentAuthorized"])
            # Check legacy status query still works with no checkpoint.
            self.assertFalse(module.query_sac_worker(installed,
                             {"action": "status"}, state_dir=state)["sacWorker"]["available"])
            # And intentional denial of any new code execution remains intact.
            with self.assertRaises(PermissionError):
                from sac_submit import validate_args
                validate_args(installed, {
                    "project_id": "demo", "profile_id": "angular-root",
                    "source_sha": "a"*40
                })

    def test_syntax_preflight_reads_source_without_compilation_cache(self):
        wrapper = Path(__file__).with_name("upgrade-vpsops-sac-worker.sh").read_text()
        self.assertIn("ast.parse", wrapper)
        self.assertNotIn("python3 -m py_compile", wrapper)
        self.assertIn('mode="$1"', wrapper)
        self.assertIn('sha="$3"', wrapper)

    def test_symlink_installed_files_or_invalid_policy_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, dst, policy, _ = self._fake_install(Path(tmp))
            receiver = dst / "receiver.py"
            receiver.unlink()
            receiver.symlink_to("/etc/passwd")
            with self.assertRaisesRegex(ValueError, "symlink"):
                upgrade("check", src, dst, policy, owner_uid=os.getuid())
            receiver.unlink()
            receiver.write_text("# safe\n")
            current = json.loads(policy.read_text())
            current["actor_ids"] = ["000"]
            policy.write_text(json.dumps(current))
            with self.assertRaises(ValueError):
                upgrade("apply", src, dst, policy, owner_uid=os.getuid())


if __name__ == "__main__":
    unittest.main()
