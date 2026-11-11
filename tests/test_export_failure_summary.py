import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[1] / "ai/skills/figma-to-prefab/scripts"
sys.path.insert(0, str(SCRIPTS))
import run_full_import as pipeline


class ExportFailureSummaryTests(unittest.TestCase):
    def run_failed_export(self, child_stdout):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "UnityProject"
            (project / "Assets").mkdir(parents=True)
            (project / "ProjectSettings").mkdir()
            arguments = ["run_full_import.py", "--unity-project", str(project),
                         "--figma-url", "https://www.figma.com/design/file/Relay?node-id=33-465",
                         "--target-prefab", "Assets/UI/Prefab/Root.prefab",
                         "--target-image-dir", "Assets/UI/Texture",
                         "--manifest-dir", str(root / "manifest"),
                         "--wall-clock-report", str(root / "wall-clock.json"), "--yes"]
            output, diagnostics = io.StringIO(), io.StringIO()
            with patch.dict(os.environ), patch.object(sys, "argv", arguments), \
                 patch.multiple(pipeline, UNITY_PROJECT=pipeline.UNITY_PROJECT,
                                TMP_DIR=pipeline.TMP_DIR, VERIFY_PREFAB_REPORT=pipeline.VERIFY_PREFAB_REPORT,
                                WALL_CLOCK_CONTEXT={}), \
                 patch.object(pipeline, "run", return_value=subprocess.CompletedProcess(
                     [], 1, child_stdout, '{"status":"failed","msg":"Task state updated"}\n')) as child, \
                 patch.object(pipeline, "unity_command") as unity, \
                 contextlib.redirect_stdout(output), contextlib.redirect_stderr(diagnostics):
                with self.assertRaises(SystemExit) as finished:
                    pipeline.main()
            self.assertEqual(finished.exception.code, 1)
            self.assertEqual(child.call_count, 1, "failed exports must not submit later stages")
            unity.assert_not_called()
            self.assertEqual(list((project / "Assets").iterdir()), [])
            self.assertEqual(output.getvalue().count("[SUMMARY_JSON]"), 1)
            summary = json.loads(output.getvalue().split("[SUMMARY_JSON]\n")[1])
            return summary, diagnostics.getvalue(), json.loads((root / "wall-clock.json").read_text(encoding="utf-8"))

    def test_blocked_image_survives_pipeline_summary_and_wall_clock(self):
        error = {"code": "invalidImagePayload", "nodeId": "33:521",
                 "nodePath": "建筑主界面/建筑进度条/图层 2 1", "exportId": "img_37",
                 "width": 0, "height": 0, "byteLength": 0}
        warning = "PNG export failed for 建筑主界面/建筑进度条/图层 2 1: Image dimensions not available"
        summary, diagnostics, wall_clock = self.run_failed_export("[SUMMARY_JSON]\n" + json.dumps({
            "status": "blocked", "blockingErrorCount": 1, "blockingErrorSamples": [error],
            "warningSamples": [warning], "errorSamples": [], "resultPath": "result.json",
        }, ensure_ascii=True, indent=2))
        self.assertEqual(summary["status"], "failed")
        self.assertFalse(summary["verifyAllPass"])
        self.assertEqual(summary["blockingErrors"], [error])
        self.assertEqual(summary["warnings"], [warning])
        self.assertIn("33:521", diagnostics)
        self.assertIn("Image dimensions not available", wall_clock["error"])

    def test_missing_or_malformed_child_summary_still_reports_export_failure(self):
        for child_output in ("", "[SUMMARY_JSON]\nnot-json", "[SUMMARY_JSON]\n[]"):
            with self.subTest(child_output=child_output):
                summary, _, _ = self.run_failed_export(child_output)
                self.assertEqual(summary["blockingErrors"][0]["code"], "figmaExportFailed")
                self.assertFalse(summary["verifyAllPass"])


if __name__ == "__main__":
    unittest.main()
