# Strategies

Each strategy is a folder with one `STRATEGY.md`, written like a skill:

- **Frontmatter** is read by code. `scripts/strategies.js` validates it and
  scans bars for candidates, and the order gate checks every live entry against
  it: the `setup:<name>` tag must name a valid strategy with `status: active`,
  the contract must be in `instruments`, and the time must be inside `sessions`.
  A rules strategy trades one leg of a micro/mini family (`MNQ` or `NQ`,
  `MES` or `ES`, `MYM` or `YM`, `M2K` or `RTY`, `MGC` or `GC`, `SIL` or `SI`):
  the selected one, the contract in the runner's `symbols` (`FTH_SYMBOLS` for
  an interactive session). Listing either leg covers the selected leg, so one
  leg per family is enough (listing MNQ, it trades a selected NQ), and the
  other leg is refused ("setup:orb trades MNQ (the selected contract), not
  NQ"): it never alternates between the two. With no leg of the family
  selected, it trades exactly what it lists (a rules strategy listing both
  legs trades neither until one is selected). Everything else is checked on the
  contract ordered: its broker tick specs, and its size and
  `risk.max_risk_usd` in its own dollars (a mini's tick is worth 10 micros', 5
  for silver). Manual strategies match their list exactly; a policy strategy
  trades within its list, the selected leg when one is selected. Exits
  and protective stops on either leg are never refused.
- **The Markdown body** is read by the agents: context filter, trigger, entry,
  stop, targets, and skip rules.

| Strategy | Signal | Status |
|---|---|---|
| `orb` | opening range breakout | active |
| `cisd_ote` | CISD on 12m + OTE fib zone pullback | active |
| `vwap_reclaim` | rules (written in Markdown) | active |
| `ofi_absorption` | rules: 1m heavy flow that fails to move price, then a turn | active |
| `crt_1h` | CRT detector: a raid of the previous 1-hour high or low, reclaimed with a 3m shift; target the far side | active |
| `crt_4h` | CRT detector on the 4-hour candle (06:00 and 10:00 ET raids) | active |
| `value_area` | rules: a rejection of, or breakout through, the prior day's POC, confirmed by order flow or a range expansion on volume; target the edge of value | active |
| `value_area_reentry` | rules: volume profile 80% rule; open outside the prior day's value area, two closes back inside, target the far side | active |
| `value_area_breakout` | rules: two closes beyond the prior day's value area on above-average volume; trend trail | active |

The trend-following strategies (`orb`, `value_area_breakout`: trend or transition; `vwap_reclaim`: trend) are regime-gated
(`regimes`, `regime_gate: true`): in a range the scan never lists them and the order gate
refuses their entries.

The value area strategies read the prior RTH day's volume profile
(`prior_poc prior_vah prior_val`, `scripts/lib/trading/volume-profile.js`):
a bar-based profile any strategy can use, also as a developing session
profile (`session_*`), a rolling one (`vp_*(n)`), and its high and low volume
nodes.

`ofi_absorption` runs on 1-minute bars (the runner's `timeframe: 1`).
The harness computes no order flow: the broker MCP server puts it on its
bars, and the rules read its fields with `field("flow.ofiTrade")` and
`field("flow.windows.5.ofiTrade")`. On a bar without
them those conditions are false, so it gives no signal; nothing
estimates them. It trades the reversal when heavy flow fails to move
price (absorption). `value_area` (3-minute) reads the 3-bar window for one of its two
confirmations; without flow only the other (range expansion) confirms. The
owner activated them (and `prop_flow_1m`) for replay and live once order
flow moved to the broker servers' bars (live from the live server, history
from the replay server's local store); the replay smoke and a fresh replay
verify them before any live session.

## Add a strategy

1. Copy `_template/` to `strategies/<name>/` (or to your own folder listed in
   `FTH_STRATEGIES_DIRS`, so it survives plugin updates).
2. Fill in the frontmatter and every section. Keep `status: paper` until it
   has a track record.
3. `node scripts/strategies.js validate`
4. Paper-trade it (`/trade-plan`, reviews tagged `paper`), then check
   `/setup-scorecard` before setting `status: active`.

No strategy needs code. A mechanical trigger is written as `signal: rules`
with `long:`/`short:` condition lists in the frontmatter (see
`vwap_reclaim/` and the `strategy-authoring` skill for the rule language), and
code evaluates it on every closed bar. A discretionary trigger uses
`signal: manual` and is judged by the agents from the body. Every shipped
strategy is rules, including the two ported strategies (`orb`, `cisd_ote`). Zone logic the
rules can't spell out (cisd_ote) is a series the rules use (`cisd_ote_dir`).

The ports' rules trade exactly as the original bot's detectors do:
`tests/lib/parity.test.js` checks every signal and stop against the original bot's
own output on its data. Their frontmatter adds no extra gates: no
`sessions`, `regimes`, or `filters`. The runner's sessions and end of day
decide when they trade. To adapt one to a regime, add `regimes:` (or a
filter) in a copy, and backtest both (`scripts/backtest.js`, see
docs/BACKTESTING.md). Each port exits with a trailing stop: hold the
initial stop (0.5 × ATR(20)) until +2R, then trail 0.5R behind the best
price (`exit:` block).

## Prop challenges

The prop challenge is a strategy too: a **policy strategy** (`signal: policy`)
trades the setups of the rules strategies it lists on a prop account: each
setup at the largest size the attempt's budget allows (in the selected
contract), or skipped, and every trade exits by its trail.

- `prop_portfolio`: every 3-minute strategy (cisd_ote, orb, vwap_reclaim,
  crt_1h, crt_4h, value_area, value_area_reentry, value_area_breakout) on
  NQ, ES, YM, and RTY (micros or
  minis), one `topstep_100k` attempt and one position at a time across them.
- `prop_flow_1m`: the 1-minute order-flow strategy (ofi_absorption).
  A policy strategy trades one timeframe.

Both are active and both trade the same account. The runner trades one
timeframe, so a 3-minute runner's setups go through `prop_portfolio` and a
1-minute runner's through `prop_flow_1m`; either way they share the one
attempt. Within one runner (one harness home) the gate holds one cushion
and one position at a time across the account. It does not see another
runner's entries: never start a second runner on the same broker account
(a per-account lock is coming).

While an active policy strategy has an attempt running, its rules strategies
trade only through it; otherwise they trade as before. Each rules strategy's
own rules, sessions, filters, and regimes still decide its setups, the same
in backtests and live, and so does its `status`: an active policy strategy
trades only its `active` strategies (a `paper` one stays paper inside it; a
`disabled` one can't be listed), and a `paper` policy strategy trades only in
a paper run. The trained (PPO)
policy that once decided its setups is retired; the learned-rulebook design
(to come) replaces it with numbers and rules the skills teach and the gate
enforces.

## Retired strategies

Removed on 2026-10-13, the owner's decision: in the Train edge census they
were reliably negative after costs, with the whole 95% confidence interval of
their mean R below 0, RTH-only included. Their documents stay in the
repository's history. The concepts they traded stay in the skills (trend and
momentum indicators, market structure, order flow) for confluence; only the
strategies are gone.

| Strategy | Signal | Census mean R (after costs) |
|---|---|---|
| `bos` | break of structure (3m) | -0.34R |
| `keltner` | Keltner channel breakout (3m) | -0.33R |
| `ema_cross` | EMA 9/20 cross (3m) | -0.24R |
| `supertrend` | SuperTrend flip (3m) | -0.27R |
| `ofi` | 1m order-flow imbalance that moves price | -0.40R |

## Commands

```bash
node scripts/strategies.js list                       # name, status, instruments, signal
node scripts/strategies.js show orb                   # full STRATEGY.md
node scripts/strategies.js validate                   # schema + section checks
node scripts/strategies.js scan bars.json --symbol MNQ   # candidates on the latest bar
```
