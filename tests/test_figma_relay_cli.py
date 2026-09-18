import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("figma_relay_cli", Path(__file__).resolve().parents[1] / "client" / "figma_relay_cli.py")
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


class RelayCliTests(unittest.TestCase):
    def test_unity_command_resolves_explicit_project_and_submits_once(self):
        project = str(Path(".tmp/unity-test").resolve())
        with patch.object(client, "_run", side_effect=[
            {"projects": [{"id": "p1", "path": project, "valid": True}]},
            {"ok": True, "result": {"ok": True, "prefab": "Assets/UI.prefab"}},
        ]) as run:
            result = client.unity_command(project, "unity.figma-to-prefab-import", {"imageDir": "Assets/Images"}, request_id="stable", project_id="p1")
        self.assertEqual(result["prefab"], "Assets/UI.prefab")
        self.assertEqual([call.kwargs["job_type"] for call in run.call_args_list], ["unity.projects.list", "unity.command"])
        self.assertEqual(run.call_args.kwargs["payload"]["id"], "p1")
        self.assertEqual(run.call_args.kwargs["payload"]["requestId"], "stable")

    def test_unity_refuses_unregistered_or_conflicting_project(self):
        project = str(Path(".tmp/unity-test").resolve())
        for entries in [[], [{"id": "p2", "path": project, "valid": True}], [{"id": "p1", "path": project, "valid": False}]]:
            with patch.object(client, "_run", return_value={"projects": entries}) as run:
                with self.assertRaisesRegex(client.RelayCliError, "uniquely match"):
                    client.unity_command(project, "unity.health", {}, project_id="p1")
            self.assertEqual(run.call_count, 1)

    def test_unity_unknown_outcome_keeps_identity_without_replay(self):
        project = str(Path(".tmp/unity-test").resolve())
        with patch.object(client, "_run", side_effect=[
            {"projects": [{"id": "p1", "path": project, "valid": True}]},
            client.RelayCliError("timeout", "TIMEOUT"),
        ]) as run:
            with self.assertRaisesRegex(client.RelayCliError, "projectId=p1; requestId=write-1"):
                client.unity_command(project, "unity.figma-to-prefab-import", {}, request_id="write-1")
        self.assertEqual(run.call_count, 2)

    def test_submission_preserves_target_id_and_detaches(self):
        with patch.object(client, "_run", return_value={"status": "succeeded", "result": {"status": "completed"}}) as run:
            result = client.submit_job({"type": "QUERY_SELECTION", "target": {"sessionId": "session", "fileKey": "file"}}, {}, request_id="stable", timeout=300)
        self.assertEqual(result, {"requestId": "stable", "result": {"status": "completed"}})
        self.assertEqual(run.call_args.kwargs["request_id"], "stable")
        self.assertEqual(run.call_args.kwargs["session_id"], "session")
        self.assertEqual(run.call_args.kwargs["file_key"], "file")
        self.assertTrue(run.call_args.kwargs["detach"])

    def test_unknown_result_is_not_replayed(self):
        with patch.object(client, "_run", side_effect=[{"status": "running"}, {"status": "result_unknown"}]) as run:
            with self.assertRaisesRegex(client.RelayCliError, "do not resubmit"):
                client.submit_job({"type": "DELETE_NODE_BY_ID"}, request_id="write")
        self.assertEqual([call.args[0] for call in run.call_args_list], ["figma-command", "task-wait"])

    def test_wait_timeout_resubscribes_without_resubmitting(self):
        with patch.object(client, "_run", side_effect=[{"status": "running"}, client.RelayCliError("timeout", "TIMEOUT"), {"status": "succeeded", "result": {"status": "completed"}}]) as run:
            self.assertEqual(client.submit_job({"type": "QUERY_SELECTION"}, request_id="stable")["result"]["status"], "completed")
        self.assertEqual([call.args[0] for call in run.call_args_list], ["figma-command", "task-wait", "task-wait"])
        self.assertTrue(all(call.kwargs["task_id"] == "stable" for call in run.call_args_list[1:]))

    def test_assets_are_not_silently_lost(self):
        with patch.object(client, "_run", return_value={"status": "succeeded", "result": {"status": "completed"}}) as run:
            client.submit_job({"type": "IMPORT_PSD_JOB"}, {"image": "C:/image.png"})
        self.assertEqual(run.call_args.kwargs["asset_paths"], {"image": "C:/image.png"})

    def test_local_url(self):
        self.assertEqual(client._cli_url("http://localhost:32130"), "ws://localhost:32130/relay")
        with self.assertRaises(client.RelayCliError):
            client._cli_url("https://example.com")

    def test_component_query_preserves_default_and_empty_libraries(self):
        with patch.object(client, "_run", return_value={"result": {"libraries": {}}}) as run:
            self.assertEqual(client.query_components(), {"libraries": {}})
            self.assertEqual(run.call_args.kwargs["payload"]["libraryNodeIds"], ["62:115", "2896:32"])
            client.query_components([])
            self.assertEqual(run.call_args.kwargs["payload"]["libraryNodeIds"], ["62:115", "2896:32"])

    def test_queries_keep_result_envelope_for_skill_consumers(self):
        with patch.object(client, "_run", return_value={"status": "succeeded", "result": {"status": "completed", "nodes": []}}) as run:
            for query in (lambda: client.query_selection(session_id="session"), lambda: client.query_node_children("1:2", session_id="session")):
                result = query()
                self.assertTrue(result["requestId"])
                self.assertEqual(result["result"]["nodes"], [])
                self.assertEqual(run.call_args.kwargs["session_id"], "session")

    def test_grid_job_preserves_options_and_unwraps_results(self):
        with patch.object(client, "submit_job", return_value={"status": "ok", "result": {"componentId": "1:2"}}) as submit:
            result = client.submit_grid_component_job("", "root", "Grid", ["slot"], {"text": {}}, text_node_ids=["text"], reference_slot_index=2)
        self.assertEqual(result, {"componentId": "1:2"})
        self.assertEqual(submit.call_args.args[0]["textNodeIds"], ["text"])
        self.assertEqual(submit.call_args.args[0]["referenceSlotIndex"], 2)
        with patch.object(client, "submit_job", return_value={"status": "error", "errors": ["denied"]}):
            with self.assertRaisesRegex(client.RelayCliError, "denied"):
                client.submit_grid_component_job("", "root", "Grid", [], {})


if __name__ == "__main__":
    unittest.main()
