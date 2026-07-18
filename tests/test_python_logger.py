import io
import json
import os
import sys
import unittest
from pathlib import Path


SERVER_DIR = Path(__file__).resolve().parents[1] / "server"
sys.path.insert(0, str(SERVER_DIR))

from python_logger import PythonLogger  # noqa: E402


class PythonLoggerTests(unittest.TestCase):
    def setUp(self):
        self.stream = io.StringIO()
        self.logger = PythonLogger(module="test", stream=self.stream, clock=lambda: 1_700_000_000.0)

    def events(self):
        lines = [line for line in self.stream.getvalue().splitlines() if line]
        return [json.loads(line.removeprefix("FIGMA_RELAY_LOG ")) for line in lines]

    def test_emits_contract_and_redacts_sensitive_data(self):
        self.logger.info(
            "request",
            data={"token": "secret", "nested": {"apiKey": "secret", "count": 2}},
            operation_id="op-1",
            operation_name="python.request",
        )

        event = self.events()[0]
        self.assertEqual("python", event["source"])
        self.assertEqual("op-1", event["operationId"])
        self.assertEqual("[REDACTED]", event["data"]["token"])
        self.assertEqual("[REDACTED]", event["data"]["nested"]["apiKey"])

    def test_uses_correlation_environment_variable(self):
        previous = os.environ.get("FIGMA_RELAY_OPERATION_ID")
        os.environ["FIGMA_RELAY_OPERATION_ID"] = "env-op"
        try:
            logger = PythonLogger(module="env", stream=self.stream, clock=lambda: 1_700_000_000.0)
            logger.info("from environment")
        finally:
            if previous is None:
                os.environ.pop("FIGMA_RELAY_OPERATION_ID", None)
            else:
                os.environ["FIGMA_RELAY_OPERATION_ID"] = previous

        self.assertEqual("env-op", self.events()[0]["operationId"])

    def test_operation_scope_emits_one_terminal_event(self):
        operation = self.logger.start_operation("python.worker", operation_id="op-worker")
        operation.step("spawn", "worker spawned")
        operation.succeed("done")
        operation.fail(RuntimeError("late"), "late failure")

        events = self.events()
        terminals = [event for event in events if event["status"] in ("succeeded", "failed", "cancelled")]
        self.assertEqual(1, len(terminals))
        self.assertEqual("op-worker", terminals[0]["operationId"])


if __name__ == "__main__":
    unittest.main()
