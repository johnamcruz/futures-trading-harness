"""The exported network runs the same in numpy (export.probs) and in the harness (policy-net.js)."""

import json
import re
import subprocess
import unittest

import numpy as np

from fth_rl import REPO_ROOT
from fth_rl.bridge import node_binary
from fth_rl.export import NORM_EPS, act, probs

JS = """
const { loadPolicy } = require('./scripts/lib/rl/policy-net');
const { network, cases } = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const p = loadPolicy(network);
process.stdout.write(JSON.stringify(cases.map(([obs, mask]) => ({ probs: Array.from(p.probs(obs, mask)), action: p.act(obs, mask) }))));
"""


def random_network(rng, obs_dim=16, hidden=(64, 64), n=3):
    sizes = [obs_dim, *hidden, n]
    layers = [{"W": rng.normal(0, 0.4, sizes[i + 1] * sizes[i]).tolist(), "b": rng.normal(0, 0.1, sizes[i + 1]).tolist()} for i in range(len(sizes) - 1)]
    return {
        "obsDim": obs_dim,
        "actionN": n,
        "hidden": list(hidden),
        "actor": {"sizes": sizes, "layers": layers},
        "normalizer": {"mean": rng.normal(0, 1, obs_dim).tolist(), "var": rng.uniform(0.1, 3, obs_dim).tolist(), "count": 100, "clip": 5.0},
    }


class ExportParityTest(unittest.TestCase):
    def test_numpy_and_the_harness_agree(self):
        rng = np.random.default_rng(3)
        net = random_network(rng)
        masks = [[1, 1, 1], [1, 1, 0]]
        cases = [[rng.normal(0, 4, 16).tolist(), masks[k % 2]] for k in range(200)]
        out = subprocess.run([node_binary(), "-e", JS], input=json.dumps({"network": net, "cases": cases}), capture_output=True, text=True, cwd=REPO_ROOT, check=True)
        js = json.loads(out.stdout)
        for (obs, mask), r in zip(cases, js):
            np.testing.assert_allclose(probs(net, obs, mask), r["probs"], rtol=1e-12, atol=1e-12)
            self.assertEqual(act(net, obs, mask), r["action"])
            if not mask[2]:
                self.assertEqual(r["probs"][2], 0)

    def test_eps_matches_the_harness(self):
        src = (REPO_ROOT / "scripts" / "lib" / "rl" / "policy-net.js").read_text()
        m = re.search(r"const NORM_EPS = ([0-9.e-]+);", src)
        self.assertEqual(float(m.group(1)), NORM_EPS)


if __name__ == "__main__":
    unittest.main()
