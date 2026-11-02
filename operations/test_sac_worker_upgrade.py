"""Regression tests for the opt-in SAC read-only broker upgrade."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sac_worker_upgrade import plan_policy, upgrade

EXAMPLE = json.loads((Path(__file__).parent / "policy.example.json").read_text())


class UpgradeSacWorkerTests(unittest.TestCase):
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
        # Remove disabled sac-submit from the synthetic installation if no
        # sac_submit.py exists (an old broker cannot load it).
        older["repositories"]["1433232532"]["operations"].remove("sac_submit")
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
