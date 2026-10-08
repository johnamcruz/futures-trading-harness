"""Synthetic 3-minute MNQ bars and a training config around them (tests only)."""

import contextlib
import datetime as dt
import os
import json
import math
import random
from pathlib import Path


def write_bars(path, days=90, seed=5):
    """A seeded random walk with trending bursts, from Sunday 2026-01-04 18:00 ET, every 3 minutes."""
    r = random.Random(seed)
    t0 = dt.datetime(2026, 1, 4, 23, 0, tzinfo=dt.timezone.utc)
    px = 20000.0
    lines = ["time,open,high,low,close,volume"]
    for k in range(days * 1440 // 3):
        drift = math.sin(k / 90) * 0.8
        o = px
        c = round((px + drift + (r.random() - 0.5) * 6) * 4) / 4
        t = t0 + dt.timedelta(minutes=3 * k)
        lines.append(f"{t.strftime('%Y-%m-%dT%H:%M:%SZ')},{o},{max(o, c) + 1},{min(o, c) - 1},{c},100")
        px = c
    Path(path).write_text("\n".join(lines) + "\n")


REPO = Path(__file__).resolve().parents[2]


def write_account(folder):
    """A short challenge (5 sessions, $1,500 target, $1,000 max loss) in folder/accounts/mini; returns the accounts dir."""
    src = (REPO / "accounts" / "topstep_50k" / "ACCOUNT.md").read_text()
    head, body = src.split("\n---\n", 1)
    for old, new in [("name: topstep_50k", "name: mini"), ("profit_target: 3000", "profit_target: 1500"), ("max_loss: 2000", "max_loss: 1000"),
                     ("daily_loss_limit: 1000", "daily_loss_limit: 0"), ("daily_loss_soft: 500", "daily_loss_soft: 400"),
                     ("consistency_pct: 50", "consistency_pct: 0"), ("sessions: 30", "sessions: 5")]:
        assert old in head, old
        head = head.replace(old, new)
    d = Path(folder) / "accounts" / "mini"
    d.mkdir(parents=True, exist_ok=True)
    (d / "ACCOUNT.md").write_text(head + "\n---\n" + body)
    return d.parent


def write_strategy(folder):
    """ema_cross with a wide give-back (ema_wide), and prop_test: a policy strategy trading it on the mini account."""
    src = (REPO / "strategies" / "ema_cross" / "STRATEGY.md").read_text()
    for old, new in [("name: ema_cross", "name: ema_wide"), ("trail_giveback_r: 0.5", "trail_giveback_r: 2")]:
        assert old in src, old
        src = src.replace(old, new)
    d = Path(folder) / "strategies" / "ema_wide"
    d.mkdir(parents=True, exist_ok=True)
    (d / "STRATEGY.md").write_text(src)
    prop = (REPO / "strategies" / "prop_portfolio_3m" / "STRATEGY.md").read_text()
    head, body = prop.split("\n---\n", 1)
    lines = []
    for line in head.splitlines():
        if line.startswith("name:"):
            line = "name: prop_test"
        elif line.startswith("strategies:"):
            line = "strategies: [ema_wide]"
        elif line.startswith("account:"):
            line = "account: mini"
        elif line.startswith("  trail_giveback_r:"):
            line = "  trail_giveback_r: 2"
        lines.append(line)
    d = Path(folder) / "strategies" / "prop_test"
    d.mkdir(parents=True, exist_ok=True)
    (d / "STRATEGY.md").write_text("\n".join(lines) + "\n---\n" + body.replace("prop_portfolio_3m", "prop_test"))
    return d.parent


def write_config(folder, **extra):
    """Bars, the mini account, the ema_wide strategy, and a training config.
    Returns (config path, the environment variables that find the account and strategy)."""
    folder = Path(folder)
    write_bars(folder / "MNQ_3min.csv")
    env = {"FTH_ACCOUNTS_DIRS": str(write_account(folder)), "FTH_STRATEGIES_DIRS": str(write_strategy(folder))}
    cfg = {
        "name": "synthetic_policy",
        "strategy": "prop_test",
        "symbol": "MNQ",
        "data": {"MNQ": "MNQ_3min.csv"},
        "windows": {"train": ["2026-01-05", "2026-02-20"], "select": ["2026-02-20", "2026-03-10"], "oos": ["2026-03-10", "2026-04-04"]},
        **extra,
    }
    path = folder / "config.json"
    path.write_text(json.dumps(cfg, indent=1))
    return path, env


@contextlib.contextmanager
def environ(values):
    old = {k: os.environ.get(k) for k in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
