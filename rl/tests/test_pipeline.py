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
            # Every trial is logged: its params, state, score, and its own log file.
            sweep_logs = d / "out" / "sweep" / "logs"
            trials = [json.loads(x) for x in (sweep_logs / "sweep.jsonl").read_text().splitlines() if json.loads(x)["kind"] == "trial"]
            self.assertEqual(sorted(t["number"] for t in trials), [0, 1])
            self.assertTrue(all(t["state"] in ("complete", "infeasible", "pruned") and "params" in t and "minutes" in t for t in trials))
            self.assertTrue(all(t["reason"] for t in trials if t["state"] == "infeasible"))
            self.assertIn("trial=0", (d / "out" / "sweep" / "trial_000" / "train.log").read_text())
            self.assertEqual(json.loads((d / "out" / "sweep" / "trial_000" / "summary.json").read_text())["number"], 0)
            self.assertEqual(json.loads((sweep_logs / "run.json").read_text())["status"] if (sweep_logs / "run.json").exists()
                             else json.loads((sweep_logs / "sweep.run.json").read_text())["status"], "done")
            # The sweep never sees the out-of-sample window: nothing under ship/ yet.
            self.assertFalse((d / "out" / "ship").exists())
            # Each trial checks the env it runs in against the one the study recorded.
            env_rec = study.user_attrs["env"]
            self.assertEqual((env_rec["symbols"], env_rec["timeframe"], env_rec["components"]), (["MNQ"], 3, ["ema_wide"]))
            study.set_user_attr("env", {**env_rec, "timeframe": 1})
            with self.assertRaisesRegex(ValueError, "was trained on another env \\(timeframe"):
                pipeline.run_sweep(d / "sweep" / "f.json", n_trials=1)
            study.set_user_attr("env", env_rec)
            if pipeline.best_trial(study) is None:
                with self.assertRaisesRegex(ValueError, "no feasible trial"):
                    pipeline.run_retrain(d / "retrain" / "f.json")
                return
            cands = pipeline.run_retrain(d / "retrain" / "f.json")
            self.assertEqual(sorted(cands["seeds"]), ["1", "2"])
            again = pipeline.run_retrain(d / "retrain" / "f.json")  # resumable: nothing retrained
            self.assertEqual(again["seeds"], cands["seeds"])
            self.assertEqual(cands["config"]["seeds"], [1, 2], "the config the seeds were trained with")
            # The simulator they were trained in, with live fills; ship refuses seeds from another one.
            self.assertGreaterEqual(cands["engine"]["slippageTicks"], 1)
            self.assertEqual(cands["engine"]["fill"], "next-open")
            cand_file = d / "out" / "retrain" / "candidates.json"
            saved = cand_file.read_text()
            cand_file.write_text(json.dumps({**json.loads(saved), "engine": {**cands["engine"], "slippageTicks": 0}}))
            with self.assertRaisesRegex(ValueError, "another simulator"):
                pipeline.run_retrain(d / "retrain" / "f.json")
            if not any(c["selection"]["blown"] for c in cands["seeds"].values()):
                with self.assertRaisesRegex(ValueError, "another simulator"):
                    pipeline.run_ship(d / "ship" / "f.json")
            # The env they were trained in (strategies, markets, bar size): an edited strategy document never ships them.
            self.assertEqual(cands["env"]["symbols"], ["MNQ"])
            self.assertEqual(cands["env"]["timeframe"], 3)
            self.assertEqual(study.user_attrs["env"], cands["env"], "the study records the env its trials ran in")
            other = {**cands["env"], "timeframe": 1}
            cand_file.write_text(json.dumps({**json.loads(saved), "env": other}))
            with self.assertRaisesRegex(ValueError, "another env \\(timeframe"):
                pipeline.run_retrain(d / "retrain" / "f.json")
            clean = {k: {**v, "selection": {**v["selection"], "blown": 0}} for k, v in json.loads(saved)["seeds"].items()}
            cand_file.write_text(json.dumps({**json.loads(saved), "seeds": clean, "env": other}))
            with self.assertRaisesRegex(ValueError, "another env \\(timeframe"):
                pipeline.run_ship(d / "ship" / "f.json")
            cand_file.write_text(json.dumps({k: v for k, v in json.loads(saved).items() if k != "env"}))
            with self.assertRaisesRegex(ValueError, "from before retrain recorded their env"):
                pipeline.run_retrain(d / "retrain" / "f.json")
            cand_file.write_text(json.dumps({**{k: v for k, v in json.loads(saved).items() if k != "env"}, "seeds": clean}))
            with self.assertRaisesRegex(ValueError, "records no env"):
                pipeline.run_ship(d / "ship" / "f.json")
            cand_file.write_text(saved)
            # A study whose recorded env differs (the strategy document edited after the sweep) doesn't retrain.
            st = pipeline.make_study(pipeline.load_sweep(d / "sweep" / "f.json"), create=False)
            st.set_user_attr("env", other)
            with self.assertRaisesRegex(ValueError, "study synthetic_v1 was trained on another env"):
                pipeline.run_retrain(d / "retrain" / "f.json")
            st.set_user_attr("env", cands["env"])
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
            ship_run = json.loads((d / "out" / "ship" / "logs" / "ship.run.json").read_text())
            self.assertEqual(ship_run["status"], "not_validated")
            self.assertIn("ship synthetic_policy", (d / "out" / "ship" / "logs" / "ship.log").read_text())
            self.assertEqual(bundle["strategy"], "prop_test")
            self.assertEqual(bundle["components"], ["ema_wide"])
            self.assertEqual(bundle["symbols"], ["MNQ"])
            self.assertNotIn("symbol", bundle)
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
    def test_fills_ignore_the_calendar_dates(self):
        a = {"gate": True, "sessions": ["18:00-15:50@America/New_York"], "eodAt": "15:50@America/New_York", "slippageTicks": 1, "fill": "next-open", "closedDates": []}
        self.assertEqual(pipeline.fills_of(a), pipeline.fills_of({**a, "closedDates": ["2028-12-25"]}), "a year's holidays added: same fills")
        self.assertNotEqual(pipeline.fills_of(a), pipeline.fills_of({**a, "slippageTicks": 0}))
        self.assertNotEqual(pipeline.fills_of(a), pipeline.fills_of({**a, "fill": "close"}))

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

    def test_a_family_is_bound_to_the_env_it_trained_in(self):
        info = {"strategy": "p", "components": ["a"], "account": "acct", "symbols": ["MNQ", "MES"], "timeframe": 3, "obsFields": ["x"], "engine": {}}
        recorded = pipeline.check_env(None, info, "study s")
        self.assertEqual(recorded, pipeline.env_identity(info))
        self.assertEqual(pipeline.check_env(recorded, {**info, "engine": {"gate": True}}, "study s"), recorded, "fills are compared apart (FILL_KEYS)")
        # The strategy document edited to 1-minute bars, or another market list: never mixed, never shipped under the new label.
        with self.assertRaisesRegex(ValueError, "study s was trained on another env \\(timeframe"):
            pipeline.check_env(recorded, {**info, "timeframe": 1}, "study s")
        with self.assertRaisesRegex(ValueError, "symbols"):
            pipeline.check_env(recorded, {**info, "symbols": ["MNQ"]}, "study s")
        with self.assertRaisesRegex(ValueError, "components"):
            pipeline.check_env(recorded, {**info, "components": ["a", "b"]}, "study s")
        with self.assertRaisesRegex(ValueError, "exit"):
            pipeline.check_env(recorded, {**info, "exit": {"trail_activate_r": 3}}, "study s")
        self.assertIn("symbols", pipeline.FINGERPRINT_KEYS)

    def test_a_study_from_before_symbols_keeps_its_fingerprint(self):
        d = Path(tempfile.mkdtemp())
        (d / "bars.csv").write_text("x")
        one = {"strategy": "p", "symbol": "MNQ", "data": {"MNQ": "bars.csv"}, "windows": {}}
        key = {k: one.get(k) for k in ("strategy", "symbol", "data", "windows", "eval_every", "sessions", "eodAt", "slippageTicks", "closedDates", "earlyCloseDates")}
        key["data"] = {"MNQ": str((d / "bars.csv").resolve())}
        key["data_sha256"] = [pipeline.file_sha(d / "bars.csv")]
        key["fills"] = pipeline.FILLS_VERSION
        import hashlib
        old = hashlib.sha256(json.dumps(key, sort_keys=True).encode()).hexdigest()
        self.assertEqual(pipeline.fingerprint(one, d / "c.json"), old, "the hash a study made before symbols existed stored")
        many = {**one, "symbol": None, "symbols": ["MNQ", "MES"]}
        self.assertNotEqual(pipeline.fingerprint(many, d / "c.json"), pipeline.fingerprint({**many, "symbols": ["MNQ"]}, d / "c.json"))

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
