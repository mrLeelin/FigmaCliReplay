from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SCRIPT_DIR = (
    Path(__file__).resolve().parents[1]
    / "ai"
    / "skills"
    / "figma-hierarchy-cleanup-mcp"
    / "scripts"
)
sys.path.insert(0, str(SCRIPT_DIR))

from apply_cleanup_plan import build_transaction_job, normalize_transaction_report, validate_transaction_plan
from run_cleanup_pipeline import run_pipeline


def valid_plan() -> dict:
    return {
        "schemaVersion": 2,
        "operation": "figma-hierarchy-cleanup-transaction",
        "target": {"nodeId": "R", "snapshotHash": "a" * 64},
        "operations": [],
        "verification": {"preserveAbsoluteBoundsTolerance": 0.01},
        "createBackup": False,
    }


class ApplyCleanupPlanTests(unittest.TestCase):
    def test_build_job_contains_only_confirmed_plan(self) -> None:
        plan = valid_plan()
        job = build_transaction_job(plan, "figma-session")
        self.assertEqual(job["type"], "FIGMA_HIERARCHY_CLEANUP_TRANSACTION")
        self.assertEqual(job["plan"], plan)
        self.assertEqual(job["target"]["sessionId"], "figma-session")
        self.assertNotIn("autoComponentSets", str(job))
        self.assertNotIn("autoNestedGeneric", str(job))

    def test_validation_rejects_non_transaction_and_component_fields(self) -> None:
        with self.assertRaisesRegex(ValueError, "schemaVersion"):
            validate_transaction_plan({**valid_plan(), "schemaVersion": 1})
        with self.assertRaisesRegex(ValueError, "component"):
            validate_transaction_plan({**valid_plan(), "componentCandidates": []})

    def test_validation_accepts_v3_compiled_transaction(self) -> None:
        plan = {
            **valid_plan(),
            "schemaVersion": 3,
            "operations": [
                {"id": "op-001", "type": "CREATE_GROUP", "parentNodeId": "R", "name": "[Screen]", "childNodeIds": ["A", "B"]},
                {"id": "op-002", "type": "CREATE_GROUP", "parentOperationId": "op-001", "name": "[Header]", "childNodeIds": ["A", "B"]},
            ],
        }
        job = build_transaction_job(plan, "figma-session")
        self.assertEqual(job["schemaVersion"], 3)
        self.assertEqual(job["plan"]["operations"][1]["parentOperationId"], "op-001")

    def test_normalizes_success_and_rollback_reports(self) -> None:
        succeeded = normalize_transaction_report({"result": {"status": "completed", "state": "succeeded", "checks": {"ok": True}}})
        self.assertEqual(succeeded["state"], "succeeded")
        rolled_back = normalize_transaction_report({"result": {"status": "rolled_back", "state": "rolled_back", "rollback": {"pass": True}}})
        self.assertEqual(rolled_back["state"], "rolled_back")
        with self.assertRaisesRegex(RuntimeError, "transaction status"):
            normalize_transaction_report({"result": {"status": "completed", "state": "rolled_back"}})
        with self.assertRaisesRegex(RuntimeError, "transaction state"):
            normalize_transaction_report({"result": {"status": "failed", "state": "unknown"}})

    def test_component_sets_only_skips_hierarchy_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            args = SimpleNamespace(
                work_dir=Path(temp_dir),
                relay_url="http://127.0.0.1:32130",
                figma_url="",
                node_id="R",
                file_key="",
                auto_component_sets_only=True,
                nested_target=[],
                startup_timeout=0.1,
                apply_confirmed=True,
            )
            with patch("run_cleanup_pipeline.ensure_mcp_companion", return_value={"ok": True}), \
                 patch("run_cleanup_pipeline.execute_auto_component_sets", return_value={"appliedCount": 1, "planCount": 1, "steps": []}) as execute_sets, \
                 patch("run_cleanup_pipeline.plan_root", side_effect=AssertionError("hierarchy plan must not run")):
                exit_code, report = run_pipeline(args)

        self.assertEqual(exit_code, 0)
        self.assertEqual(report["status"], "completed")
        self.assertTrue(report["summary"]["hierarchyCleanupSkipped"])
        self.assertEqual(report["summary"]["autoComponentSetCount"], 1)
        execute_sets.assert_called_once()


if __name__ == "__main__":
    unittest.main()
