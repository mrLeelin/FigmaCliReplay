import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "submit_psd_import_job.py"
SPEC = importlib.util.spec_from_file_location("submit_psd_import_job", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PsdIncrementalTerminalStatusTests(unittest.TestCase):
    def test_initial_import_requires_completed(self):
        self.assertTrue(MODULE.is_successful_import_status("completed", "initial"))
        self.assertFalse(MODULE.is_successful_import_status("preview-ready", "initial"))

    def test_preview_accepts_every_non_error_terminal_preview(self):
        for status in (
            "preview-ready",
            "preview-blocked",
            "preview-no-changes",
            "preview-baseline-required",
        ):
            self.assertTrue(
                MODULE.is_successful_import_status(status, "incremental-preview"),
                status,
            )
        self.assertFalse(MODULE.is_successful_import_status("error", "incremental-preview"))

    def test_baseline_adoption_requires_baseline_adopted(self):
        self.assertTrue(MODULE.is_successful_import_status(
            "baseline-adopted", "incremental-baseline-adopt"
        ))
        self.assertFalse(MODULE.is_successful_import_status(
            "applied", "incremental-baseline-adopt"
        ))

    def test_apply_requires_applied(self):
        self.assertTrue(MODULE.is_successful_import_status("applied", "incremental-apply"))
        self.assertFalse(MODULE.is_successful_import_status("apply-blocked", "incremental-apply"))


if __name__ == "__main__":
    unittest.main()
