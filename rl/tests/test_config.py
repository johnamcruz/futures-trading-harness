import json
import tempfile
import unittest
from pathlib import Path

from fth_rl.config import MIN_PASS_RATE, gate_failures, load_config

WINDOWS = {"train": ["2024-01-01", "2024-06-01"], "select": ["2024-06-01", "2024-09-01"], "oos": ["2024-09-01", "2025-01-01"]}


def write(cfg):
    d = Path(tempfile.mkdtemp())
    p = d / "c.json"
    p.write_text(json.dumps(cfg))
    return p


class ConfigTest(unittest.TestCase):
    def test_defaults_and_the_40_percent_zero_blow_gate(self):
        cfg = load_config(write({"name": "x", "strategy": "prop_portfolio_3m", "windows": WINDOWS}))
        self.assertNotIn("account", cfg, "the account comes from the policy strategy's STRATEGY.md")
        with self.assertRaisesRegex(ValueError, "comes from the policy strategy"):
            load_config(write({"name": "x", "strategy": "prop_portfolio_3m", "windows": WINDOWS, "account": "topstep_50k"}))
        with self.assertRaisesRegex(ValueError, "strategy: the policy strategy"):
            load_config(write({"name": "x", "windows": WINDOWS}))
        self.assertEqual(cfg["min_pass_rate"], MIN_PASS_RATE)
        self.assertEqual(MIN_PASS_RATE, 0.40)
        self.assertEqual(cfg["ppo"]["gamma"], 0.999)

    def test_the_gate_can_be_raised_never_lowered_and_blows_are_not_configurable(self):
        self.assertEqual(load_config(write({"name": "x", "strategy": "prop_portfolio_3m", "windows": WINDOWS, "min_pass_rate": 0.6}))["min_pass_rate"], 0.6)
        with self.assertRaisesRegex(ValueError, "min_pass_rate"):
            load_config(write({"name": "x", "strategy": "prop_portfolio_3m", "windows": WINDOWS, "min_pass_rate": 0.3}))
        with self.assertRaisesRegex(ValueError, "max_blows"):
            load_config(write({"name": "x", "strategy": "prop_portfolio_3m", "windows": WINDOWS, "max_blows": 1}))

    def test_a_blow_always_costs_more_than_the_fastest_pass_earns(self):
        with self.assertRaisesRegex(ValueError, "reward.blow"):
            load_config(write({"name": "x", "strategy": "prop_portfolio_3m", "windows": WINDOWS, "reward": {"blow": 12}}))
        self.assertEqual(load_config(write({"name": "x", "strategy": "prop_portfolio_3m", "windows": WINDOWS, "reward": {"blow": 14}}))["reward"]["blow"], 14)

    def test_windows_never_overlap(self):
        bad = {**WINDOWS, "select": ["2024-05-01", "2024-09-01"]}
        with self.assertRaisesRegex(ValueError, "without overlap"):
            load_config(write({"name": "x", "strategy": "prop_portfolio_3m", "windows": bad}))
        with self.assertRaisesRegex(ValueError, "ppo: unknown"):
            load_config(write({"name": "x", "strategy": "prop_portfolio_3m", "windows": WINDOWS, "ppo": {"lr": 1}}))

    def test_gate_failures(self):
        ok = {"attempts": 20, "passed": 9, "blown": 0, "passRate": 0.45, "months": {"2024-09": {"blown": 0}, "2024-10": {"blown": 0}}}
        self.assertEqual(gate_failures(ok), [])
        self.assertTrue(gate_failures({**ok, "passed": 7}))
        self.assertTrue(gate_failures(ok, 0.5))
        # The exact rate, not the rounded one: 333/833 rounds to 0.400 but is under it.
        self.assertIn("under", gate_failures({**ok, "attempts": 833, "passed": 333, "passRate": 0.4})[0])
        one_blow = {**ok, "blown": 1, "months": {"2024-09": {"blown": 1}, "2024-10": {"blown": 0}}}
        self.assertIn("2024-09", gate_failures(one_blow)[0])
        self.assertIn("too small", gate_failures({**ok, "attempts": 4, "passed": 4})[0])
        self.assertIn("too small", gate_failures({**ok, "months": {"2024-09": {"blown": 0}}})[0])
        self.assertEqual(gate_failures({"attempts": 20, "passed": 10}), ["the out-of-sample result is missing or malformed"])
        # An optional win-rate gate.
        self.assertEqual(gate_failures({**ok, "trades": 100, "wins": 55}, 0.4, 0.5), [])
        self.assertIn("win rate 0.45", gate_failures({**ok, "trades": 100, "wins": 45}, 0.4, 0.5)[0])
        self.assertIn("win rate unknown", gate_failures(ok, 0.4, 0.5)[0])
        self.assertTrue(gate_failures({**ok, "months": {"2024-09": {}, "2024-10": {"blown": 0}}}))


if __name__ == "__main__":
    unittest.main()
