import base64
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
import algorithm_cli as cli
import prefab_import_pipeline as pipeline
from PIL import Image


class AlgorithmCliTests(unittest.TestCase):
    def invoke(self, request):
        result = subprocess.run([sys.executable, str(ROOT / "server" / "algorithm_cli.py")],
            input=json.dumps(request), capture_output=True, text=True, encoding="utf-8",
            env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "FIGMA_RELAY_OPERATION_ID": "algorithm-test"}, timeout=10)
        return result, [json.loads(line) for line in result.stdout.splitlines()]

    def test_invalid_action_and_input_are_protocol_errors(self):
        for request in ({"action": "shell", "payload": {}}, [], {"action": "crop-jiugong"}):
            result, messages = self.invoke(request)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(messages[-1]["type"], "error")
            logs = [json.loads(line.removeprefix("FIGMA_RELAY_LOG ")) for line in result.stderr.splitlines()]
            self.assertEqual(logs[0]["status"], "started")
            self.assertEqual(logs[-1]["status"], "failed")
            self.assertTrue(all(item["operationId"] == "algorithm-test" for item in logs))

    def test_crop_reuses_validation_and_never_contaminates_stdout(self):
        result, messages = self.invoke({"action": "crop-jiugong", "payload": {"unityProjectPath": "/nonexistent/project"}})
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["type"], "result")
        self.assertFalse(messages[0]["result"]["ok"])
        self.assertIn("Invalid Unity project", messages[0]["result"]["error"])

    def test_prefab_requires_explicit_session_before_any_pipeline(self):
        with patch.object(cli, "run_prefab_to_figma_import_task") as run:
            for field in ("sessionId", "fileKey"):
                payload = {"sessionId": "session", "fileKey": "file"}
                del payload[field]
                with self.assertRaisesRegex(ValueError, field):
                    cli.execute({"action": "prefab-to-figma", "taskId": "task", "payload": payload}, lambda _: None)
            run.assert_not_called()

    def test_crop_success_writes_png_meta_and_correlated_success_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "Assets").mkdir()
            (root / "ProjectSettings").mkdir()
            source = io.BytesIO()
            Image.new("RGBA", (8, 8), (255, 0, 0, 255)).save(source, format="PNG")
            result, messages = self.invoke({"action": "crop-jiugong", "payload": {
                "unityProjectPath": str(root), "targetDir": "Assets", "images": [{
                    "fileName": "slice.png", "base64": base64.b64encode(source.getvalue()).decode("ascii"),
                    "imageType": "Sliced", "borderLeft": 2, "borderRight": 2,
                    "borderTop": 2, "borderBottom": 2,
                }],
            }})
            self.assertEqual(result.returncode, 0)
            self.assertTrue(messages[0]["result"]["ok"])
            with Image.open(root / "Assets" / "slice.png") as image:
                self.assertEqual(image.size, (6, 6))
            self.assertTrue((root / "Assets" / "slice.png.meta").is_file())
            logs = [json.loads(line.removeprefix("FIGMA_RELAY_LOG ")) for line in result.stderr.splitlines()]
            self.assertTrue(all(item["operationId"] == "algorithm-test" for item in logs))
            self.assertEqual(logs[-1]["status"], "succeeded")

    def test_pipeline_preserves_audits_nonblocking_truth_and_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task = pipeline.PrefabImportTask("task", {})
            snapshots = []
            state = pipeline.ImportState(task, snapshots.append)
            commands = []

            def command(_state, _task, args, _cwd):
                commands.append(args)
                if "dump_unity_prefab_truth.py" in args[1]:
                    raise RuntimeError("Unity offline")

            with patch.object(pipeline, "run_checked_command", command), patch.object(pipeline, "read_json_file", return_value={"allPass": True}), patch.object(pipeline, "_read_optional_json", return_value=None):
                result = pipeline.run_single_prefab_to_figma_import(state=state, task_id="task", relay_url="http://localhost:32130",
                    unity_project_root=root, prefab_path="Assets/a.prefab", prefab_canvas="auto", out_dir=root / "out",
                    index=1, total=1, component_mode="component", nested_prefab_component_mode="all",
                    figma_url="", file_key="fixed-file", session_id="fixed-session", target_node_id="")
            self.assertTrue(result["verifyReport"]["allPass"])
            self.assertFalse(result["unityTruthCompare"]["allPass"])
            writer = next(args for args in commands if args[1].endswith("prefab_to_figma_cli.py"))
            self.assertEqual(writer[writer.index("--session-id") + 1], "fixed-session")
            self.assertEqual(writer[writer.index("--file-key") + 1], "fixed-file")
            self.assertEqual(writer.count("--session-id"), 1)
            self.assertEqual(writer.count("--file-key"), 1)
            self.assertEqual(snapshots[-1]["stage"], "done:a")

    def test_failed_export_audit_prevents_writer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = pipeline.ImportState(pipeline.PrefabImportTask("task", {}), lambda _: None)
            with patch.object(pipeline, "run_checked_command") as command, patch.object(pipeline, "read_json_file", return_value={"allPass": False}):
                with self.assertRaises(RuntimeError):
                    pipeline.run_single_prefab_to_figma_import(state=state, task_id="task", relay_url="http://localhost:32130",
                        unity_project_root=root, prefab_path="Assets/a.prefab", prefab_canvas="auto", out_dir=root / "out",
                        index=1, total=1, component_mode="component", nested_prefab_component_mode="all",
                        figma_url="", file_key="file", session_id="session", target_node_id="")
                self.assertEqual(command.call_count, 2)


if __name__ == "__main__":
    unittest.main()
