"""sweep -> retrain -> ship on synthetic bars, tiny budgets. Needs optuna, torch, sb3-contrib."""

import json
import os
import tempfile
import unittest
from pathlib import Path

from fth_rl import pipeline

from .synthetic import environ, write_config

try:
    import optuna  # noqa: F401
    import sb3_contrib  # noqa: F401

    HAVE = True
except ImportError:
    HAVE = False


def family(d, **ship):
    cfg_path, env = write_config(d)
    env = {**env, "FTH_HOME": str(d / "home")}
    base = json.loads(cfg_path.read_text())
    sweep = {
        **base,
        "name": "synthetic_v1",
        "data": {"MNQ": "../MNQ_3min.csv"},
        "out_dir": "../out",
        "seeds": [1],
        "total_timesteps": 768,
        "n_envs": 1,
        "ppo": {"n_steps": 256, "batch_size": 64, "n_epochs": 1},
        "study": {"n_trials": 2, "pruner": "median", "checkpoints": 2, "seed": 1},
        "search_space": {
            "searched": {"ppo.learning_rate": {"type": "float", "low": 1e-4, "high": 1e-3, "log": True},
                         "hidden": {"type": "categorical", "choices": [[16], [32, 32]]}},
            "anchored": {"reward.blow": 40},
        },
    }
    for stage in ("sweep", "retrain", "ship"):
        (d / stage).mkdir()
    (d / "sweep" / "f.json").write_text(json.dumps(sweep))
    (d / "retrain" / "f.json").write_text(json.dumps({"sweep": "../sweep/f.json", "seeds": [1, 2], "total_timesteps": 512}))
    (d / "ship" / "f.json").write_text(json.dumps({"retrain": "../retrain/f.json", "bundle": "synthetic_policy", "models_dir": "../models", **ship}))
    return env


# CI (FTH_REQUIRE_PYTHON=1) runs it whatever is installed: a missing package fails there.
@unittest.skipUnless(HAVE or os.environ.get("FTH_REQUIRE_PYTHON") == "1", "optuna / torch / sb3-contrib not installed")
class PipelineTest(unittest.TestCase):
    def test_sweep_retrain_ship(self):
        d = Path(tempfile.mkdtemp())
        env = family(d, min_pass_rate=1.0)
        with environ(env):
            self.assertIsNone(pipeline.run_sweep(d / "sweep" / "f.json", dry_run=True))
            study = pipeline.run_sweep(d / "sweep" / "f.json")
            self.assertEqual(len(study.trials), 2)
            t = study.trials[0]
            cfg = json.loads(Path(t.user_attrs["config"]).read_text())
            self.assertEqual(cfg["reward"]["blow"], 40, "anchored")
            self.assertEqual(cfg["ppo"]["learning_rate"], t.params["ppo.learning_rate"], "sampled")
            self.assertIn(cfg["hidden"], ([16], [32, 32]))
            self.assertTrue(Path(cfg["data"]["MNQ"]).is_absolute())
            # The sweep never sees the out-of-sample window: nothing under ship/ yet.
            self.assertFalse((d / "out" / "ship").exists())
            if pipeline.best_trial(study) is None:
                with self.assertRaisesRegex(ValueError, "no feasible trial"):
                    pipeline.run_retrain(d / "retrain" / "f.json")
                return
            cands = pipeline.run_retrain(d / "retrain" / "f.json")
            self.assertEqual(sorted(cands["seeds"]), ["1", "2"])
            again = pipeline.run_retrain(d / "retrain" / "f.json")  # resumable: nothing retrained
            self.assertEqual(again["seeds"], cands["seeds"])
            self.assertEqual(cands["config"]["seeds"], [1, 2], "the config the seeds were trained with")
            if any(c["selection"]["blown"] for c in cands["seeds"].values()):
                with self.assertRaisesRegex(ValueError, "isn't robust"):
                    pipeline.run_ship(d / "ship" / "f.json")
                return
            # A dry run picks the seed but never looks at the out-of-sample window.
            self.assertEqual(pipeline.run_ship(d / "ship" / "f.json", dry_run=True), (None, None))
            self.assertFalse((d / "out" / "ship" / "oos_log.jsonl").exists())
            bundle, dest = pipeline.run_ship(d / "ship" / "f.json")
            self.assertFalse(bundle["validated"], "a 100% pass gate is not met on noise")
            self.assertIsNone(dest)
            self.assertFalse((d / "models" / "synthetic_policy.json").exists())
            self.assertEqual(bundle["training"]["family"], "synthetic_v1")
            self.assertEqual(bundle["training"]["oosLooks"], 1)
            self.assertEqual(bundle["gate"]["minPassRate"], 1.0)
            self.assertTrue((d / "out" / "ship" / "report.md").exists())
            self.assertEqual(bundle["strategy"], "prop_test")
            self.assertEqual(bundle["components"], ["ema_wide"])
            self.assertTrue(bundle["engine"]["gate"])
            # Another family on the same strategy, data, and window counts as another look.
            info = {"strategy": "prop_test", "data": bundle["data"]}
            cfg = {"windows": bundle["training"]["windows"]}
            self.assertEqual(pipeline.log_oos_look(d / "other", "other_family", 9, bundle["oos"], info, cfg), 2)
            # The study is bound to its data and windows: changed windows don't resume it.
            sweep = json.loads((d / "sweep" / "f.json").read_text())
            sweep["windows"]["oos"] = ["2026-03-10", "2026-04-03"]
            (d / "sweep" / "f.json").write_text(json.dumps(sweep))
            with self.assertRaisesRegex(ValueError, "other data, windows, or strategy"):
                pipeline.run_sweep(d / "sweep" / "f.json", n_trials=1)


class PipelineConfigTest(unittest.TestCase):
    def test_the_gate_account_data_and_windows_cannot_be_searched_and_the_gate_cannot_be_lowered(self):
        self.assertIn("never the strategy", pipeline.check_spec("windows.oos", {"type": "float", "low": 0, "high": 1}))
        self.assertIn("never the strategy", pipeline.check_spec("min_pass_rate", {"type": "float", "low": 0, "high": 1}))
        self.assertIsNone(pipeline.check_spec("ppo.learning_rate", {"type": "float", "low": 1e-5, "high": 1e-3, "log": True}))
        self.assertIn("log", pipeline.check_spec("ppo.ent_coef", {"type": "float", "low": 0, "high": 1, "log": True}))
        d = Path(tempfile.mkdtemp())
        env = family(d, min_pass_rate=0.3)
        with environ(env), self.assertRaisesRegex(ValueError, "never lowered"):
            pipeline.load_ship(d / "ship" / "f.json")
        sweep = json.loads((d / "sweep" / "f.json").read_text())
        sweep["search_space"]["anchored"]["account"] = "topstep_50k"
        (d / "sweep" / "f.json").write_text(json.dumps(sweep))
        with environ(env), self.assertRaisesRegex(ValueError, "searched or anchored"):
            pipeline.load_sweep(d / "sweep" / "f.json")

    def test_search_keys_and_ranges_are_checked_before_any_trial(self):
        self.assertIn("whole value", pipeline.check_spec("hidden.0", {"type": "categorical", "choices": [64]}))
        self.assertIn("one key at a time", pipeline.check_spec("ppo", {"type": "categorical", "choices": [{}]}))
        d = Path(tempfile.mkdtemp())
        env = family(d)
        sweep = json.loads((d / "sweep" / "f.json").read_text())
        bad_range = json.loads(json.dumps(sweep))
        bad_range["search_space"]["searched"]["sizing.cushion_frac"] = {"type": "float", "low": 0.5, "high": 1.5}
        (d / "sweep" / "f.json").write_text(json.dumps(bad_range))
        with environ(env), self.assertRaisesRegex(ValueError, "cushion_frac: at most 1"):
            pipeline.load_sweep(d / "sweep" / "f.json")
        overlap = json.loads(json.dumps(sweep))
        overlap["search_space"]["anchored"]["ppo.learning_rate"] = 0.001
        (d / "sweep" / "f.json").write_text(json.dumps(overlap))
        with environ(env), self.assertRaisesRegex(ValueError, "overlaps a searched key"):
            pipeline.load_sweep(d / "sweep" / "f.json")

    def test_every_shipped_sweep_config_loads(self):
        root = Path(__file__).resolve().parents[1] / "configs" / "sweep"
        with environ({"FTH_HOME": tempfile.mkdtemp()}):
            for f in sorted(root.glob("*.json")):
                sw = pipeline.load_sweep(f)
                self.assertTrue(sw["searched"], f.name)

    def test_scores_rank_every_feasible_trial_above_any_blow(self):
        clean = {"attempts": 10, "passed": 1, "blown": 0, "passRate": 0.1, "blowRate": 0, "tradesPerAttempt": 5}
        blew = {"attempts": 10, "passed": 9, "blown": 1, "passRate": 0.9, "blowRate": 0.1, "tradesPerAttempt": 5}
        self.assertGreater(pipeline.score(clean), pipeline.score(blew))
        # Feasible trials rank by pass rate plus the weighted win rate.
        hi_win = {**clean, "passRate": 0.4, "winRate": 0.6}
        lo_win = {**clean, "passRate": 0.4, "winRate": 0.3}
        self.assertGreater(pipeline.score(hi_win), pipeline.score(lo_win))
        self.assertAlmostEqual(pipeline.score(hi_win, win_weight=0.5), 0.7)
        self.assertLess(pipeline.score({**blew, "winRate": 1.0}), 0, "a blow is infeasible whatever the win rate")
        self.assertLess(pipeline.score(clean, min_trades=6), 0, "too few trades is infeasible")
        m = pipeline.merge([{**clean, "avgProfit": 100, "trades": 10, "wins": 6}, {**blew, "avgProfit": 300, "trades": 30, "wins": 10}])
        self.assertEqual(m["winRate"], 0.4)
        self.assertEqual((m["attempts"], m["blown"], m["passRate"], m["avgProfit"]), (20, 1, 0.5, 200))

    def test_every_family_in_rl_configs_links_up(self):
        root = Path(__file__).resolve().parents[1] / "configs"
        for ship in sorted((root / "ship").glob("*.json")):
            fam = ship.stem
            s = json.loads(ship.read_text())
            self.assertEqual(pipeline.ref(s["retrain"], ship), (root / "retrain" / f"{fam}.json").resolve(), fam)
            r = json.loads((root / "retrain" / f"{fam}.json").read_text())
            self.assertEqual(pipeline.ref(r["sweep"], root / "retrain" / f"{fam}.json"), (root / "sweep" / f"{fam}.json").resolve(), fam)
            sw = json.loads((root / "sweep" / f"{fam}.json").read_text())
            self.assertEqual(sw["name"], fam)
            for k, spec in sw["search_space"]["searched"].items():
                self.assertIsNone(pipeline.check_spec(k, spec), k)
            self.assertGreaterEqual(s.get("min_pass_rate", 0.4), 0.4)


if __name__ == "__main__":
    unittest.main()
