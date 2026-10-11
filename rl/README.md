# rl: prop-challenge policy training

Trains the policy of a policy strategy (`signal: policy`, e.g.
`strategies/prop_portfolio`): across every strategy it lists, which setups
to take, at what size in micros or minis, and when to bank a trade past the
ratchet, to pass its prop account. See [docs/RL-DESIGN.md](../docs/RL-DESIGN.md).

```bash
pip install -r rl/requirements.txt          # Python 3.10+, CPU is enough

# The pipeline: one JSON config per stage per family (rl/configs/{sweep,retrain,ship}/<family>.json)
python rl/sweep.py   --config rl/configs/sweep/prop_portfolio_topstep_100k_v1.json --dry-run   # validate, count attempts per window
python rl/sweep.py   --config rl/configs/sweep/prop_portfolio_topstep_100k_v1.json             # Optuna on the selection window
python rl/retrain.py --config rl/configs/retrain/prop_portfolio_topstep_100k_v1.json           # best trial, more seeds (resumable)
python rl/ship.py    --config rl/configs/ship/prop_portfolio_topstep_100k_v1.json --dry-run    # pick the seed; out of sample not touched
python rl/ship.py    --config rl/configs/ship/prop_portfolio_topstep_100k_v1.json              # out of sample once; promote if it passes

# One shot, no sweep (train every seed, select, validate; --promote copies a bundle that passes)
python rl/train_policy.py --config rl/configs/prop_portfolio_topstep_100k.json --quick

python -m unittest discover -s rl/tests -t rl                                             # tests (also run by npm test)
```

## Config family

- `sweep/<family>.json`: a full training config (`name` = the family,
  `strategy` = the policy strategy, `symbols` = the data's micros (several
  markets trained at once on one shared account, e.g.
  `["MNQ", "MES", "MYM", "M2K"]`; `symbol` names one), `data` a file per
  symbol relative to the file, `windows` train / select / oos, `eval_every`, `seeds`,
  `total_timesteps`, `n_envs`, `hidden`, `ppo`, `reward`, optional `sizing`
  and `contracts` overrides, optional `out_dir`) plus:
  - `study`: `n_trials`, `n_jobs`, `sampler` (tpe | random), `seed`, `pruner`
    (median | none), `checkpoints`, `warmup_checkpoints`,
    `min_trades_per_attempt`, `win_rate_weight` (a feasible trial scores pass
    rate + this × win rate; 0.5), optional `storage` (default
    `<out>/sweep/study.db`);
  - `search_space.searched`: dotted keys to search, e.g.
    `"ppo.learning_rate": {"type": "float", "low": 3e-5, "high": 1e-3, "log": true}`,
    `"reward.blow": {"type": "categorical", "choices": [20, 30, 50]}`,
    `"hidden": {"type": "categorical", "choices": [[64, 64], [128, 128]]}`;
  - `search_space.anchored`: dotted keys fixed for every trial.
  Only `ppo.<key>`, `reward.<key>`, `sizing.<key>`, `contracts`, `hidden`,
  `total_timesteps`, `normalize_reward`, and `clip_obs` can be searched or
  anchored. Each end of every range is checked before the first trial. The
  account, strategies, timeframe, and exit come from the policy strategy's
  STRATEGY.md.
- `retrain/<family>.json`: `sweep`, `trial` (`"best"` or a number), `seeds`,
  `total_timesteps`, `n_envs`.
- `ship/<family>.json`: `retrain`, `bundle`, `min_pass_rate` (0.4 or more),
  `min_win_rate` (0 = no win-rate floor),
  optional `models_dir`.

Outputs go to `<out>` = the sweep's `out_dir`, else `<FTH_HOME>/rl/<family>`:
`sweep/` (study, trials), `retrain/` (seeds, `candidates.json` with the config
they were trained with), `ship/` (bundle, `report.md`, `oos_log.jsonl`).
Every stage also writes `logs/`: `<stage>.log` (every line, timestamped:
progress per seed with steps/s, ETA, pass / blow / timeout, win rate, trades,
profit, episode reward, and PPO internals), `<stage>.jsonl` (every training
attempt, progress line, evaluation, and trial with its params, score, and
state, and why it was infeasible, pruned, or failed), and a run manifest
(`run.json` or `<stage>.run.json`: config, git commit, versions, status).
Each trial also keeps `trial_NNN/train.log` and `summary.json`. A
study is bound to its strategy, markets, data, and windows and won't resume
after they change; a study, its retrained seeds (`candidates.json` `env`), and
ship are also bound to the env the strategy document sets (its strategies,
account, markets, timeframe) and refuse to go on after it changes; out-of-sample looks are also counted harness-wide in
`<FTH_HOME>/rl/oos_looks.jsonl`.

## Several markets, one account

With `symbols`, every market's bars run on one timeline against one combine:
one balance, trailing floor, and daily limit. The account trades one position
at a time across all of them, as the live gate enforces (the gateway's
`prop-one-position` check, and the hook's refusal of an entry once another
went in since the last account snapshot): a setup on one market waits while
another's trade is open or filling, so each trade is sized from the whole
cushion and a stopped trade never reaches the floor or the daily limit. Two
markets firing on one bar: the first in `symbols` order is asked first. The
trading days are every market's. The bundle records `symbols`, and live
trading refuses it on an index it wasn't trained on. The shipped family trains
NQ, ES, YM, and RTY minis (`"contracts": "mini"` anchored in the sweep; the
strategy document stays `contracts: auto`, and the bundle trades once the
document says `mini`, as ship prints). Four markets of five years of 1-minute
data are heavy: each env server (one per `n_envs`, plus one for evaluation)
takes about two minutes to load, about five more on its first attempt
(computing every strategy's series), then about 5 s per 30-session attempt,
and needs about 7 GB of V8 heap (the bridge starts it with
`--max-old-space-size` = `FTH_NODE_HEAP_MB`, 8192 by default; Node's own 4 GB
limit aborts it mid-training). The shipped family uses `n_envs: 2` so a
32 GB machine holds the three servers.

## Modules

- `fth_rl/bridge.py`: runs `node scripts/rl-env-server.js` (the harness's
  backtester as an env) and talks to it one JSON line per request.
- `fth_rl/env.py`: the gymnasium env with action masks.
- `fth_rl/train.py`: MaskablePPO per seed, the out-of-sample evaluation, the
  bundle; the one-shot `train_policy.py`.
- `fth_rl/pipeline.py`: sweep, retrain, ship.
- `fth_rl/export.py`: the trained network and its VecNormalize statistics in
  the harness's bundle format, with a numpy forward pass that matches
  `scripts/lib/rl/policy-net.js`.
- `fth_rl/config.py`: the training config, its defaults (the 100K combine),
  and the gate: zero blows in every out-of-sample month and a pass rate of at
  least 40% over 20+ attempts and 2+ months. The pass rate can be raised,
  never lowered; blows can't be allowed.

Set `FTH_NODE` if `node` is not on the PATH, and `FTH_TORCH_THREADS`
(default 1) for torch threads per training process. Accounts and strategies outside
the repo: `FTH_ACCOUNTS_DIRS`, `FTH_STRATEGIES_DIRS`.
