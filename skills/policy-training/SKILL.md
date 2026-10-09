---
name: policy-training
description: Train, sweep, validate, and ship the policy of a policy strategy (a strategy with signal policy) - MaskablePPO in Python on the harness's own backtester, Optuna sweep -> retrain -> ship from JSON config families - that learns which of its strategies' setups to take, at what size in micros or minis, and when to bank a trade past the ratchet. Use when the user wants a strategy to pass combines with a trained policy, wants a hyperparameter sweep, or asks how a policy was validated.
---

# Policy Training

## When to Use

- The user wants a policy strategy (`strategies/prop_portfolio_3m`, or a new
  one over other strategies) to pass a prop account with a trained policy,
  or a sweep for better settings.
- A policy needs retraining: the observation changed (the bundle is refused
  as "trained on a different observation"), or the policy strategy's
  strategies, account, sizing, or contract mode changed (the bundle is
  refused as trained for another).
- The user asks why a bundle is or isn't validated.

## How It Works

One policy learns across all the strategies its policy strategy lists: it
sees which one fired (one observation field per strategy), the account, the
setup's risk and whether it trades micros or minis, and the market. The
policy never picks the side; the strategy's rules do. Its setups are the
scan's candidates, so the multi-timeframe trend rule already applies: a
trend strategy's counter-trend signal is never a setup, in training or live. At each setup it picks
skip, half, or full size (full = the account's size budget for the stop, in
micros or minis by `contracts`); in a trade past the ratchet
(`exit.trail_activate_r`) it picks hold or close. It is scored on passing the
challenge with a high pass rate and a high win rate: reaching the target
without touching the trailing max-loss floor, rewarded for each winning trade
and penalized for each losing one, and swept on pass rate plus win rate.

The policy strategy's STRATEGY.md is the source of truth: the training config
names it (`"strategy": "prop_portfolio_3m"`) and takes its strategies,
account, sizing, contract mode, and exit from it. A sweep may try other
`sizing.*` or `contracts`; the shipped bundle then trades only once the
document says the same (ship prints the lines).

1. **Install** (once, Python 3.10+): `pip install -r rl/requirements.txt`.
   Node runs the env (the harness's backtester); Python trains (`rl/fth_rl`).
2. **Config family**: copy the three files of
   `rl/configs/{sweep,retrain,ship}/prop_portfolio_3m_topstep_100k_v1.json` to a new
   family name. The sweep file names the policy strategy (`strategy`), the
   data's symbol (the micro, e.g. MNQ: micros and minis share its bars) and
   file, the windows (train, then select, then out of sample, never
   overlapping), the training settings, `study`, and `search_space`
   (`searched`, `anchored`). See `rl/README.md`.
3. **Dry run first**: `python rl/sweep.py --config <sweep> --dry-run` checks
   the config and counts attempt starts per window.
4. **Sweep**: `python rl/sweep.py --config <sweep>`. Trials are scored on the
   selection window; any blow makes a trial infeasible. Resumable.
5. **Retrain**: `python rl/retrain.py --config <retrain>`: the best feasible
   trial with more seeds and steps. Resumable.
6. **Ship** (the dry run any time; the real run only with the user's
   explicit go-ahead, since it spends the out-of-sample look and promotes into
   `models/`, which live policy strategies load; without one, add
   `--models-dir <staging folder>`): `python rl/ship.py --config <ship> --dry-run`
   picks the seed and shows its config without looking at the out-of-sample
   window. `python rl/ship.py --config <ship>` then evaluates it once, month
   by month, next to the rules-only baseline, writes the bundle and
   `report.md`, and promotes it to `models/<bundle>.json` only if it passes
   the gate: zero blows in every month, no exceptions, and a pass rate of at
   least 40% over at least 20 attempts and 2 months, plus a win-rate floor
   if `min_win_rate` is set (`min_pass_rate` may
   raise it, never lower it). One that fails is never promoted.
7. **Trade it**: the policy strategy names the bundle (`policy: { bundle }`)
   with the sizing and contract mode it was trained with (ship prints them)
   and keeps `status: paper` until the user activates it.
8. **Research**: `node scripts/backtest.js --config <file> --prop <policy strategy> [--bundle <name>]`
   evaluates any bundle, validated or not, over attempts in a backtest.

Never tune, select, or retrain on the out-of-sample window. Each ship
evaluation is logged, per family and harness-wide (`<FTH_HOME>/rl/oos_looks.jsonl`,
by policy strategy, data, and window); the bundle records how many looks there
were. Report it, and treat a policy shipped after several looks with suspicion.

## Examples

```text
$ python rl/ship.py --config rl/configs/ship/prop_portfolio_3m_topstep_100k_v1.json
[train-policy] ship prop_portfolio_3m_topstep_100k: seed 4 of 6 (selection pass 46.2%, blow 0)
[train-policy] out of sample: policy pass 43.0% blow 0.0%; rules only pass 21.0% blow 9.0%; VALIDATED
[train-policy] promoted to models/prop_portfolio_3m_topstep_100k.json
```

Report to the user: the out-of-sample pass and blow rates by month next to the
baseline, the trial and seed chosen, the number of out-of-sample looks, and
the report path. Ask before promoting.
