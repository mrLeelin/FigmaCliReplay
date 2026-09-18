import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

scripts = Path(__file__).resolve().parents[1] / "ai" / "skills" / "figma-to-prefab" / "scripts"
sys.path.insert(0, str(scripts))
spec = importlib.util.spec_from_file_location("unity_import_under_test", scripts / "run_full_import.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class UnityImportCliTests(unittest.TestCase):
    def test_import_preserves_payload_and_selected_project(self):
        with patch.object(module, "UNITY_PROJECT", Path("selected-project")), patch.object(module, "unity_command", return_value={"ok": True, "prefab": "Assets/UI.prefab"}) as command:
            result = module.run_unity_bridge_import("Assets\\Images/", [".tmp\\plan.json"], "ws://localhost:32130/relay", "Assets\\Atlas/", "UI", project_id="p1")
        self.assertTrue(result["success"])
        self.assertEqual(json.loads(result["stdout"])["prefab"], "Assets/UI.prefab")
        self.assertEqual(command.call_args.args, ("selected-project", "unity.figma-to-prefab-import", {
            "imageDir": "Assets/Images", "specPaths": [".tmp/plan.json"], "atlasDir": "Assets/Atlas", "atlasName": "UI"
        }))
        self.assertEqual(command.call_args.kwargs["project_id"], "p1")

    def test_import_failure_does_not_retry(self):
        with patch.object(module, "unity_command", side_effect=module.RelayCliError("requestId=original; unknown")) as command:
            result = module.run_unity_bridge_import("Assets/Images", ["plan"], "")
        self.assertFalse(result["success"])
        self.assertIn("requestId=original", result["stderr"])
        self.assertEqual(command.call_count, 1)


if __name__ == "__main__":
    unittest.main()
