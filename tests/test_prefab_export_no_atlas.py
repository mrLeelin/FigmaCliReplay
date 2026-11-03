import argparse
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "ai" / "skills" / "figma-to-prefab" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import run_full_import as pipeline


class PrefabExportNoAtlasTests(unittest.TestCase):
    def wait_with_health_states(self, states, *, timeout=2):
        clock = [0.0]
        def advance(seconds):
            clock[0] += seconds
        diagnostics = io.StringIO()
        with patch.object(pipeline, "unity_command", side_effect=states) as command, \
             patch.object(pipeline.time, "monotonic", side_effect=lambda: clock[0]), \
             patch.object(pipeline.time, "sleep", side_effect=advance), \
             contextlib.redirect_stderr(diagnostics):
            result = pipeline.wait_for_unity_ready(
                "http://localhost:32130", project_id="fixed-project", timeout=timeout,
            )
        for call in command.call_args_list:
            self.assertEqual(call.args[1:], ("unity.health", {}))
            self.assertEqual(call.kwargs["project_id"], "fixed-project")
            self.assertEqual(call.kwargs["relay_url"], "http://localhost:32130")
        return result, command.call_count, diagnostics.getvalue()

    def test_readiness_wait_retries_only_health_after_temporary_disconnect(self):
        ready = {"connected": True, "isPlaying": False, "isCompiling": False, "isChangingPlayMode": False}
        result, calls, diagnostics = self.wait_with_health_states([
            pipeline.RelayCliError("Bridge offline"), ready, ready,
        ])
        self.assertEqual(result, ready)
        self.assertEqual(calls, 3)
        self.assertIn("Bridge offline", diagnostics)

    def test_readiness_wait_requires_two_healthy_reads_after_compilation_or_transition(self):
        ready = {"connected": True}
        result, calls, _ = self.wait_with_health_states([
            {"connected": True, "isCompiling": True}, ready,
            {"connected": True, "isChangingPlayMode": True}, ready, ready,
        ])
        self.assertEqual(result, ready)
        self.assertEqual(calls, 5)

    def test_readiness_wait_rejects_play_mode_immediately(self):
        with patch.object(pipeline, "unity_command", return_value={"connected": True, "isPlaying": True}) as command, \
             patch.object(pipeline.time, "sleep") as sleep:
            with self.assertRaisesRegex(RuntimeError, "EditMode"):
                pipeline.wait_for_unity_ready("http://localhost:32130", project_id="fixed-project")
        self.assertEqual(command.call_count, 1)
        sleep.assert_not_called()

    def test_readiness_wait_timeout_never_submits_a_write(self):
        clock = [0.0]
        with patch.object(pipeline, "unity_command", side_effect=pipeline.RelayCliError("Still offline")) as command, \
             patch.object(pipeline.time, "monotonic", side_effect=lambda: clock[0]), \
             patch.object(pipeline.time, "sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)), \
             contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(TimeoutError, "Still offline"):
                pipeline.wait_for_unity_ready("http://localhost:32130", project_id="fixed-project", timeout=1)
        self.assertGreater(command.call_count, 1)
        self.assertTrue(all(call.args[1] == "unity.health" for call in command.call_args_list))

    def test_named_export_sends_explicit_skip_with_no_atlas_paths(self):
        with patch.object(pipeline, "unity_command", return_value={"ok": True, "atlasPath": ""}) as command:
            result = pipeline.run_unity_bridge_import(
                "Assets/UI/按钮/Texture/", [".tmp/export/spec.json"], "http://localhost:32130",
                "Assets/ShouldNotBeCreated/", "ShouldNotBeCreated", skip_atlas=True,
                project_id="registered-project",
            )
        self.assertTrue(result["success"])
        self.assertEqual(command.call_args.args[1], "unity.figma-to-prefab-import")
        self.assertEqual(command.call_args.args[2], {
            "imageDir": "Assets/UI/按钮/Texture",
            "specPaths": [".tmp/export/spec.json"],
            "atlasDir": "", "atlasName": "", "skipAtlas": True,
        })

    def test_existing_import_keeps_atlas_enabled_by_default(self):
        with patch.object(pipeline, "unity_command", return_value={"ok": True}) as command:
            pipeline.run_unity_bridge_import(
                "Assets/UI/Texture", [".tmp/spec.json"], "http://localhost:32130",
                "Assets/UI/UiAtlas/", "UI_Root",
            )
        payload = command.call_args.args[2]
        self.assertEqual(payload["atlasDir"], "Assets/UI/UiAtlas")
        self.assertEqual(payload["atlasName"], "UI_Root")
        self.assertFalse(payload["skipAtlas"])

    def test_no_atlas_is_a_supported_cli_flag(self):
        result = subprocess.run([sys.executable, str(SCRIPTS / "run_full_import.py"), "--help"],
                                capture_output=True, text=True, encoding="utf-8", timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertIn("--no-atlas", result.stdout)

    def test_no_atlas_clears_formal_atlas_path_without_changing_prefab_and_texture(self):
        args = argparse.Namespace(infer_formal_names=True, formal_output_dir="Assets/UI/按钮",
                                  target_prefab="Assets/Pending.prefab", target_image_dir="Assets/Pending/Texture",
                                  prefab_name="", formal_layout="split", no_atlas=True)
        pipeline.configure_output_paths(args, "按钮")
        self.assertEqual(args.target_prefab, "Assets/UI/按钮/Prefab/UI_按钮.prefab")
        self.assertEqual(args.target_image_dir, "Assets/UI/按钮/Texture/")
        self.assertEqual(args.atlas_dir, "")

    def test_named_explicit_paths_and_chinese_prefab_name_are_preserved(self):
        args = argparse.Namespace(infer_formal_names=False, formal_output_dir="",
                                  target_prefab="Assets/UI/按钮/Prefab/按钮.prefab",
                                  target_image_dir="Assets/UI/按钮/Texture", prefab_name="按钮", no_atlas=True)
        pipeline.configure_output_paths(args, "Ignored formal name")
        self.assertEqual(args.target_prefab, "Assets/UI/按钮/Prefab/按钮.prefab")
        self.assertEqual(args.prefab_name, "按钮")
        self.assertEqual(args.atlas_dir, "")

    def test_default_formal_split_still_creates_an_atlas_directory(self):
        args = argparse.Namespace(infer_formal_names=True, formal_output_dir="Assets/UI/Card",
                                  target_prefab="Assets/Pending.prefab", target_image_dir="Assets/Pending/Texture",
                                  prefab_name="", formal_layout="split", no_atlas=False)
        pipeline.configure_output_paths(args, "Card")
        self.assertEqual(args.atlas_dir, "Assets/UI/Card/UiAtlas/")

    def test_explicit_source_names_can_match_former_placeholder_names(self):
        for name in ("Test", "Prefab", "Import", "Test1"):
            with self.subTest(name=name):
                pipeline.validate_formal_import_paths(
                    f"Assets/UI/{name}/Prefab/{name}.prefab", f"Assets/UI/{name}/Texture/", name,
                    allow_source_name=True,
                )

    def test_default_import_still_rejects_placeholder_names(self):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            for name in ("Test", "Prefab", "Import", "Test1"):
                with self.subTest(name=name), self.assertRaises(SystemExit):
                    pipeline.validate_formal_import_paths(
                        f"Assets/UI/{name}/Prefab/{name}.prefab", f"Assets/UI/{name}/Texture/", name,
                    )

    def test_source_name_exception_does_not_bypass_path_or_benchmark_guards(self):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            for prefab, texture in (("Packages/Test.prefab", "Assets/UI/Texture"),
                                    ("Assets/UI/Test.prefab", "Packages/Texture"),
                                    ("Assets/FigmaImportBenchmark/run-id/Prefabs/Test.prefab", "Assets/UI/Texture")):
                with self.subTest(prefab=prefab, texture=texture), self.assertRaises((SystemExit, ValueError)):
                    pipeline.validate_formal_import_paths(prefab, texture, "Test", allow_source_name=True)

    def test_main_named_export_creates_only_prefab_texture_and_reports_empty_atlas(self):
        self.run_named_export("按钮")

    def test_main_named_export_preserves_test_prefab_import_and_test1_source_names(self):
        for name in ("Test", "Prefab", "Import", "Test1"):
            with self.subTest(name=name):
                self.run_named_export(name)

    def test_main_no_atlas_without_explicit_name_retains_placeholder_guard(self):
        self.run_named_export("Test", explicit_name=False, expected_exit=1)

    def test_main_legacy_explicit_name_retains_placeholder_guard(self):
        self.run_named_export("Test", no_atlas=False, expected_exit=1)

    def test_child_summary_blocks_stay_on_stderr_and_parent_emits_one_summary(self):
        stdout, stderr = self.run_named_export("按钮", child_summaries=True)
        self.assertEqual(stdout.count("[SUMMARY_JSON]"), 1)
        self.assertEqual(len(stdout.strip().splitlines()), 2)
        for stage in ("mcpExport", "manifestReader", "genSpec", "processImages", "verifyPrefab"):
            self.assertIn(f"{stage} child stderr [SUMMARY_JSON]", stderr)
        self.assertIn('"child": "mcpExport"', stderr)
        self.assertIn('"child": "manifestReader"', stderr)
        self.assertIn('"child": "genSpec"', stderr)
        self.assertIn('"child": "processImages"', stderr)
        self.assertIn('"childMarker": "[SUMMARY_JSON]"', stderr)

    def run_named_export(self, name, *, explicit_name=True, no_atlas=True, expected_exit=0,
                         child_summaries=False):
        with tempfile.TemporaryDirectory(prefix="prefab-no-atlas-") as directory:
            project = Path(directory) / "UnityProject"
            (project / "Assets").mkdir(parents=True)
            (project / "ProjectSettings").mkdir()
            manifest = Path(directory) / "manifest"
            manifest.mkdir()
            (manifest / "figma_node_manifest.json").write_text("{}", encoding="utf-8")
            (manifest / "image_export_manifest.json").write_text('{"exports":[]}', encoding="utf-8")
            selected = project / "Assets" / "UI" / name
            target_prefab = f"Assets/UI/{name}/Prefab/{name}.prefab"
            target_texture = f"Assets/UI/{name}/Texture/"

            def run_stage(label, _argv, **_kwargs):
                pipeline.TMP_DIR.mkdir(parents=True, exist_ok=True)
                stdout = ""
                if label == "genSpec":
                    (pipeline.TMP_DIR / "spec_audit_report.json").write_text('{"allPass":true}', encoding="utf-8")
                elif label == "processImages":
                    (selected / "Texture").mkdir(parents=True)
                    (pipeline.TMP_DIR / "image_process_report.json").write_text('{"allPass":true}', encoding="utf-8")
                elif label == "verifyPrefab":
                    stdout = '{"allPass":true}'
                stderr = ""
                if child_summaries:
                    stdout = (json.dumps({"allPass": True, "childMarker": "[SUMMARY_JSON]"})
                              if label == "verifyPrefab" else "[SUMMARY_JSON]\n" + json.dumps({"child": label}))
                    stderr = f"{label} child stderr [SUMMARY_JSON]\n"
                return subprocess.CompletedProcess([], 0, stdout, stderr), {"label": label, "exitCode": 0}

            def run_child(argv, **kwargs):
                labels = {"figma_to_prefab_cli.py": "mcpExport", "figma_manifest_reader.py": "manifestReader",
                          "gen_spec.py": "genSpec", "process_images.py": "processImages", "verify_prefab.py": "verifyPrefab"}
                return run_stage(labels[Path(argv[0]).name], argv, **kwargs)[0]

            unity_actions = []
            def generate(_project, action, payload, **_kwargs):
                unity_actions.append(action)
                if action == "unity.health":
                    return {"connected": True, "projectPath": str(project), "isPlaying": False,
                            "isCompiling": False, "isChangingPlayMode": False}
                self.assertTrue(payload["skipAtlas"])
                self.assertEqual(payload["atlasDir"], "")
                self.assertEqual(payload["atlasName"], "")
                prefab = project / target_prefab
                prefab.parent.mkdir(parents=True)
                prefab.write_text("generated fixture", encoding="utf-8")
                return {"ok": True, "atlasPath": "", "childMarker": "[SUMMARY_JSON]"} if child_summaries else {"ok": True, "atlasPath": ""}

            arguments = ["run_full_import.py", "--unity-project", str(project),
                         "--figma-url", "https://www.figma.com/design/file/Relay?node-id=1-2",
                         "--target-prefab", target_prefab, "--target-image-dir", target_texture,
                         "--manifest-dir", str(manifest), "--yes"]
            if not child_summaries:
                arguments.append("--skip-relay-export")
            if explicit_name:
                arguments += ["--prefab-name", name]
            if no_atlas:
                arguments.append("--no-atlas")
            output = io.StringIO()
            diagnostics = io.StringIO()
            with contextlib.ExitStack() as patches:
                patches.enter_context(patch.dict(os.environ))
                patches.enter_context(patch.multiple(pipeline, UNITY_PROJECT=pipeline.UNITY_PROJECT,
                    TMP_DIR=pipeline.TMP_DIR, VERIFY_PREFAB_REPORT=pipeline.VERIFY_PREFAB_REPORT,
                    WALL_CLOCK_CONTEXT={}))
                patches.enter_context(patch.object(sys, "argv", arguments))
                if child_summaries:
                    patches.enter_context(patch.object(pipeline, "run", side_effect=run_child))
                else:
                    patches.enter_context(patch.object(pipeline, "run_timed", side_effect=run_stage))
                patches.enter_context(patch.object(pipeline, "load_manifest_target_snapshot", return_value={"rootName": name}))
                patches.enter_context(patch.object(pipeline, "validate_manifest_target", return_value=[]))
                patches.enter_context(patch.object(pipeline, "extract_plan_field", return_value=str(project)))
                patches.enter_context(patch.object(pipeline, "read_import_plan", return_value=(target_texture, [".tmp/spec.json"])))
                patches.enter_context(patch.object(pipeline, "unity_command", side_effect=generate))
                patches.enter_context(patch.object(pipeline.time, "sleep", return_value=None))
                patches.enter_context(contextlib.redirect_stdout(output))
                patches.enter_context(contextlib.redirect_stderr(diagnostics))
                with self.assertRaises(SystemExit) as finished:
                    pipeline.main()
            self.assertEqual(finished.exception.code, expected_exit)
            if expected_exit:
                self.assertFalse(selected.exists(), "rejected names must not write any Unity outputs")
                return
            self.assertEqual(sorted(child.name for child in selected.iterdir()), ["Prefab", "Texture"])
            summary = json.loads(output.getvalue().split("[SUMMARY_JSON]\n")[-1].splitlines()[0])
            self.assertEqual(summary["prefab"], target_prefab)
            self.assertEqual(summary["atlasDir"], "")
            self.assertEqual(summary["atlasPath"], "")
            self.assertTrue(summary["verifyAllPass"])
            self.assertEqual(unity_actions.count("unity.figma-to-prefab-import"), 1)
            if no_atlas:
                self.assertEqual(unity_actions[:2], ["unity.health", "unity.health"])
            return output.getvalue(), diagnostics.getvalue()


if __name__ == "__main__":
    unittest.main()
