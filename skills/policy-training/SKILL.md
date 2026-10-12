---
name: policy-training
description: Train, sweep, validate, and ship the policy of a policy strategy (a strategy with signal policy) - MaskablePPO in Python on the harness's own backtester, Optuna sweep -> retrain -> ship from JSON config families - that learns which of its strategies' setups to take, at what size in micros or minis, and when to bank a trade past the ratchet. Use when the user wants a strategy to pass combines with a trained policy, wants a hyperparameter sweep, or asks how a policy was validated.
---

# Policy Training

## When to Use

- The user wants a policy strategy (`strategies/prop_portfolio`, or a new
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
names it (`"strategy": "prop_portfolio"`) and takes its strategies,
account, timeframe, sizing, contract mode, and exit from it. A config may
train other `sizing.*` or `contracts` (the shipped `prop_portfolio` family
anchors `"contracts": "mini"` while the document stays `contracts: auto`, so
it can still trade micros); the shipped bundle then trades only once the
document says the same (ship prints the lines; the harness refuses a bundle
whose contract mode, sizing, or timeframe differs from the document's).

**Several markets, one account.** A config's `symbols` (e.g.
`["MNQ", "MES", "MYM", "M2K"]`, each keyed in `data`; `symbol` still names
one) trains one policy on all of them at once against one prop account, as a
real combine runs: one timeline of every market's bars, one balance, one
trailing floor, one daily limit. Each root must be one the policy strategy
trades (by its micro/mini family), once per index, and traded by its
strategies (by family too: key the data by the micro or the mini, which share
prices). The account
trades one position at a time across all markets, in training, backtests,
and live (the gate refuses an entry while any position is open or an entry
went in since the last account snapshot), so every trade is sized from the
whole cushion and a stopped trade never reaches the floor or the daily
limit. When two markets fire on one bar, training takes the first in
`symbols` order (if the policy skips it, the next is asked); live, the first
entry placed wins and the gate refuses the other. The bundle records its
`symbols`; live trading refuses it on an index it wasn't trained on (a
bundle trained on MNQ alone still refuses ES). The observation has no
market field: its inputs are scaled to the account and to each market's ATR.
Four markets of 1-minute data need about 7 GB of heap per env server
(`FTH_NODE_HEAP_MB`, 8192 by default) and run about 5 s per attempt; keep
`n_envs` small (the shipped family uses 2).

**Timeframe.** The policy strategy's `timeframe` is the one bar-size
setting: training uses it, the bundle is bound to it (live refuses a bundle
trained on other bars), and every strategy it lists must trade it (they are
not re-run on other bars: a 3-minute strategy's periods and stops on
1-minute bars would be another strategy). A family is bound to the env it
trained in (strategies, account, markets, timeframe): a study, its retrained
seeds, and ship refuse to continue after the document changes ("trained on
another env"): start a new family.

1. **Install** (once, Python 3.10+): `pip install -r rl/requirements.txt`.
   Node runs the env (the harness's backtester); Python trains (`rl/fth_rl`).
2. **Config family**: copy the three files of
   `rl/configs/{sweep,retrain,ship}/prop_portfolio_topstep_100k_v1.json` to a new
   family name. The sweep file names the policy strategy (`strategy`), the
   data's markets (`symbols`, the micros, e.g. MNQ: micros and minis share
   their bars) and a file for each (`data`), the windows (train, then select, then out of sample, never
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

Training fills as live: entries at the next bar's open, with at least the
backtester's 1 tick of slippage per market fill (a config's `slippageTicks`
may raise it, never lower it). Live trading refuses a bundle trained on
cheaper fills (`engine: trained with 0 tick(s) of slippage, under the 1 of
live fills; retrain it`): retrain it, never edit the bundle. Retrain records
the simulator its seeds were trained in, and retrain and ship refuse seeds
from another one ("another simulator": move `candidates.json` aside and
retrain); a sweep study made under other fills doesn't resume (start a new
family).

Never tune, select, or retrain on the out-of-sample window. Each ship
evaluation is logged, per family and harness-wide (`<FTH_HOME>/rl/oos_looks.jsonl`,
by policy strategy, data, and window); the bundle records how many looks there
were. Report it, and treat a policy shipped after several looks with suspicion.

The policy learns from the rules strategies' simulated setups. To measure the
reasoning trader itself (the whole live harness, not a policy), use the
`replay` skill: it runs the live runner and harness over history on a replay
broker and reports month by month; its records are the labels a later student
policy would learn from. The same window
rules apply: don't choose a trader on the window you report it on.

A student policy learns from those labels through a dataset:
`node scripts/rl-dataset.js build <labelled run dir> ... --out <file.jsonl>`
(the `replay` skill, step 11) writes, outside the repository, one row per
cloneable teacher decision: the observation this harness builds live at that
time (the same code as the env and the live runner) and the teacher's action
(`--mode student`, the design's actions, or `--mode env`, today's), with
outcomes as targets only, and prints the rows, the actions, and what it
excluded by reason. The trainer reads it with `rl/fth_rl/dataset.py`, which
refuses a dataset built with another observation version (rebuild it).
Behaviour cloning on it is not built yet; build datasets only from the train
window's runs.

## Examples

```text
$ python rl/ship.py --config rl/configs/ship/prop_portfolio_topstep_100k_v1.json
[train-policy] ship prop_portfolio_topstep_100k: seed 4 of 6 (selection pass 46.2%, blow 0)
[train-policy] out of sample: policy pass 43.0% blow 0.0%; rules only pass 21.0% blow 9.0%; VALIDATED
[train-policy] promoted to models/prop_portfolio_topstep_100k.json
```

Report to the user: the out-of-sample pass and blow rates by month next to the
baseline, the trial and seed chosen, the number of out-of-sample looks, and
the report path. Ask before promoting.
