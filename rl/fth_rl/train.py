"""Train, select, and validate a prop-challenge policy with MaskablePPO.

    python rl/train_policy.py --config rl/configs/<name>.json [--quick] [--promote] [--out DIR]

1. Train each seed on attempts that start and end inside the training window.
2. Pick the seed with the fewest blows, then the highest pass rate, then
   the highest average profit, on the selection window (never trained on).
3. Validate out of sample, month by month, with the exported network run by
   the harness itself (the inference live trading uses). Validated: zero
   blows in every month, no exceptions, and a pass rate of at least
   min_pass_rate (0.40, may only be raised). The rules-only baseline is
   reported alongside.

Writes <out>/<name>.json (the bundle), report.md, and per-seed checkpoints.
--promote copies a validated bundle to models/<name>.json; an unvalidated one
is never promoted.
"""

import argparse
import datetime as dt
import json
import os
import shutil
import sys
import time
from pathlib import Path

import numpy as np

from . import REPO_ROOT
from .bridge import EnvServer
from .config import MIN_PASS_RATE, gate_failures, load_config
from .export import check_export, export_network
from . import runlog


def log(msg, level="INFO"):
    runlog.log(msg, level, stage="train-policy")


def harness_home():
    return Path(os.environ.get("FTH_HOME") or Path.home() / ".futures-trading-harness")


def rank(r):
    """Fewest blows, then the highest pass rate, then the highest win rate, then profit."""
    return (r.get("blowRate") if r.get("blowRate") is not None else 1, -(r.get("passRate") or 0), -(r.get("winRate") or 0), -(r.get("avgProfit") or 0))


def make_vec_env(cfg, window, seed):
    from stable_baselines3.common.vec_env import DummyVecEnv, SubprocVecEnv, VecNormalize

    from .env import ChallengeEnv

    path = str(cfg["_path"])

    def factory(k):
        return lambda: ChallengeEnv(path, window, seed=seed * 1000 + k)

    fns = [factory(k) for k in range(cfg["n_envs"])]
    venv = SubprocVecEnv(fns) if cfg["n_envs"] > 1 else DummyVecEnv(fns)
    return VecNormalize(venv, norm_obs=True, norm_reward=cfg["normalize_reward"], clip_obs=cfg["clip_obs"], gamma=cfg["ppo"]["gamma"], epsilon=1e-8)


# PPO internals worth watching, as SB3 records them after each update.
PPO_STATS = {"train/entropy_loss": "entropy", "train/approx_kl": "kl", "train/clip_fraction": "clip", "train/explained_variance": "ev",
             "train/value_loss": "vloss", "train/policy_gradient_loss": "pgloss", "train/learning_rate": "lr"}


class Window:
    """Attempt outcomes over one logging window (reset after each line)."""

    def __init__(self):
        self.n = self.passed = self.blown = self.timeout = self.trades = self.wins = self.losses = 0
        self.win_r = self.loss_r = self.sum_r = 0.0
        self.profit = 0.0
        self.sessions = 0
        self.reward = 0.0

    def add(self, o, reward):
        self.n += 1
        st = o.get("status")
        self.passed += st == "passed"
        self.blown += st == "blown"
        self.timeout += st == "timeout"
        self.trades += o.get("trades") or 0
        self.wins += o.get("wins") or 0
        self.losses += o.get("losses") or 0
        self.win_r += o.get("winR") or 0
        self.loss_r += o.get("lossR") or 0
        self.sum_r += o.get("sumR") or 0
        self.profit += o.get("profit") or 0
        self.sessions += o.get("sessions") or 0
        self.reward += reward

    def stats(self):
        n = self.n or None
        rate = (lambda k: getattr(self, k) / n) if n else (lambda k: None)
        decided = self.wins + self.losses
        return {
            "attempts": self.n, "pass": rate("passed"), "blow": rate("blown"), "timeout": rate("timeout"),
            "winRate": self.wins / decided if decided else None, "tradesPerAttempt": self.trades / n if n else None,
            "avgWinR": self.win_r / self.wins if self.wins else None, "avgLossR": self.loss_r / self.losses if self.losses else None,
            "expectancyR": self.sum_r / self.trades if self.trades else None,
            "avgProfit": self.profit / n if n else None, "avgSessions": self.sessions / n if n else None, "epReward": self.reward / n if n else None,
        }


def progress_line(seed, steps, total, sps, eta, w, ppo):
    f = lambda x, spec: "-" if x is None else format(x, spec)  # noqa: E731
    ppo_txt = " ".join(f"{k} {v:.3g}" for k, v in ppo.items()) or "ppo -"
    return (f"seed {seed} [{steps:>9,}/{total:,} {steps / total:4.0%}] {sps:,.0f} steps/s ETA {runlog.fmt_duration(eta)} | "
            f"attempts {w['attempts']} pass {f(w['pass'], '.0%')} blow {f(w['blow'], '.0%')} timeout {f(w['timeout'], '.0%')} | "
            f"win {f(w['winRate'], '.0%')} avg winR {f(w['avgWinR'], '.2f')} lossR {f(w['avgLossR'], '.2f')} exp {f(w['expectancyR'], '+.2f')}R | "
            f"trades/att {f(w['tradesPerAttempt'], '.1f')} profit ${f(w['avgProfit'], ',.0f')} "
            f"sessions {f(w['avgSessions'], '.1f')} ep reward {f(w['epReward'], '.2f')} | {ppo_txt}")


def progress_callback(every_steps, checkpoint=None, checkpoints=0, total=0, seed=None):
    """Logs training progress every `every_steps`: speed and ETA, the attempts
    finished in the window (pass / blow / timeout, win rate, trades, profit,
    episode reward), and PPO's internals (entropy, KL, clip fraction,
    explained variance, losses). Each finished attempt is an `attempt` event,
    each line a `progress` event. With `checkpoint`, calls
    checkpoint(model, vec_env, k) at k = 1..checkpoints evenly spaced points
    (the sweep's pruning evaluation; it may raise to stop the run)."""
    from stable_baselines3.common.callbacks import BaseCallback

    class Progress(BaseCallback):
        def __init__(self):
            super().__init__()
            self.next_k = 1
            self.window = Window()
            self.last = 0
            self.t0 = None
            self.ep_reward = None

        def _on_training_start(self):
            self.t0 = time.time()
            self.ep_reward = np.zeros(self.training_env.num_envs)

        def _on_step(self):
            env = self.training_env
            raw = env.get_original_reward() if hasattr(env, "get_original_reward") else self.locals.get("rewards")
            if raw is not None:
                self.ep_reward += np.asarray(raw, dtype=float).reshape(-1)[: len(self.ep_reward)]
            for k, info in enumerate(self.locals.get("infos", [])):
                o = info.get("outcome")
                if o:
                    r = float(self.ep_reward[k]) if k < len(self.ep_reward) else 0.0
                    self.window.add(o, r)
                    runlog.event("attempt", seed=seed, step=self.num_timesteps, reward=r,
                                 **{x: o.get(x) for x in ("start", "status", "sessions", "profit", "balance", "trades", "wins", "losses", "winR", "lossR", "sumR")})
                    if k < len(self.ep_reward):
                        self.ep_reward[k] = 0.0
            if self.num_timesteps - self.last >= every_steps:
                self.last = self.num_timesteps
                elapsed = max(time.time() - (self.t0 or time.time()), 1e-9)
                sps = self.num_timesteps / elapsed
                eta = (total - self.num_timesteps) / sps if sps > 0 and total else None
                ppo = {short: float(self.model.logger.name_to_value[k]) for k, short in PPO_STATS.items() if k in self.model.logger.name_to_value}
                w = self.window.stats()
                log(progress_line(seed, self.num_timesteps, total or self.num_timesteps, sps, eta, w, ppo))
                runlog.event("progress", seed=seed, step=self.num_timesteps, total=total, stepsPerSec=sps, etaSec=eta, **w, ppo=ppo)
                self.window = Window()
            if checkpoint and self.next_k < checkpoints and self.num_timesteps >= total * self.next_k / checkpoints:
                checkpoint(self.model, self.training_env, self.next_k)
                self.next_k += 1
            return True

    return Progress()


def train_seed(cfg, seed, out_dir, checkpoint=None, checkpoints=0):
    """Train one seed on the training window; returns the exported network.
    Saves the model, its VecNormalize statistics, and the network under out_dir/seeds."""
    import torch
    import torch.nn as nn
    from sb3_contrib import MaskablePPO

    torch.set_num_threads(max(1, int(os.environ.get("FTH_TORCH_THREADS", "1"))))
    w = cfg["_windows"]
    venv = make_vec_env(cfg, w["train"], seed)
    try:
        model = MaskablePPO(
            "MlpPolicy",
            venv,
            seed=seed,
            device="cpu",
            verbose=0,
            policy_kwargs={"net_arch": {"pi": cfg["hidden"], "vf": cfg["hidden"]}, "activation_fn": nn.Tanh},
            **cfg["ppo"],
        )
        started = time.time()
        total = cfg["total_timesteps"]
        log(f"seed {seed}: {total:,} steps, {cfg['n_envs']} envs, net {cfg['hidden']}, ppo {json.dumps(cfg['ppo'])}")
        runlog.event("seed_start", seed=seed, total=total, nEnvs=cfg["n_envs"], hidden=cfg["hidden"], ppo=cfg["ppo"])
        model.learn(total_timesteps=total, callback=progress_callback(max(total // 20, 1), checkpoint, checkpoints, total, seed))
        minutes = (time.time() - started) / 60
        log(f"seed {seed}: trained {total:,} steps in {minutes:.1f} min ({total / max(minutes * 60, 1e-9):,.0f} steps/s)")
        runlog.event("seed_trained", seed=seed, total=total, minutes=minutes)
        venv.training = False
        network = export_network(model, venv)
        seed_dir = out_dir / "seeds"
        seed_dir.mkdir(parents=True, exist_ok=True)
        model.save(seed_dir / f"seed_{seed}.zip")
        venv.save(str(seed_dir / f"seed_{seed}_vecnormalize.pkl"))
        (seed_dir / f"seed_{seed}_network.json").write_text(json.dumps(network))
        # The exported network must act as the trained model does.
        sample = collect_observations(cfg, w["train"], seed)
        if not sample[0]:
            raise RuntimeError(f"seed {seed}: no decisions to check the exported network against")
        bad = check_export(model, venv, network, *sample)
        # float32 (torch) vs float64 (harness) can split an exact tie, nothing more.
        if bad > len(sample[0]) // 1000:
            raise RuntimeError(f"seed {seed}: the exported network disagrees with the model on {bad}/{len(sample[0])} observations")
    finally:
        venv.close()
    return network


def collect_observations(cfg, window, seed, episodes=8):
    """Observations and masks from a few attempts (random actions), for the export check."""
    from .env import ChallengeEnv

    env = ChallengeEnv(str(cfg["_path"]), window, seed=seed + 7)
    rng = np.random.default_rng(seed)
    obs, masks = [], []
    try:
        for _ in range(episodes):
            o, _ = env.reset()
            done = False
            while not done and len(obs) < 4000:
                m = env.action_masks()
                obs.append(o)
                masks.append(m)
                a = int(rng.choice(np.flatnonzero(m)))
                o, _, term, trunc, _ = env.step(a)
                done = term or trunc
    finally:
        env.close()
    return obs, masks


def pct(x):
    return "-" if x is None else f"{round(x * 1000) / 10}%"


def rfmt(x, sign=False):
    return "-" if x is None else (f"{x:+.2f}R" if sign else f"{x:.2f}R")


def results_line(r):
    """An evaluation in one line: pass, blow, and win rate, average win and loss R, expectancy, profit, trades."""
    return (f"{r.get('attempts')} attempts: pass {pct(r.get('passRate'))}, blow {pct(r.get('blowRate'))}, win {pct(r.get('winRate'))}, "
            f"avg winR {rfmt(r.get('avgWinR'))}, avg lossR {rfmt(r.get('avgLossR'))}, expectancy {rfmt(r.get('expectancyR'), True)}, "
            f"avg profit ${r.get('avgProfit')}, trades/attempt {r.get('tradesPerAttempt')}")


def report_md(b):
    def row(label, r):
        return (f"| {label} | {r['attempts']} | {pct(r['passRate'])} | {pct(r.get('winRate'))} | {rfmt(r.get('avgWinR'))} | {rfmt(r.get('avgLossR'))} | "
                f"{rfmt(r.get('expectancyR'), True)} | {pct(r['blowRate'])} | "
                f"{r['medianDaysToPass'] if r['medianDaysToPass'] is not None else '-'} | {r['avgProfit']} | {r['tradesPerAttempt']} |")

    gate = b["gate"]
    lines = [
        f"# Policy {b['name']}",
        "",
        f"{'VALIDATED' if b['validated'] else 'NOT VALIDATED'}: account {b['account']}, strategies {', '.join(b['strategies'])}, "
        f"{b['symbol']} {b['timeframe']}m, seed {b['training']['chosenSeed']}.",
        "",
        f"Gate: zero blows in every out-of-sample month and a pass rate of at least {pct(gate['minPassRate'])}"
        + (f", a win rate of at least {pct(gate['minWinRate'])}." if gate.get("minWinRate") else "."),
    ]
    if b["gateFailures"]:
        lines += ["", "Failed:", ""] + [f"- {f}" for f in b["gateFailures"]]
    lines += [
        "",
        "| Window | Attempts | Pass | Win rate | Avg win R | Avg loss R | Expectancy | Blow | Median days to pass | Avg profit $ | Trades/attempt |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
        row("Selection (policy)", b["selection"]),
        row("Out of sample (policy)", b["oos"]),
        row("Out of sample (rules only)", b["baseline"]),
        "",
        "## Seeds (selection window)",
        "",
        "| Seed | Attempts | Pass | Win rate | Blow | Avg profit $ |",
        "|---|---|---|---|---|---|",
    ]
    lines += [f"| {s['seed']} | {s['selection']['attempts']} | {pct(s['selection']['passRate'])} | {pct(s['selection'].get('winRate'))} | {pct(s['selection']['blowRate'])} | {s['selection']['avgProfit']} |" for s in b["seedsReport"]]
    lines += ["", "## Out of sample by month", "", "| Month | Attempts | Pass | Blow | Rules-only pass | Rules-only blow |", "|---|---|---|---|---|---|"]
    for m, r in b["oos"]["months"].items():
        base = b["baseline"]["months"].get(m, {})
        lines.append(f"| {m} | {r['attempts']} | {pct(r['passRate'])} | {pct(r['blowRate'])} | {pct(base.get('passRate'))} | {pct(base.get('blowRate'))} |")
    return "\n".join(lines) + "\n"


def evaluate_oos(server, cfg, network):
    """The out-of-sample evaluation (policy and rules-only baseline) and the gate.
    The only place the out-of-sample window is evaluated."""
    w = cfg["_windows"]
    oos_starts = server.starts(w["oos"], cfg["eval_every"])
    if not oos_starts:
        raise ValueError("the out-of-sample window needs room for at least one attempt")
    baseline = server.evaluate(oos_starts, w["oos"][1], None)
    oos = server.evaluate(oos_starts, w["oos"][1], network)
    fails = gate_failures(oos, cfg["min_pass_rate"], cfg["min_win_rate"])
    log(f"out of sample, policy: {results_line(oos)}")
    log(f"out of sample, rules only: {results_line(baseline)}")
    log(f"out of sample: {'VALIDATED' if not fails else 'not validated: ' + '; '.join(fails)}")
    runlog.event("evaluation", window="oos", policy=oos, baseline=baseline, gateFailures=fails, validated=not fails)
    for m, r in oos.get("months", {}).items():
        log(f"  oos {m}: {results_line(r)}")
    return oos, baseline, fails


def log_oos_look(out_dir, family, seed, oos, info, cfg):
    """Log an out-of-sample evaluation, in out_dir and harness-wide; returns how
    many looks this policy strategy has had at this window of this data, across
    families and one-shot runs."""
    key = {"strategy": info["strategy"], "oos": cfg["windows"]["oos"], "data": sorted(d["sha256"] or d["file"] for d in info["data"])}
    line = json.dumps({"at": dt.datetime.now(dt.timezone.utc).isoformat(), "family": family, "seed": seed,
                       "passRate": oos["passRate"], "blown": oos["blown"], "attempts": oos["attempts"], **key}) + "\n"
    shared = harness_home() / "rl" / "oos_looks.jsonl"
    prior = 0
    if shared.exists():
        for row in shared.read_text().splitlines():
            try:
                r = json.loads(row)
            except json.JSONDecodeError:
                continue
            prior += all(r.get(k) == v for k, v in key.items())
    for f in (Path(out_dir) / "oos_log.jsonl", shared):
        f.parent.mkdir(parents=True, exist_ok=True)
        with f.open("a") as fh:
            fh.write(line)
    return prior + 1


def build_bundle(name, cfg, info, best, seeds_report, oos, baseline, fails, extra_training=None):
    return {
        "format": info["bundleFormat"],
        "version": info["bundleVersion"],
        "name": name,
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "strategy": info["strategy"],
        "components": info["components"],
        "account": info["account"],
        "strategies": info["strategies"],
        "contracts": info["contracts"],
        "exit": info["exit"],
        "engine": info["engine"],
        "symbol": info["symbol"],
        "timeframe": info["timeframe"],
        "sizing": info["sizing"],
        "data": info["data"],
        "obsFields": info["obsFields"],
        "actions": info["actions"],
        "network": best["network"],
        "gate": {"minPassRate": max(MIN_PASS_RATE, cfg["min_pass_rate"]), "maxBlows": 0, "minWinRate": cfg["min_win_rate"]},
        "training": {
            "trainer": "sb3-contrib MaskablePPO",
            "seeds": cfg["seeds"],
            "chosenSeed": best["seed"],
            "totalTimesteps": cfg["total_timesteps"],
            "nEnvs": cfg["n_envs"],
            "hidden": cfg["hidden"],
            "ppo": cfg["ppo"],
            "normalizeReward": cfg["normalize_reward"],
            "reward": info["reward"],
            "windows": cfg["windows"],
            "evalEvery": cfg["eval_every"],
            **(extra_training or {}),
        },
        "seedsReport": seeds_report,
        "selection": best["selection"],
        "oos": oos,
        "baseline": baseline,
        "validated": not fails,
        "gateFailures": fails,
    }


def write_bundle(out_dir, name, bundle):
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = out_dir / f".{name}.json.tmp"
    tmp.write_text(json.dumps(bundle, indent=1) + "\n")
    tmp.replace(out_dir / f"{name}.json")
    (out_dir / "report.md").write_text(report_md(bundle))


def promote(out_dir, name, models_dir):
    """Copy a written, validated bundle into models_dir (atomically)."""
    dest = Path(models_dir) / f"{name}.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.parent / f".{name}.json.tmp"
    shutil.copyfile(out_dir / f"{name}.json", tmp)
    tmp.replace(dest)
    return dest


def server_info(server):
    info = server.info()
    a = info["accountProfile"]
    log(f"{info['strategy']} ({', '.join(info['components'])}; contracts {info['contracts']}) on {info['symbol']} {info['timeframe']}m, account {info['account']} "
        f"(target ${a['profit_target']}, max loss ${a['max_loss']}, daily limit ${a.get('daily_loss_limit', 0)}), {info['days']} trading days")
    return info


def train(cfg, out_dir):
    """One shot: train every seed, select on the selection window, validate out of sample."""
    w = cfg["_windows"]
    with EnvServer(cfg["_path"], hash_data=True) as server:
        info = server_info(server)
        select_starts = server.starts(w["select"], cfg["eval_every"])
        if not select_starts:
            raise ValueError("the selection window needs room for at least one attempt")
        best = None
        seeds_report = []
        for seed in cfg["seeds"]:
            log(f"seed {seed}: training on {cfg['windows']['train'][0]} .. {cfg['windows']['train'][1]}")
            network = train_seed(cfg, seed, out_dir)
            sel = server.evaluate(select_starts, w["select"][1], network)
            log(f"seed {seed} selection: {results_line(sel)}")
            runlog.event("evaluation", window="select", seed=seed, result=sel)
            seeds_report.append({"seed": seed, "selection": {k: v for k, v in sel.items() if k != "months"}})
            if best is None or rank(sel) < rank(best["selection"]):
                best = {"seed": seed, "network": network, "selection": sel}
        oos, baseline, fails = evaluate_oos(server, cfg, best["network"])
        looks = log_oos_look(out_dir, cfg["name"], best["seed"], oos, info, cfg)
        bundle = build_bundle(cfg["name"], cfg, info, best, seeds_report, oos, baseline, fails, {"oosLooks": looks})
        errors = server.check_bundle(bundle)
        if bundle["validated"] and errors:
            raise RuntimeError(f"the harness refuses the bundle: {'; '.join(errors)}")
    write_bundle(out_dir, cfg["name"], bundle)
    return bundle


def main(argv=None):
    p = argparse.ArgumentParser(description="Train a prop-challenge policy (MaskablePPO) for Markdown strategies.")
    p.add_argument("--config", required=True)
    p.add_argument("--quick", action="store_true", help="a tiny smoke run")
    p.add_argument("--promote", action="store_true", help="copy a validated bundle to models/<name>.json")
    p.add_argument("--out", help="output folder (default: <FTH_HOME>/policies/<name>)")
    p.add_argument("--models-dir", default=str(REPO_ROOT / "models"), help="where --promote copies the bundle (default: models/)")
    args = p.parse_args(argv)
    try:
        cfg = load_config(args.config, quick=args.quick)
    except (ValueError, OSError) as err:
        print(f"[train-policy] {err}", file=sys.stderr)
        return 1
    out_dir = Path(args.out or cfg.get("outDir") or harness_home() / "policies" / cfg["name"]).resolve()
    started = time.time()
    runlog.start(out_dir, "train", cfg, configFile=str(args.config), quick=args.quick)
    try:
        bundle = train(cfg, out_dir)
    except BaseException as err:
        runlog.failed(err)
        raise
    log(f"wrote {out_dir / (cfg['name'] + '.json')} and report.md ({(time.time() - started) / 60:.1f} min)")
    summary = {"validated": bundle["validated"], "chosenSeed": bundle["training"]["chosenSeed"], "gateFailures": bundle["gateFailures"],
               "oos": {k: bundle["oos"].get(k) for k in ("attempts", "passRate", "blowRate", "winRate")}}
    if args.promote:
        if not bundle["validated"]:
            log("not promoted: the bundle failed the gate (see report.md); zero blows and the pass rate are not waivable")
            runlog.finish("not_validated", **summary)
            return 2
        log(f"promoted to {promote(out_dir, cfg['name'], args.models_dir)}")
    runlog.finish("done", **summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
