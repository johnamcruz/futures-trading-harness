"""Training config (rl/configs/*.json): the env (read by the Node server) plus
the training settings (read here). Defaults: the 100k combine, three seeds,
and the promotion gate of 40% pass with zero blows."""

import datetime as dt
import json
import re
from pathlib import Path

NAME = re.compile(r"^[a-z0-9][a-z0-9_.-]*$")
MIN_PASS_RATE = 0.40  # the floor; a config may only raise it
MIN_OOS_ATTEMPTS = 20  # policy-bundle.js PROMOTION_GATE.minAttempts
MIN_OOS_MONTHS = 2  # policy-bundle.js PROMOTION_GATE.minMonths

REWARD_KEYS = ("pass", "speed", "blow", "timeout", "dense", "win", "loss")  # challenge-env.js DEFAULT_REWARD
SIZING_KEYS = ("cushion_frac", "cap_usd", "clock_k", "r_per_session", "min_size_guard", "drawdown_halve_usd")  # combine.js DEFAULT_SIZING

PPO_DEFAULTS = {
    "learning_rate": 3e-4,
    "n_steps": 1024,
    "batch_size": 256,
    "n_epochs": 10,
    # An attempt can hold hundreds of decisions: 0.999 keeps the pass / blow
    # outcome visible from the first ones (0.99**300 is 0.05).
    "gamma": 0.999,
    "gae_lambda": 0.95,
    "clip_range": 0.2,
    "ent_coef": 0.01,
    "vf_coef": 0.5,
    "max_grad_norm": 0.5,
}


CONTRACT_MODES = ("micro", "mini", "auto")  # combine.js CONTRACT_MODES

DEFAULTS = {
    "seeds": [1, 2, 3],
    "total_timesteps": 300_000,
    "n_envs": 4,
    "hidden": [64, 64],
    "normalize_reward": True,
    "clip_obs": 10.0,
    "eval_every": 1,
    "min_pass_rate": MIN_PASS_RATE,
    "min_win_rate": 0.0,  # optional: out of sample, winning trades / trades at least this
    "ppo": {},
}

QUICK = {"seeds": [1], "total_timesteps": 2048, "n_envs": 2, "ppo": {"n_steps": 256, "batch_size": 64, "n_epochs": 2}}


def day_ms(value, name):
    s = str(value)
    try:
        d = dt.datetime.fromisoformat(s if "T" in s else f"{s}T00:00:00+00:00")
    except ValueError as err:
        raise ValueError(f'{name}: an ISO date, e.g. "2024-01-01"') from err
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return int(d.timestamp() * 1000)


def windows_of(cfg):
    """train < select < oos, without overlap: never tune or select on evaluated rows."""
    w = cfg.get("windows") or {}
    out = {}
    for k in ("train", "select", "oos"):
        pair = w.get(k)
        if not isinstance(pair, list) or len(pair) != 2:
            raise ValueError(f"windows.{k}: [from, to] dates")
        out[k] = [day_ms(pair[0], f"windows.{k}[0]"), day_ms(pair[1], f"windows.{k}[1]")]
        if not out[k][1] > out[k][0]:
            raise ValueError(f'windows.{k}: "to" must be after "from"')
    if not (out["train"][1] <= out["select"][0] and out["select"][1] <= out["oos"][0]):
        raise ValueError("windows: train, then select, then oos, without overlap (never tune or select on evaluated rows)")
    return out


def load_config(path, quick=False):
    path = Path(path).resolve()
    raw = json.loads(path.read_text())
    cfg = {**DEFAULTS, **raw}
    cfg["ppo"] = {**PPO_DEFAULTS, **(raw.get("ppo") or {})}
    if quick:
        cfg.update({k: v for k, v in QUICK.items() if k != "ppo"})
        cfg["ppo"].update(QUICK["ppo"])
    errors = []
    if not NAME.match(str(cfg.get("name", ""))):
        errors.append("name: lowercase letters, digits, _ . -")
    if not NAME.match(str(cfg.get("strategy", ""))):
        errors.append("strategy: the policy strategy to train (strategies/<name>/STRATEGY.md, signal: policy), e.g. prop_portfolio_3m")
    for k in ("account", "strategies"):
        if k in raw:
            errors.append(f"{k}: comes from the policy strategy's STRATEGY.md (ECC: the strategy document is the source)")
    if "contracts" in cfg and cfg["contracts"] not in CONTRACT_MODES:
        errors.append(f"contracts: {' | '.join(CONTRACT_MODES)}")
    if not (isinstance(cfg["seeds"], list) and cfg["seeds"] and all(isinstance(s, int) and s >= 0 for s in cfg["seeds"])):
        errors.append("seeds: a list of whole numbers")
    for k in ("total_timesteps", "n_envs", "eval_every"):
        if not (isinstance(cfg[k], int) and cfg[k] > 0):
            errors.append(f"{k}: a positive whole number")
    if not (isinstance(cfg["hidden"], list) and cfg["hidden"] and all(isinstance(h, int) and h > 0 for h in cfg["hidden"])):
        errors.append("hidden: layer widths, e.g. [64, 64]")
    if not (isinstance(cfg["min_pass_rate"], (int, float)) and MIN_PASS_RATE <= cfg["min_pass_rate"] <= 1):
        errors.append(f"min_pass_rate: {MIN_PASS_RATE} to 1 (the gate may be raised, never lowered)")
    if not (isinstance(cfg["min_win_rate"], (int, float)) and 0 <= cfg["min_win_rate"] <= 1):
        errors.append("min_win_rate: 0 to 1 (0 = no win-rate gate)")
    if "max_blows" in raw or "allow_blows" in raw:
        errors.append("max_blows: not configurable; zero blows in every out-of-sample month is the rule")
    for block, keys in (("reward", REWARD_KEYS), ("sizing", SIZING_KEYS)):
        v = cfg.get(block)
        if v is None:
            continue
        if not isinstance(v, dict) or not all(isinstance(x, (int, float)) and not isinstance(x, bool) and x >= 0 for x in v.values()):
            errors.append(f"{block}: a map of numbers, 0 or more")
        elif set(v) - set(keys):
            errors.append(f"{block}: unknown keys {sorted(set(v) - set(keys))} (allowed: {list(keys)})")
    r = {"pass": 10, "speed": 3, "blow": 30, **(cfg.get("reward") or {})}
    if isinstance(r.get("blow"), (int, float)) and isinstance(r.get("pass"), (int, float)) and isinstance(r.get("speed"), (int, float)) and not r["blow"] > r["pass"] + r["speed"]:
        errors.append("reward.blow: must exceed reward.pass + reward.speed (never blow outranks passing, even fast)")
    if isinstance(cfg.get("sizing"), dict) and (cfg["sizing"].get("cushion_frac") or 0) > 1:
        errors.append("sizing.cushion_frac: at most 1 (a trade never risks more than the whole cushion)")
    if cfg.get("gate", True) is not True:
        errors.append("gate: training always runs the harness rules (gate: true)")
    unknown = set(cfg["ppo"]) - set(PPO_DEFAULTS)
    if unknown:
        errors.append(f"ppo: unknown keys {sorted(unknown)} (allowed: {sorted(PPO_DEFAULTS)})")
    try:
        cfg["_windows"] = windows_of(cfg)
    except ValueError as err:
        errors.append(str(err))
    if errors:
        raise ValueError("invalid training config:\n- " + "\n- ".join(errors))
    cfg["_path"] = path
    return cfg


def gate_failures(oos, min_pass_rate=MIN_PASS_RATE, min_win_rate=0.0):
    """Mirror of policy-bundle.js gateFailures (the harness re-checks the bundle)."""

    def whole(x):
        return isinstance(x, int) and not isinstance(x, bool) and x >= 0

    if not isinstance(oos, dict) or not all(whole(oos.get(k)) for k in ("attempts", "passed", "blown")) or not isinstance(oos.get("months"), dict):
        return ["the out-of-sample result is missing or malformed"]
    out = []
    months = oos["months"]
    if oos["attempts"] < MIN_OOS_ATTEMPTS or len(months) < MIN_OOS_MONTHS:
        out.append(f"too small an out-of-sample test ({oos['attempts']} attempts over {len(months)} month(s); at least {MIN_OOS_ATTEMPTS} over {MIN_OOS_MONTHS})")
    if any(not isinstance(m, dict) or not whole(m.get("blown")) for m in months.values()):
        out.append("a month of the out-of-sample result has no blow count")
    blown_months = [k for k, m in months.items() if isinstance(m, dict) and (m.get("blown") or 0) > 0]
    if oos["blown"] > 0 or blown_months:
        where = f" in {', '.join(blown_months)}" if blown_months else ""
        out.append(f"blows out of sample ({oos['blown']}{where}); zero blows is the rule")
    floor = max(MIN_PASS_RATE, min_pass_rate or 0)
    rate = oos["passed"] / oos["attempts"] if oos["attempts"] else 0.0
    if not rate >= floor:
        out.append(f"pass rate {int(rate * 1000) / 1000} ({oos['passed']}/{oos['attempts']}) is under {floor}")
    if min_win_rate and min_win_rate > 0:
        ok = whole(oos.get("trades")) and whole(oos.get("wins")) and oos["trades"] > 0
        win = oos["wins"] / oos["trades"] if ok else None
        if win is None or not win >= min_win_rate:
            out.append(f"win rate {'unknown' if win is None else int(win * 1000) / 1000} is under {min_win_rate}")
    return out
