"""The label dataset loader (fth_rl/dataset.py), on synthetic files in the format scripts/rl-dataset.js writes."""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np

from fth_rl import REPO_ROOT, dataset
from fth_rl.bridge import node_binary

VERSION = "a" * 64
FIELDS = ["in_position", "side", "cushion", "strategy:orb"]
FLAT_N = 49  # none + long/short x 6 stop multiples x 4 size steps (label-dataset.js)
ACTIONS = ["none"] + [f"{s}:{m}atr:{z}" for s in ("long", "short") for m in (0.5, 0.75, 1, 1.5, 2, 3) for z in (0.25, 0.5, 0.75, 1)] + ["hold", "tighten", "exit"]
MASKS = {"flat": [1 if k < FLAT_N else 0 for k in range(len(ACTIONS))], "position": [1 if k >= FLAT_N else 0 for k in range(len(ACTIONS))]}


def header(**kw):
    h = {
        "format": "fth-label-dataset", "version": 1, "mode": "student", "obsVersion": VERSION, "obsFields": FIELDS, "obsDim": len(FIELDS),
        "actions": ACTIONS, "actionN": len(ACTIONS), "masks": MASKS, "rows": 3,
    }
    h.update(kw)
    return h


def rows():
    return [
        {"key": "k1", "kind": "flat", "action": 0, "obs": [0, 1, 1.0, 1], "targets": {"counterfactual": {"result": "loss"}}, "weight": 1},
        {"key": "k2", "kind": "flat", "action": 1 + 0 * 24 + 0 * 4 + 1, "obs": [0, 1, 0.9, 0], "targets": {"outcome": {"result": "win", "net": 30.76}}, "weight": 1},
        {"key": "k3", "kind": "position", "action": FLAT_N + 2, "obs": [1, -1, 0.8, 0], "targets": {}, "weight": 0.5},
    ]


def write(h, rs):
    d = Path(tempfile.mkdtemp())
    p = d / "ds.jsonl"
    p.write_text("\n".join([json.dumps({"header": h})] + [json.dumps(r) for r in rs]) + "\n")
    return p


class DatasetTest(unittest.TestCase):
    def test_shapes_action_ids_masks_and_targets_apart(self):
        ds = dataset.load(write(header(), rows()), VERSION, obs_fields=FIELDS, mode="student")
        self.assertEqual(len(ds), 3)
        self.assertEqual(ds.obs.shape, (3, 4))
        self.assertEqual(ds.obs.dtype, np.float64)
        self.assertEqual(ds.actions.tolist(), [0, 2, 51])
        self.assertEqual(ds.masks.shape, (3, len(ACTIONS)))
        self.assertTrue(all(ds.masks[i, a] for i, a in enumerate(ds.actions)), "every action is allowed for its kind")
        self.assertFalse(ds.masks[0, FLAT_N], "a flat row can't hold")
        self.assertFalse(ds.masks[2, 0], "a trade row can't be flat's none")
        self.assertEqual(ds.kinds, ["flat", "flat", "position"])
        self.assertEqual(ds.weights.tolist(), [1.0, 1.0, 0.5])
        self.assertEqual(ds.targets[1]["outcome"]["net"], 30.76)
        self.assertEqual(ds.keys, ["k1", "k2", "k3"])
        self.assertEqual(ACTIONS[ds.actions[1]], "long:0.5atr:0.5")
        self.assertEqual(ds.obs[2].tolist(), [1.0, -1.0, 0.8, 0.0], "values exactly as written")

    def test_an_observation_version_mismatch_is_refused(self):
        p = write(header(), rows())
        with self.assertRaisesRegex(dataset.DatasetError, "observation version"):
            dataset.load(p, "b" * 64)
        with self.assertRaisesRegex(dataset.DatasetError, "obs_version"):
            dataset.load(p, None)
        with self.assertRaisesRegex(dataset.DatasetError, "other observation fields"):
            dataset.load(p, VERSION, obs_fields=FIELDS[:-1])
        with self.assertRaisesRegex(dataset.DatasetError, "not env"):
            dataset.load(p, VERSION, mode="env")

    def test_bad_files_are_refused(self):
        cases = [
            (header(format="other"), rows(), "not a label dataset"),
            (header(version=2), rows(), "dataset version"),
            (header(rows=4), rows(), "a torn file"),
            (header(obsDim=5), rows(), "obsDim"),
            (header(), [dict(rows()[0], obs=[0, 1, 1])] + rows()[1:], "observation fields"),
            (header(), [dict(rows()[0], action=FLAT_N)] + rows()[1:], "not allowed for a flat"),
            (header(), [dict(rows()[0], action=len(ACTIONS))] + rows()[1:], "not allowed"),
            (header(), [dict(rows()[0], action=True)] + rows()[1:], "not allowed"),
            (header(), [dict(rows()[0], kind="setup")] + rows()[1:], "unknown kind"),
            (header(), [dict(rows()[0], weight=-1)] + rows()[1:], "weight"),
            (header(), [dict(rows()[0], obs=[0, 1, None, 1])] + rows()[1:], "non-finite"),
        ]
        for h, rs, msg in cases:
            with self.subTest(msg=msg):
                with self.assertRaisesRegex(dataset.DatasetError, msg):
                    dataset.load(write(h, rs), VERSION)

    def test_the_format_matches_the_node_builder(self):
        """The constants here are label-dataset.js's (the student's actions and masks, the format and version)."""
        script = (
            "const d = require('./scripts/lib/rl/label-dataset');"
            "process.stdout.write(JSON.stringify({ actions: d.STUDENT.actions, masks: d.STUDENT.masks, format: d.FORMAT, version: d.VERSION, flatN: d.FLAT_N }))"
        )
        out = subprocess.run([node_binary(), "-e", script], cwd=str(REPO_ROOT), capture_output=True, text=True, check=True)
        js = json.loads(out.stdout)
        self.assertEqual(js["actions"], ACTIONS)
        self.assertEqual(js["masks"], MASKS)
        self.assertEqual(js["flatN"], FLAT_N)
        self.assertEqual((js["format"], js["version"]), (dataset.FORMAT, dataset.VERSION))

    def test_an_env_mode_dataset(self):
        env_masks = {"setup": [1, 1, 1], "position": [1, 1, 0]}
        h = header(mode="env", actions={"setup": ["skip", "half", "full"], "position": ["hold", "close"]}, actionN=3, masks=env_masks, rows=2)
        rs = [{"kind": "setup", "action": 2, "obs": [0, 1, 1, 1]}, {"kind": "position", "action": 1, "obs": [1, 1, 1, 0]}]
        ds = dataset.load(write(h, rs), VERSION, mode="env")
        self.assertEqual(ds.actions.tolist(), [2, 1])
        self.assertEqual(ds.weights.tolist(), [1.0, 1.0], "weight defaults to 1")
        with self.assertRaisesRegex(dataset.DatasetError, "not allowed for a position"):
            dataset.load(write(h, [rs[0], dict(rs[1], action=2)]), VERSION)


if __name__ == "__main__":
    unittest.main()
