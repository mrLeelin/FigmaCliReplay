import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("truth_cli", ROOT / "ai/skills/prefab-to-figma/scripts/dump_unity_prefab_truth.py")
truth_cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(truth_cli)


class TruthCliTests(unittest.TestCase):
    def test_explicit_project_and_validated_truth_with_temporary_file_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            (project / "Assets").mkdir()
            (project / "ProjectSettings").mkdir()
            truth = {"schema": "unity-runtime-prefab-truth.v1", "prefabPath": "Assets/Root.prefab", "root": {}}
            envelope = {"success": True, "data": {"success": True, "target": {"projectPath": str(project)}, "result": {"success": True, "result": json.dumps(truth)}}}
            args = argparse.Namespace(project_root=str(project), prefab="Assets/Root.prefab", canvas="750x1334", out=str(project / "output"), timeout=20)
            with patch.object(truth_cli.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps(envelope), stderr="")) as run:
                result = truth_cli.run_dump(args)
            command = run.call_args.args[0]
            self.assertEqual(command[1:3], ["command", "eval_file"])
            self.assertEqual(command[4], "20000")
            self.assertEqual(command[command.index("--project-path") + 1], str(project.resolve()))
            self.assertFalse(Path(command[3]).exists())
            self.assertEqual(json.loads(Path(result["artifacts"]["truthPath"]).read_text()), result)
            envelope["data"]["target"]["projectPath"] = str(project / "other")
            with self.assertRaisesRegex(RuntimeError, "different project"):
                truth_cli.extract_cli_result(envelope, project)
            envelope["data"]["result"]["success"] = False
            with self.assertRaisesRegex(RuntimeError, "evaluation failed"):
                truth_cli.extract_cli_result(envelope, project)

    def test_timeout_is_not_replayed_and_temp_code_is_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            (project / "Assets").mkdir()
            (project / "ProjectSettings").mkdir()
            args = argparse.Namespace(project_root=str(project), prefab="Assets/Root.prefab", canvas="750x1334", out=str(project / "output"), timeout=1)
            with patch.object(truth_cli.subprocess, "run", side_effect=subprocess.TimeoutExpired("unity", 1)) as run:
                with self.assertRaises(subprocess.TimeoutExpired):
                    truth_cli.run_dump(args)
            self.assertEqual(run.call_count, 1)
            self.assertFalse(Path(run.call_args.args[0][3]).exists())
            self.assertFalse((project / "output" / truth_cli.TRUTH_FILE_NAME).exists())


if __name__ == "__main__":
    unittest.main()
