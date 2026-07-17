from __future__ import annotations

import sys
import unittest
from pathlib import Path


SCRIPT_DIR = (
    Path(__file__).resolve().parents[1]
    / "ai"
    / "skills"
    / "figma-hierarchy-cleanup-mcp"
    / "scripts"
)
sys.path.insert(0, str(SCRIPT_DIR))

from apply_cleanup_plan import build_transaction_job, normalize_transaction_report, validate_transaction_plan


def valid_plan() -> dict:
    return {
        "schemaVersion": 2,
        "operation": "figma-hierarchy-cleanup-transaction",
        "target": {"nodeId": "R", "snapshotHash": "a" * 64},
        "operations": [],
        "verification": {"preserveAbsoluteBoundsTolerance": 0.01},
        "createBackup": True,
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

    def test_normalizes_success_and_rollback_reports(self) -> None:
        succeeded = normalize_transaction_report({"result": {"status": "completed", "state": "succeeded", "checks": {"ok": True}}})
        self.assertEqual(succeeded["state"], "succeeded")
        rolled_back = normalize_transaction_report({"result": {"status": "rolled_back", "state": "rolled_back", "rollback": {"pass": True}}})
        self.assertEqual(rolled_back["state"], "rolled_back")
        with self.assertRaisesRegex(RuntimeError, "transaction status"):
            normalize_transaction_report({"result": {"status": "completed", "state": "rolled_back"}})
        with self.assertRaisesRegex(RuntimeError, "transaction state"):
            normalize_transaction_report({"result": {"status": "failed", "state": "unknown"}})


if __name__ == "__main__":
    unittest.main()
