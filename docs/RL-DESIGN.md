# Prop-challenge RL

A policy that learns to pass prop-firm challenges (Topstep combines), trained
and run inside the harness, built on the harness's own pieces: Markdown
strategies, the backtester's broker logic, and the order gate.

## The idea

The prop challenge is a strategy. A **policy strategy** (`signal: policy`,
e.g. `strategies/prop_portfolio_3m/STRATEGY.md`) lists the rules strategies
whose setups it trades (every 3-minute strategy, in priority order), the
account profile, the sizing, the contract mode (micro, mini, or auto), and the
exit. Its rules strategies find setups and pick the side; one policy, trained
in a simulated challenge across all of them, decides:

- at each setup (the first of its strategies that fired on the bar), whether
  to take it, and at what size;
- in a trade, once it is past the ratchet (`exit.trail_activate_r`), whether to
  hold or close.

The size is worked out in micros from the account's cushion, then traded as
micros or minis (`contracts: auto` trades minis once the size reaches one mini,
10 micros; rounding is always down). Without a bundle the policy strategy takes
every setup as sized: the rules-only baseline the policy must beat.

The policy aims for a **high pass rate and a high win rate**: reach the
profit target before the challenge's sessions run out, without touching the
max-loss floor, with more winning trades than losing ones. Blowing the
account costs far more than passing earns.

The policy never picks the side and can't create an edge the setups don't
have. It decides which setups are worth the account's risk at that moment,
how big to be, and when a winner has run far enough.

## Where each piece lives (ECC)

| Slot | Piece | Role |
|---|---|---|
| `accounts/<name>/ACCOUNT.md` | Account profile | The challenge as a document: starting balance, target, max loss (trailing to the end-of-day high, locking at the start balance), daily limits, contract limits, consistency, attempt length. Code reads the frontmatter; agents read the body |
| `strategies/<name>/STRATEGY.md`, `signal: policy` | Policy strategy | The prop challenge as a strategy: its rules strategies (`strategies`), `account`, `sizing`, `contracts`, `exit`, and `policy: { bundle }`. Training, backtests, and live trading all read it; only policy strategies have these keys |
| `scripts/lib/trading/contracts.js` | Micro/mini families | MNQ/NQ, MES/ES, MYM/YM, M2K/RTY, MGC/GC: specs, the 10:1 ratio, ProjectX id symbols (NQ trades as ENQ, ES as EP, GC as GCE) |
| `scripts/lib/trading/combine.js` | Combine state and sizing | Pure logic shared by the env, the backtester, the runner, and the gate: the budget, the room to the floor and daily limit, and `contractPlan` (micros or minis) |
| `scripts/lib/trading/prop-state.js` | Live attempt state | The attempt, balance snapshots, end-of-day balances, policy verdicts, and the gate's `combine` / `policy` checks |
| `scripts/lib/rl/challenge-env.js` | Challenge env | Episodes of N real sessions from random starts, on the backtester's broker logic |
| `scripts/rl-env-server.js` | Env server | The env over a JSON line protocol, for the Python trainer: the backtest itself, paused at each decision |
| `rl/fth_rl/` (Python) | Trainer | gymnasium env with action masks, sb3-contrib MaskablePPO, seed selection, out-of-sample gate, export |
| `scripts/lib/rl/observation.js` | Observation | The one observation builder, used by training and live alike |
| `scripts/lib/rl/policy-net.js`, `policy-bundle.js` | Inference and bundles | Runs the exported network; refuses a bundle built on another observation, or one that fails the gate |
| `models/<name>.json` | Policy bundle | Weights, normalization, and everything it was trained and validated with |
| `skills/prop-challenge-pacing`, `/combine-status` | Live workflow | Account state, the size budget, placing exactly the verdict, protecting a pass |
| `skills/policy-training`, `/train-policy` | Training workflow | The agents run training and report; the user promotes |
| Order gate, gateway, runner, backtester | Enforcement | The same account rules and policy everywhere |

Why Python for training and JavaScript for everything else: the harness
installs as a plugin with no runtime dependencies, so live trading, the gate,
and backtests stay plain Node. Training needs a mature RL stack (PyTorch,
stable-baselines3), so it runs in Python, but against the harness's own
engine over the env server, not a reimplementation: the env is the
backtester, and the exported network runs in the harness exactly as live
trading runs it (a parity test checks numpy against the JS inference).

## The challenge (account profile)

Fields (see `accounts/topstep_100k/ACCOUNT.md`):

- `starting_balance`, `profit_target`
- `max_loss` with `max_loss_mode: trailing_eod`: the floor trails the
  highest end-of-day balance by `max_loss` and locks at the starting balance
  once the end-of-day balance reaches `starting_balance + max_loss`. Equity
  at or below the floor at any time is a blow.
- `daily_loss_limit` (the firm's, 0 = none) and `daily_loss_soft` (the
  harness's: no new entries for the day once reached).
- `max_contracts` per symbol.
- `consistency_pct`: the best day may be at most this share of the total
  profit for a pass (0 = no rule). At the target, new entries stop once
  today's close would pass; while consistency isn't met, trading goes on
  (or the attempt could only time out), except on a day that is already
  the best one, where more profit can't help. Clock sizing sizes for the
  profit consistency needs, not only the target.
- `sessions`: attempt length for training and evaluation.

## The env

- **Setups** come from the policy strategy's rules strategies through the
  evaluator, the same code the live scan and the backtester use: on each bar,
  the first of them (in the listed order) with a setup and a stop.
- **Broker**: the backtester's per-bar settlement (stop first, gaps at the
  open), the trailing exit, the market session, end of day, fees.
- **Sizing**: the budget (a share of the cushion, within the room to the
  floor and the daily limit) in micros, traded as micros or minis by
  `contracts`; P&L and fees at the traded contract's own tick value and fee.
- **Decisions**: at a setup, skip or enter with a size bucket; in a trade past
  the ratchet, hold or close. Before the ratchet the stop and trail run alone
  (a policy free to close early learns to bank small wins).
- **Episode**: `sessions` trading days from a random start; it ends on pass,
  blow, or timeout.
- **Reward**: + pass (more for a faster pass), heavy − for a blow, small − for
  a timeout, + for each winning trade and − for each losing one (after
  fees), and a dense term: the balance change between decisions over the max
  loss. The blow penalty must exceed pass + speed.
- **Observation** (`observation.js`, 17 fields plus one per strategy):
  account (cushion / max loss, progress to target, drawdown, day P&L, sessions
  left), the setup's risk as a share of the cushion and the room to the soft
  daily limit, whether it trades minis, trade (side, R now, best and worst R,
  bars held), market (session clock, ATR ratio, ADX), and which strategy the
  setup or trade came from. Built by one function for training and live.

## Training and promotion

Training is Python (`pip install -r rl/requirements.txt`). A config family is
three JSON files:

| File | Holds | Stage |
|---|---|---|
| `rl/configs/sweep/<family>.json` | The training config (the policy strategy, the data's symbol and file, windows, seeds, steps, network, PPO, reward, optional sizing and contracts overrides) plus `study` and `search_space` (`searched`, `anchored`). The account, strategies, timeframe, and exit come from the policy strategy's STRATEGY.md | `python rl/sweep.py --config <file> [--dry-run] [--n-trials N] [--n-jobs N]` |
| `rl/configs/retrain/<family>.json` | `sweep` (its config), `trial` (`"best"` or a number), `seeds`, `total_timesteps`, `n_envs` | `python rl/retrain.py --config <file> [--dry-run]` |
| `rl/configs/ship/<family>.json` | `retrain`, `bundle` (the name strategies use), `min_pass_rate`, `models_dir` | `python rl/ship.py --config <file> [--dry-run]` |

1. **Sweep** (Optuna TPE): each trial samples `searched`, fixes `anchored`,
   trains on the training window, and is scored on the selection window. A
   trial with any blow (or fewer trades per attempt than
   `study.min_trades_per_attempt`) is infeasible and always ranks below every
   feasible trial; feasible trials rank by pass rate + `study.win_rate_weight`
   × win rate (0.5 by default). With
   `study.pruner: median`, each trial is evaluated at `study.checkpoints`
   points and poor ones stop early. Only training and reward levers (`ppo.*`,
   `reward.*`, `sizing.*`, `hidden`, `total_timesteps`, `normalize_reward`,
   `clip_obs`) can be searched or anchored; never the account, data, windows,
   strategies, or the gate. The study lives in `<out>/sweep/study.db`
   (resumable); each trial's full config is in `<out>/sweep/trial_NNN/`.
2. **Retrain**: the best feasible trial's exact config, with more seeds and
   steps; each seed scored on the selection window. Resumable seed by seed.
3. **Ship**: every retrained seed must be blow-free on selection; the one
   with the best selection pass rate, then win rate, is evaluated out of sample, month by month, by the harness's own inference,
   next to the rules-only baseline. This is the only place the
   out-of-sample window is used; every evaluation is logged in
   `<out>/ship/oos_log.jsonl`, and the bundle records how many there were.
4. **The gate**: zero blows in every out-of-sample month, with no exceptions,
   and a pass rate (passed / attempts, unrounded) of at least 40%, over at
   least 20 attempts and 2 months. `min_pass_rate` may raise the bar, never
   lower it; there is no setting for blows. `min_win_rate` adds a win-rate
   floor (winning trades / trades), off by default. Only a bundle that passes is
   promoted to `models/<bundle>.json` (`--dry-run` never promotes).
5. The bundle records its training config, the simulator it ran in (the
   harness rules are always on), data hashes, the selection and out-of-sample
   reports, and the gate. Live trading re-checks the gate from the bundle's
   own numbers, and uses a bundle only for the account, strategy, symbol,
   timeframe, and sizing it was trained with.

`<out>` is the sweep config's `out_dir`, else `<FTH_HOME>/rl/<family>`.
`python rl/train_policy.py --config <training config>` runs all three stages
in one go without a sweep (a quick baseline).

Defaults: the 100K combine (`topstep_100k`: $6,000 target, $3,000 trailing
max loss, $2,000 daily loss limit, 30 sessions), reward pass +10 (+3 for
speed), blow −30, timeout −1, win +0.5 and loss −0.5 per trade, dense
Δbalance / max loss, win-rate weight 0.5 in the sweep, gamma 0.999 (an
attempt holds hundreds of decisions).

Rules:

- Never tune or select on evaluated rows.
- Train on the full session (18:00-16:00 ET).
- Env equals live: one observation builder, one broker logic, a parity test.
- Check stops on every bar.
- Trade frequency is a selection gate, never a reward.

## Live

- `node scripts/combine.js start --account <name>` starts an attempt (the
  user's call). The runner snapshots the account balance and open positions
  every bar and records each day's closing balance after the end-of-day
  flatten, once flat. A missed close stops entries until it is recorded
  (`combine.js record-day`).
- At each setup of a policy strategy's strategies, while flat, the runner
  records a verdict: the strategy that fired, the side, `skip` / `half` /
  `full` (the trained policy's, or `full` without a bundle), the contract
  (micro or mini), the largest size, the stop in ticks, and when it expires.
  The rules strategies don't start cycles of their own while an attempt runs;
  a skipped setup starts none. In a trade past the ratchet the runner asks
  the policy every bar and closes on `close`. Positions in either contract of
  the family are trailed and managed from the family's bars.
- The order gate (hook and gateway) refuses a policy strategy's entry without
  a started attempt, with a stale snapshot or a missed close, once the attempt
  passed or ended, at the daily limits, above the size budget, or not exactly
  as the verdict says (contract, side, size, stop ticks), or a second entry on
  the same verdict (as in training, one entry per setup). The gateway also
  refuses any entry while a position is open anywhere on the account, and
  while an attempt runs, any entry that isn't its policy strategy's. These
  checks fail closed and can't be skipped.
- The agents see the account state and the live verdicts in every cycle
  prompt (and with `/combine-status`), and follow the `prop-challenge-pacing`
  skill.
