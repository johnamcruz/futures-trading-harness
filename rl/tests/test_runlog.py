"""The training logs (fth_rl/runlog.py)."""

import io
import json
import math
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from fth_rl import runlog


class RunLogTest(unittest.TestCase):
    def test_a_run_writes_lines_events_and_a_manifest(self):
        d = Path(tempfile.mkdtemp())
        out = io.StringIO()
        with redirect_stdout(out):
            runlog.start(d, "train", {"name": "x", "_path": d / "c.json", "nan": math.nan, "p": Path("/a")}, quick=True)
            runlog.log("hello")
            runlog.event("progress", step=10, rate=float("inf"))
            with runlog.scope(file=d / "trial_000" / "train.log", trial=0):
                runlog.log("in a trial")
                runlog.event("attempt", status="passed")
            runlog.finish("done", best=1)
        lines = (d / "logs" / "train.log").read_text().splitlines()
        self.assertRegex(lines[1], r"^\[train\] \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ INFO hello$")
        self.assertRegex(lines[2], r" INFO trial=0 in a trial$")
        self.assertIn("in a trial", (d / "trial_000" / "train.log").read_text())
        self.assertIn("hello", out.getvalue(), "printed too")
        events = [json.loads(x) for x in (d / "logs" / "train.jsonl").read_text().splitlines()]
        self.assertEqual([e["kind"] for e in events], ["progress", "attempt"])
        self.assertIsNone(events[0]["rate"], "inf is written as null")
        self.assertEqual(events[1]["trial"], 0, "the scope's tags")
        run = json.loads((d / "logs" / "run.json").read_text())
        self.assertEqual(run["status"], "done")
        self.assertEqual(run["summary"], {"best": 1})
        self.assertTrue(run["quick"])
        self.assertIsNone(run["config"]["nan"])
        self.assertEqual(run["config"]["p"], "/a")
        self.assertNotIn("_path", run["config"], "private keys are left out")
        self.assertIsNone(runlog.current())

    def test_a_failure_is_logged_with_its_traceback_and_marks_the_run_failed(self):
        d = Path(tempfile.mkdtemp())
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()) as err:
            runlog.start(d, "sweep")
            try:
                raise RuntimeError("the env server died")
            except RuntimeError as e:
                runlog.failed(e)
        self.assertIn("ERROR RuntimeError: the env server died", err.getvalue())
        text = (d / "logs" / "sweep.log").read_text()
        self.assertIn("Traceback", text)
        run = json.loads((d / "logs" / "sweep.run.json").read_text())
        self.assertEqual(run["status"], "failed")
        self.assertEqual(run["error"], "RuntimeError: the env server died")
        runlog.finish()

    def test_without_a_run_lines_are_only_printed_and_events_dropped(self):
        out = io.StringIO()
        with redirect_stdout(out):
            runlog.log("no run")
            runlog.event("progress", step=1)
        self.assertIn("no run", out.getvalue())

    def test_durations_read_well(self):
        self.assertEqual([runlog.fmt_duration(x) for x in (None, 45, 600, 7200, -1)], ["?", "45s", "10.0m", "2.0h", "?"])


if __name__ == "__main__":
    unittest.main()
