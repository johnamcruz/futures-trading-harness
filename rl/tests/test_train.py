"""A quick training run end to end: the bundle loads in the harness, and an
unvalidated one is never promoted. Needs torch, stable-baselines3, sb3-contrib."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from fth_rl import REPO_ROOT
from fth_rl.bridge import node_binary

from .synthetic import environ, write_config

try:
    import sb3_contrib  # noqa: F401
    import torch  # noqa: F401

    HAVE_SB3 = True
except ImportError:
    HAVE_SB3 = False

JS = """
const { checkBundle } = require('./scripts/lib/rl/policy-bundle');
const b = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
process.stdout.write(JSON.stringify({ research: checkBundle(b, { requireValidated: false }), live: checkBundle(b) }));
"""


@unittest.skipUnless(HAVE_SB3 or os.environ.get("FTH_REQUIRE_PYTHON") == "1", "torch / stable-baselines3 / sb3-contrib not installed")
class TrainTest(unittest.TestCase):
    def test_quick_training_writes_a_bundle_the_harness_loads_and_refuses_to_promote_it_unvalidated(self):
        from fth_rl.train import main

        d = Path(tempfile.mkdtemp())
        config, env = write_config(d, min_pass_rate=1.0)
        with environ(env):
            code = main(["--config", str(config), "--quick", "--promote", "--out", str(d / "out"), "--models-dir", str(d / "models")])
        bundle_file = d / "out" / "synthetic_policy.json"
        bundle = json.loads(bundle_file.read_text())
        self.assertFalse(bundle["validated"])
        self.assertEqual(code, 2)
        self.assertFalse((d / "models" / "synthetic_policy.json").exists())
        self.assertEqual(bundle["gate"], {"minPassRate": 1.0, "maxBlows": 0, "minWinRate": 0.0})
        self.assertIn("winRate", bundle["oos"])
        self.assertEqual(bundle["oos"]["attempts"], bundle["baseline"]["attempts"])
        self.assertTrue((d / "out" / "report.md").read_text().startswith("# Policy synthetic_policy"))
        # The run's logs: every line, structured events, and the manifest.
        logs = d / "out" / "logs"
        text = (logs / "train.log").read_text()
        self.assertRegex(text, r"\[train-policy\] \d{4}-\d\d-\d\dT\S+Z INFO seed 1 \[.*steps/s ETA .* \| attempts \d+ pass ")
        self.assertIn("out of sample: policy pass", text)
        events = [json.loads(x) for x in (logs / "train.jsonl").read_text().splitlines()]
        kinds = {e["kind"] for e in events}
        self.assertTrue({"seed_start", "attempt", "progress", "seed_trained", "evaluation"} <= kinds, kinds)
        attempt = next(e for e in events if e["kind"] == "attempt")
        self.assertTrue({"seed", "step", "status", "profit", "trades", "wins", "losses", "reward"} <= set(attempt))
        progress = next(e for e in events if e["kind"] == "progress")
        self.assertTrue({"stepsPerSec", "etaSec", "attempts", "pass", "blow", "winRate", "ppo"} <= set(progress))
        run = json.loads((logs / "run.json").read_text())
        self.assertEqual(run["status"], "not_validated")
        self.assertEqual(run["config"]["name"], "synthetic_policy")
        self.assertIn("python", run["versions"])
        self.assertIsNotNone(run["ended"])
        self.assertFalse(run["summary"]["validated"])
        out = subprocess.run([node_binary(), "-e", JS, str(bundle_file)], capture_output=True, text=True, cwd=REPO_ROOT, check=True)
        checks = json.loads(out.stdout)
        self.assertEqual(checks["research"], [])
        self.assertTrue(any("not validated" in e for e in checks["live"]))


if __name__ == "__main__":
    unittest.main()
