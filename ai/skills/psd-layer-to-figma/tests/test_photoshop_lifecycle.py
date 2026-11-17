"""Ownership and cross-process cleanup tests; never start or quit real Photoshop."""

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import photoshop_lifecycle as lifecycle


OWN_PROCESS = {"pid": 421, "creationTime": "134393871228692718"}


class PhotoshopEnvironment:
    def __init__(self, *, running=False, registered=True):
        self.running = [copy.copy(OWN_PROCESS)] if running else []
        self.registered = registered
        self.app = mock.Mock()
        self.app.Documents.Count = 0
        self.client = mock.Mock()
        self.client.GetActiveObject.side_effect = self.active
        self.client.Dispatch.side_effect = self.dispatch
        self.launch = mock.Mock(side_effect=self.launch_process)
        self.app.Quit.side_effect = self.quit
        self.stack = ExitStack()

    def active(self, prog_id):
        if not self.running or not self.registered:
            raise RuntimeError("no active COM object")
        return self.app

    def dispatch(self, prog_id):
        if not self.running:
            self.running = [copy.copy(OWN_PROCESS)]
        self.registered = True
        return self.app

    def launch_process(self):
        self.running = [copy.copy(OWN_PROCESS)]
        return copy.copy(OWN_PROCESS)

    def quit(self):
        self.running = []

    def __enter__(self):
        self.stack.enter_context(mock.patch.object(lifecycle, "photoshop_processes", side_effect=lambda: copy.deepcopy(self.running)))
        self.stack.enter_context(mock.patch.object(lifecycle, "_client", return_value=self.client))
        self.stack.enter_context(mock.patch.object(lifecycle, "_launch_registered_process", self.launch))
        return self

    def __exit__(self, *args):
        return self.stack.__exit__(*args)


class LifecycleTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.receipt = Path(self.directory.name) / "photoshop-session.json"

    def test_preexisting_empty_application_is_borrowed_and_never_quit(self):
        with PhotoshopEnvironment(running=True) as env:
            session = lifecycle.PhotoshopSession(self.receipt)
            self.assertIs(session.acquire(), env.app)
            env.client.Dispatch.assert_not_called()
            env.launch.assert_not_called()
            self.assertFalse(session.data["startedByImport"])
            result = lifecycle.release_session(self.receipt)
            self.assertEqual((result["action"], result["reason"]), ("kept", "pre-existing-or-unowned-instance"))
            env.app.Quit.assert_not_called()

    def test_existing_process_is_kept_when_it_is_not_yet_registered_in_com(self):
        with PhotoshopEnvironment(running=True, registered=False) as env:
            session = lifecycle.PhotoshopSession(self.receipt)
            session.acquire()
            self.assertTrue(session.data["wasRunning"])
            self.assertFalse(session.data["startedByImport"])
            env.client.Dispatch.assert_called_once()
            self.assertEqual(session.release()["action"], "kept")
            env.app.Quit.assert_not_called()

    def test_active_com_object_is_borrowed_even_if_process_snapshot_is_empty(self):
        with PhotoshopEnvironment() as env:
            env.client.GetActiveObject.side_effect = None
            env.client.GetActiveObject.return_value = env.app
            session = lifecycle.PhotoshopSession(self.receipt)
            session.acquire()
            self.assertTrue(session.data["wasRunning"])
            self.assertEqual(session.release()["action"], "kept")
            env.launch.assert_not_called()
            env.client.Dispatch.assert_not_called()
            env.app.Quit.assert_not_called()

    def test_owned_instance_remains_until_separate_cleanup_and_quits_once(self):
        with PhotoshopEnvironment() as env:
            session = lifecycle.PhotoshopSession(self.receipt)
            session.acquire()
            self.assertTrue(json.loads(self.receipt.read_text())["startedByImport"])
            self.assertTrue(env.running, "renderer must leave its instance alive for Figma")
            self.assertEqual(lifecycle.release_session(self.receipt)["action"], "closed")
            self.assertFalse(env.running)
            self.assertTrue(lifecycle.release_session(self.receipt)["repeated"])
            env.app.Quit.assert_called_once()
            env.client.Dispatch.assert_called_once()

    def test_cleanup_does_not_dispatch_or_reopen_an_exited_instance(self):
        with PhotoshopEnvironment() as env:
            session = lifecycle.PhotoshopSession(self.receipt)
            session.acquire()
            env.running = []
            env.client.reset_mock()
            self.assertEqual(lifecycle.release_session(self.receipt)["action"], "already-closed")
            env.client.GetActiveObject.assert_not_called()
            env.client.Dispatch.assert_not_called()
            env.app.Quit.assert_not_called()

    def test_reused_pid_does_not_allow_quitting_a_replacement_application(self):
        with PhotoshopEnvironment() as env:
            session = lifecycle.PhotoshopSession(self.receipt)
            session.acquire()
            env.running[0]["creationTime"] = str(int(OWN_PROCESS["creationTime"]) + 1)
            self.assertEqual(lifecycle.release_session(self.receipt)["action"], "skipped")
            env.app.Quit.assert_not_called()

    def test_an_additional_photoshop_process_makes_identity_ambiguous(self):
        with PhotoshopEnvironment() as env:
            session = lifecycle.PhotoshopSession(self.receipt)
            session.acquire()
            env.running.append({"pid": 654, "creationTime": str(int(OWN_PROCESS["creationTime"]) + 2000)})
            self.assertEqual(lifecycle.release_session(self.receipt)["action"], "skipped")
            env.app.Quit.assert_not_called()

    def test_simultaneous_manual_launch_is_not_mistaken_for_our_forwarded_launch(self):
        with PhotoshopEnvironment() as env:
            user_process = {"pid": 899, "creationTime": str(int(OWN_PROCESS["creationTime"]) + 1000)}

            def forwarded_launch():
                # User won Photoshop's singleton startup race. The process we
                # launched forwarded to it and exited before COM connected.
                env.running = [user_process]
                return copy.copy(OWN_PROCESS)

            env.launch.side_effect = forwarded_launch
            session = lifecycle.PhotoshopSession(self.receipt)
            session.acquire()
            self.assertFalse(session.data["startedByImport"])
            self.assertEqual(session.release()["action"], "skipped")
            env.app.Quit.assert_not_called()

    def test_unknown_creation_time_never_allows_automatic_quit(self):
        with PhotoshopEnvironment() as env:
            env.launch.side_effect = lambda: {"pid": 421, "creationTime": None}
            session = lifecycle.PhotoshopSession(self.receipt)
            session.acquire()
            self.assertFalse(session.data["startedByImport"])
            self.assertEqual(session.release()["action"], "skipped")
            env.app.Quit.assert_not_called()

    def test_user_document_opened_during_import_keeps_owned_application(self):
        with PhotoshopEnvironment() as env:
            session = lifecycle.PhotoshopSession(self.receipt)
            session.acquire()
            env.app.Documents.Count = 1
            result = lifecycle.release_session(self.receipt)
            self.assertEqual((result["action"], result["reason"]), ("kept", "open-documents"))
            env.app.Documents.Count = 0
            self.assertEqual(lifecycle.release_session(self.receipt)["reason"], "open-documents")
            env.app.Quit.assert_not_called()

    def test_dispatch_failure_defers_quit_and_preserves_identity_for_external_cleanup(self):
        with PhotoshopEnvironment() as env:
            def fail(prog_id):
                env.dispatch(prog_id)
                raise RuntimeError("COM startup failed after launch")

            env.client.Dispatch.side_effect = fail
            session = lifecycle.PhotoshopSession(self.receipt)
            with self.assertRaisesRegex(RuntimeError, "COM startup failed"):
                session.acquire()
            env.app.Quit.assert_not_called()
            receipt = json.loads(self.receipt.read_text())
            self.assertTrue(receipt["startedByImport"])
            self.assertEqual(receipt["state"], "active")
            self.assertEqual(lifecycle.release_session(self.receipt)["action"], "closed")
            env.app.Quit.assert_called_once()
            self.assertEqual(json.loads(self.receipt.read_text())["release"]["action"], "closed")

    def test_receipt_write_failure_after_launch_preserves_ownership_without_inline_quit(self):
        with PhotoshopEnvironment() as env:
            original = lifecycle._write_receipt
            writes = 0

            def fail_once(*args, **kwargs):
                nonlocal writes
                writes += 1
                if writes == 2:
                    raise OSError("disk full")
                return original(*args, **kwargs)

            with mock.patch.object(lifecycle, "_write_receipt", side_effect=fail_once):
                session = lifecycle.PhotoshopSession(self.receipt)
                with self.assertRaisesRegex(OSError, "disk full"):
                    session.acquire()
            env.app.Quit.assert_not_called()
            self.assertTrue(json.loads(self.receipt.read_text())["startedByImport"])
            self.assertEqual(lifecycle.release_session(self.receipt)["action"], "closed")
            env.app.Quit.assert_called_once()

    def test_native_launch_identity_is_persisted_before_com_activation(self):
        with PhotoshopEnvironment() as env:
            def activate(prog_id):
                receipt = json.loads(self.receipt.read_text())
                self.assertEqual(receipt["process"], OWN_PROCESS)
                self.assertTrue(receipt["startedByImport"])
                self.assertEqual(receipt["state"], "active")
                return env.dispatch(prog_id)

            env.client.Dispatch.side_effect = activate
            lifecycle.PhotoshopSession(self.receipt).acquire()

    def test_direct_cli_without_receipt_can_clean_up_a_failed_activation_inline(self):
        with PhotoshopEnvironment() as env:
            def fail(prog_id):
                env.dispatch(prog_id)
                raise RuntimeError("COM startup failed")

            env.client.Dispatch.side_effect = fail
            with self.assertRaisesRegex(RuntimeError, "COM startup failed"):
                lifecycle.PhotoshopSession().acquire()
            env.app.Quit.assert_called_once()

    def test_existing_receipt_is_not_overwritten_even_if_failure_cleanup_runs(self):
        self.receipt.write_text('{"owner":"other-task"}', encoding="utf-8")
        with PhotoshopEnvironment() as env:
            session = lifecycle.PhotoshopSession(self.receipt)
            with self.assertRaises(FileExistsError):
                session.acquire()
            session.release()
            self.assertEqual(json.loads(self.receipt.read_text()), {"owner": "other-task"})
            env.client.Dispatch.assert_not_called()
            env.client.GetActiveObject.assert_not_called()

    def test_failed_quit_is_reported_without_forcing_termination(self):
        with PhotoshopEnvironment() as env:
            session = lifecycle.PhotoshopSession(self.receipt)
            session.acquire()
            env.app.Quit.side_effect = RuntimeError("busy")
            result = lifecycle.release_session(self.receipt)
            self.assertFalse(result["ok"])
            self.assertEqual(result["reason"], "cleanup-failed")
            self.assertTrue(env.running)

    def test_rpc_disconnect_during_successful_quit_is_not_a_cleanup_error(self):
        with PhotoshopEnvironment() as env:
            session = lifecycle.PhotoshopSession(self.receipt)
            session.acquire()

            def disconnected_quit():
                env.quit()
                raise RuntimeError("RPC disconnected")

            env.app.Quit.side_effect = disconnected_quit
            self.assertEqual(lifecycle.release_session(self.receipt)["action"], "closed")

    def test_quit_timeout_is_reported_without_terminating_process(self):
        with PhotoshopEnvironment() as env:
            session = lifecycle.PhotoshopSession(self.receipt)
            session.acquire()
            env.app.Quit.side_effect = None
            result = lifecycle._release_data(session.data, env.app, timeout_seconds=0)
            self.assertEqual((result["action"], result["reason"]), ("error", "quit-timeout"))
            self.assertTrue(env.running)

    def test_receipt_persistence_failure_does_not_hide_a_successful_quit(self):
        with PhotoshopEnvironment() as env:
            session = lifecycle.PhotoshopSession(self.receipt)
            session.acquire()
            with mock.patch.object(lifecycle, "_write_receipt", side_effect=OSError("disk full")):
                result = lifecycle.release_session(self.receipt)
            self.assertEqual(result["action"], "closed")
            self.assertIn("disk full", result["receiptWriteError"])
            env.app.Quit.assert_called_once()

    def test_cleanup_waits_for_owned_startup_registration_without_dispatching_again(self):
        with PhotoshopEnvironment() as env:
            session = lifecycle.PhotoshopSession(self.receipt)
            session.acquire()
            env.client.reset_mock()
            env.client.GetActiveObject.side_effect = [RuntimeError("not registered yet"), env.app]
            with mock.patch.object(lifecycle.time, "sleep"):
                result = lifecycle.release_session(self.receipt)
            self.assertEqual(result["action"], "closed")
            env.client.Dispatch.assert_not_called()
            env.app.Quit.assert_called_once()

    def test_inaccessible_owned_instance_hits_cleanup_deadline_without_launch_or_quit(self):
        with PhotoshopEnvironment() as env:
            session = lifecycle.PhotoshopSession(self.receipt)
            session.acquire()
            env.client.reset_mock()
            env.client.GetActiveObject.side_effect = RuntimeError("COM unavailable")
            result = lifecycle._release_data(session.data, timeout_seconds=0)
            self.assertEqual(result["reason"], "running-instance-not-accessible")
            env.client.Dispatch.assert_not_called()
            env.app.Quit.assert_not_called()

    def test_missing_and_invalid_receipts_do_not_even_load_com(self):
        with mock.patch.object(lifecycle, "_client") as client:
            self.assertEqual(lifecycle.release_session(self.receipt)["reason"], "receipt-missing")
            self.receipt.write_text('[]')
            self.assertEqual(lifecycle.release_session(self.receipt)["reason"], "receipt-invalid")
            client.assert_not_called()

    def test_cleanup_cli_reads_borrowed_receipt_in_another_process_without_com(self):
        self.receipt.write_text(json.dumps({"version": 1, "state": "active", "startedByImport": False,
                                            "wasRunning": True, "process": OWN_PROCESS}), encoding="utf-8")
        result = subprocess.run([sys.executable, "-I", str(SCRIPTS / "photoshop_lifecycle.py"), "release",
                                 "--session-receipt", str(self.receipt)], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)["action"], "kept")
        self.assertEqual(json.loads(self.receipt.read_text())["state"], "released")

    def test_cleanup_cli_reports_error_as_json_without_failing_completed_figma_task(self):
        self.receipt.write_text("not JSON", encoding="utf-8")
        result = subprocess.run([sys.executable, "-I", str(SCRIPTS / "photoshop_lifecycle.py"), "release",
                                 "--session-receipt", str(self.receipt)], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)["action"], "error")
        self.assertEqual(json.loads(result.stdout)["reason"], "receipt-unreadable")


class RegisteredLauncherTest(unittest.TestCase):
    def run_launch(self, command, *, exists=True):
        registry = mock.Mock()
        registry.QueryValue.side_effect = ["{photoshop-clsid}", command]
        with mock.patch.dict(sys.modules, {"winreg": registry}), \
                mock.patch.object(lifecycle.Path, "is_file", return_value=exists), \
                mock.patch.object(lifecycle.subprocess, "Popen", return_value=mock.Mock(pid=421)) as popen, \
                mock.patch.object(lifecycle, "_process_creation_time", return_value=OWN_PROCESS["creationTime"]):
            result = lifecycle._launch_registered_process()
        return result, popen

    def test_registered_unquoted_and_quoted_paths_with_spaces_use_explicit_executable(self):
        executable = r"C:\Program Files\Adobe\Adobe Photoshop 2024\Photoshop.exe"
        for command in (executable + " /Automation", '"' + executable + '" /Automation'):
            with self.subTest(command=command):
                result, popen = self.run_launch(command)
                self.assertEqual(result, OWN_PROCESS)
                self.assertEqual(popen.call_args.args, ('"' + executable + '" /Automation',))
                self.assertEqual(popen.call_args.kwargs["executable"], executable)
                self.assertNotIn("shell", popen.call_args.kwargs)

    def test_unexpected_executable_is_rejected_before_launch(self):
        registry = mock.Mock()
        registry.QueryValue.side_effect = ["{photoshop-clsid}", r"C:\Other\Calculator.exe /Automation"]
        with mock.patch.dict(sys.modules, {"winreg": registry}), \
                mock.patch.object(lifecycle.subprocess, "Popen") as popen:
            with self.assertRaisesRegex(RuntimeError, "executable is unavailable"):
                lifecycle._launch_registered_process()
            popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
