import importlib.util
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import unittest

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "find_reusable", ROOT / "ai/skills/image-layer-to-figma/scripts/find_reusable_decomposition.py")
finder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(finder)


def make_run(root, name, color, body, task=True, manifest=True, hint=None, stages=()):
    run = root / name
    (run / "dxx/layers").mkdir(parents=True)
    Image.new("RGB", (8, 8), color).save(run / "source.png")
    (run / "dxx/layer-request.json").write_text(json.dumps({"body": body}), encoding="utf-8")
    if task:
        (run / "dxx/layer-task-id.txt").write_text("task-" + name, encoding="utf-8")
    if manifest:
        (run / "dxx/layers/00.png").write_bytes(b"x")
        (run / "dxx/manifest.json").write_text(json.dumps({"items": [{"file": "00.png"}]}), encoding="utf-8")
    if hint is not None:
        (run / "hint.txt").write_text(hint, encoding="utf-8")
    for stage in stages:
        (run / stage).mkdir(parents=True)
        (run / stage / "manifest.json").write_text("{}", encoding="utf-8")
    return run


def run_finder(root, current, args="--model seedream55 --size auto"):
    stream = io.StringIO()
    with redirect_stdout(stream):
        finder.main(["--source", str(current / "source.png"), "--decompose-args", args,
                     "--hint-file", str(current / "hint.txt"), "--runs-root", str(root)])
    return json.loads(stream.getvalue())


class FindReusableDecompositionTest(unittest.TestCase):
    def test_same_image_and_options_reuse_latest_completed_stage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            body = {"image": "u", "prompt": "p", "size": "auto", "model": "seedream55"}
            make_run(root, "20260101-000000", "red", body)
            make_run(root, "20260102-000000", "red", body, stages=("source-resources",))
            make_run(root, "20260103-000000", "blue", body)
            current = make_run(root, "20260104-000000", "red", body, task=False, manifest=False, hint="h")
            result = run_finder(root, current)
            self.assertEqual(result["action"], "reuse-existing-result")
            self.assertTrue(result["best"]["runDir"].endswith("20260102-000000"))
            self.assertEqual(result["best"]["latestStage"], "repaired")
            self.assertEqual(result["best"]["hintMatch"], "unknown")
            self.assertEqual(len(result["candidates"]), 2)

    def test_different_options_or_hint_require_new_submission(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            body = {"size": "auto", "model": "seedream55"}
            make_run(root, "a", "red", {"size": "2K", "model": "seedream55"})
            make_run(root, "b", "red", body, hint="other")
            current = make_run(root, "c", "red", body, task=False, manifest=False, hint="h")
            result = run_finder(root, current)
            self.assertEqual(result["action"], "submit-new")
            self.assertEqual(sorted(row["reason"] for row in result["candidates"]), ["DXX 选项不同", "拆分说明不同"])

    def test_known_task_without_result_is_recovered_not_resubmitted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            body = {"size": "auto", "model": "seedream55"}
            make_run(root, "a", "red", body, manifest=False, hint="h")
            current = make_run(root, "b", "red", body, task=False, manifest=False, hint="h")
            result = run_finder(root, current)
            self.assertEqual(result["action"], "layerwait-existing-task")
            self.assertEqual(result["best"]["dxx"]["taskId"], "task-a")


if __name__ == "__main__":
    unittest.main()
