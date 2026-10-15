# The mechanical prop backtester: what was built, what it found

On 2026-10-14 every rules strategy was retired, and `prop_portfolio` came
to list only `trade_lifecycle` (`signal: composed`, `stop: structure`). The
backtest engine takes only setups with a mechanical stop distance
(`backtest/engine.js` `prepare`: `stop "structure" has no mechanical
distance`). So none of the tools below produces a trade from today's only
policy. A Monte Carlo over the model's replay trades is to replace them. This
note keeps what they taught.

| Part | Status |
| --- | --- |
| `prop/challenge.js`, the backtester's prop runs (`backtest.js --prop`, `run.js` `runCombine`), their tests | Deleted |
| `prop/trade-stream.js`, `prop/evaluate-run.js`, `run.js` `policyStrategy`/`barsAt`, `backtest/engine.js` | Kept: the training loop's verifier (`train/evaluator.js`) runs them |
| `scripts/evaluate.js` | Kept: no code calls it, but the `prop-evaluator` and `training-verdict` skills name it |

## What was built

**`prop/challenge.js`, and the backtester's prop runs (deleted).** These were
`backtest.js --prop <policy> [--every N]` and `backtest/run.js`
`runCombine`. The code began as the RL environment's `challenge-env.js`
(e8095beb, 2026-10-08). It moved to `prop/challenge.js` when PPO retired
(36d6c588, 2026-10-12). An attempt ran the full bar engine with the account
(`engine.js` account mode) from a start day to pass, blow or timeout. Starts
came every N trading days and left room for a whole attempt. The run wrote
`combine.json` and `combine.md`: rates overall and by start month. Design
rules:

- The engine matches live (9ed02821). It holds one position across every
  market on the account, settles every market's closed bar before any
  entry, and counts trading days from every market, not the first.
- Fills: the next bar's open plus `slippageTicks`. A setup that gaps
  through its stop or target, or crosses the day or end of day, expires.
- A blow happens inside the bar. Equity at the floor at the bar's worst
  price is liquidated at the floor. A daily-limit breach is flattened at
  the limit and stops the day, not the attempt.
- Sizing is the live `combine.contractPlan`. The risk per contract counts
  the stop's expected slippage and fees, so a planned stop never ends past
  the floor or the daily limit. Every trade exits by the policy's trail.
- R is net (d6298c69): net dollars over the dollars at risk, the same basis
  that counts a trade as a win or a loss.

**`prop/trade-stream.js` (layer 1), `prop/evaluate-run.js` and
`scripts/evaluate.js`** (kept; d763c0ee, 2026-10-13;
`docs/LEARNED-RULEBOOK.md` section 5, R6-R9). The engine runs once, with no
account, one position at a time. Every setup becomes a trade in ticks and R
for layer 2 (`prop/attempts.js`) to size and replay. Each trade records:

- its **adverse path** (`troughTicks`, each deeper trough in order), which
  layer 2 replays against the floor and the daily limit;
- its **stop overshoot**: ticks past the stop beyond the expected
  slippage, to be redrawn per market in the bootstrap;
- its **no-stop path** (worst move and last close to the day's end), used
  when a **stop fault** is injected;
- its **facts**, from the live scan and briefing, never a copy. A fact that
  can't be computed is an error, so the rulebook's multiplier fails closed;
- the **day's regime** (range against the 20 prior days), for
  regime-matched bootstrap joins.

The **entry delay** (`entryDelayMs`; `delayFromCycles` gives a 90th
percentile of measured cycle times) fills each entry after the model's
cycle, not at the next bar's open. The gate's count rules apply on the
stream. `evaluate-run.js` checks the window and logs the **look**
(`prop/ledger-file.js`, locked) before it reads a bar. It refuses to build
longer bars from finer ones that carry broker fields a traded strategy
reads. The CLI is a thin wrapper over it.

## What it found

- `docs/research/mtf-setup-catalog.md` (48f60cf3): the top 3 catalog
  variants passed 2.9%, 6.7% and 10.5% of 105 overlapping 30-session
  attempts on Train, with 0% blows. "With no edge, the sizing protects the
  account and the attempts run out of time."
- `docs/research/cisd-ote-textbook.md` (615bd690, 9a06c666, daa4147d,
  fb4ec6b0): N1 0% and the old port 8.5% of 106 attempts; S 14.2%, ST
  10.4% and SC 14.2%, all with 0% blows. None came near the 40% the
  promotion gate asks for.
- d6298c69: 21 daily starts of a 21-session attempt is an effective sample
  of 1. The promotion gate now counts its minimum on the effective sample
  size, and fails closed without one. A bootstrap with fewer than two whole
  blocks is degenerate ([0, 1]), not a zero-width interval.
- The layer-1/layer-2 split reproduced the engine's own attempts exactly,
  start by start, on bars with gaps that blow the account and trip the
  daily limit, except where layer 2 skips a trade
  (`docs/LEARNED-RULEBOOK.md` section 5, "Known approximation").

## What the model-trade Monte Carlo must keep

| Idea | Where it lives now |
| --- | --- |
| Attempt rules (trailing floor, daily limit stops the day, soft stop, target, consistency, `sessions`) | `attempts.js` over `combine.js`: kept |
| Live sizing, slippage-safe, times the rulebook's multiplier; legs priced as the engine does | `attempts.js`: kept |
| Adverse path replayed against the floor and the daily limit inside a trade | `attempts.js` reads `troughTicks`: the replay trades must supply them |
| Overshoot redrawn per market | `attempts.js`/`evaluator.js`: needs `overshootTicks` on each stop exit |
| Stop faults and outages | `evaluator.js` injects them through `attempts.js` `stopFault`: a trade without `noStop` gets no fault (`stopFault` returns null and the trade runs as recorded), so replay trades need `noStop` or faults silently drop out |
| Stationary block bootstrap, regime-matched joins | `evaluator.js`, `stats.js`: needs `regime` on each day (`trade-stream.js` `dayRegimes` computes it) |
| Block-bootstrap and Wilson intervals at the ESS; expectancy cuts; every blow counted at the top | `evaluator.js`, `stats.js`: kept |
| Flow coverage (`flowOff` attempts) | `evaluator.js`: kept; needs the stream's `fieldBranch` |
| Look ledger before any held-out read | `evaluator.js` `checkWindow`, `looks.js`, `ledger-file.js`: kept |
| Entry delay | Layer 1 only. In a replay the model's fills come at the replay moment, so the delay is real, not modelled |
| One position at a time; the gate's count rules | Layer 1 only. A replay inherits them from the live gate |
| Results by the month an attempt starts in | `evaluator.js` (`months`): kept |
| Net R in the trade statistics | Not kept: `attempts.js` settles net dollars, but its `expectancyR` (the cuts' base) is gross, move over stop |
| Parity proof of layer 2 | `tests/lib/prop-evaluator.test.js` against the engine's account mode, kept |

The training loop's verifier still runs layer 1. Today it scores no trades,
so it can't show a strategy or rulebook change better than the champion.
