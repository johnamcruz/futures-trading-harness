# Strategies

Each strategy is a folder with one `STRATEGY.md`, written like a skill:

- **Frontmatter** is read by code. `scripts/strategies.js` validates it and
  scans bars for candidates, and the order gate checks every live entry against
  it: the `setup:<name>` tag must name a valid strategy with `status: active`,
  the contract must be in `instruments`, and the time must be inside `sessions`.
- **The Markdown body** is read by the agents: context filter, trigger, entry,
  stop, targets, and skip rules.

| Strategy | Signal | Status |
|---|---|---|
| `orb` | opening range breakout | active |
| `ema_cross` | EMA 9/20 cross | active |
| `keltner` | Keltner breakout | active |
| `supertrend` | SuperTrend flip | active |
| `bos` | break of structure | active |
| `cisd_ote` | CISD on 12m + OTE fib zone pullback | active |
| `vwap_reclaim` | rules (written in Markdown) | paper |
| `ofi` | rules: 1m order-flow imbalance at 1, 3 and 5 minutes that moves price | paper |
| `ofi_absorption` | rules: 1m heavy flow that fails to move price, then a turn | paper |
| `crt_1h` | CRT detector: a raid of the previous 1-hour high or low, reclaimed with a 3m shift; target the far side | paper |
| `crt_4h` | CRT detector on the 4-hour candle (06:00 and 10:00 ET raids) | paper |
| `value_area` | rules: a rejection of, or breakout through, the prior day's POC, confirmed by order flow or a range expansion on volume; target the edge of value | paper |
| `value_area_reentry` | rules: volume profile 80% rule; open outside the prior day's value area, two closes back inside, target the far side | paper |
| `value_area_breakout` | rules: two closes beyond the prior day's value area on above-average volume; trend trail | paper |

The value area strategies read the prior RTH day's volume profile
(`prior_poc prior_vah prior_val`, `scripts/lib/trading/volume-profile.js`):
a bar-based profile any strategy can use, also as a developing session
profile (`session_*`), a rolling one (`vp_*(n)`), and its high and low volume
nodes.

The order-flow pair runs on 1-minute bars (the runner's `timeframe: 1`)
and declares `connectors: [order_flow]`: `ofi` and `delta` read aggressor
buy and sell volume from recorded flow files (`<FTH_HOME>/flow/`) where
they cover the bar, else an estimate from where each bar closed in its
range. Live flow is not part of the broker MCP interface, so live these run
on the estimate. `ofi` trades real flow, where the imbalance moves price;
`ofi_absorption` trades the reversal when it doesn't. `value_area`
(3-minute) declares it too, for its order-flow confirmation.

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
strategy is rules, including the six algoTraderBot ports. Zone logic the
rules can't spell out (cisd_ote) is a series the rules use (`cisd_ote_dir`).

The ports' rules trade exactly as algoTraderBot's detectors do:
`tests/lib/parity.test.js` checks every signal and stop against algoTraderBot's
own output on its data. Their frontmatter adds no extra gates: no
`sessions`, `regimes`, or `filters`. The runner's sessions and end of day
decide when they trade. To adapt one to a regime, add `regimes:` (or a
filter) in a copy, and backtest both (`scripts/backtest.js`, see
docs/BACKTESTING.md). Each port exits with a trailing stop: hold the
initial stop (0.5 × ATR(20)) until +2R, then trail 0.5R behind the best
price (`exit:` block).

## Prop challenges and policies

The prop challenge is a strategy too: a **policy strategy** (`signal: policy`)
trades the setups of the rules strategies it lists on a prop account, and a
trained policy decides which to take, at what size (in micros or minis), and
when to bank a trade.

- `prop_portfolio_3m`: every 3-minute strategy (ema_cross, supertrend,
  keltner, bos, cisd_ote, orb, vwap_reclaim, crt_1h, crt_4h, value_area,
  value_area_reentry, value_area_breakout) on `topstep_100k`.
- `prop_flow_1m`: the 1-minute order-flow strategies (ofi, ofi_absorption).
  A policy trades one timeframe.

While an active policy strategy has an attempt running, its rules strategies
trade only through it; otherwise they trade as before. Each rules strategy's
own rules, sessions, filters, and regimes still decide its setups, the same
in training and live. Its `status` doesn't (a `paper` one can trade through
an active policy strategy; a `disabled` one can't be listed): the policy
strategy's status is what goes from paper to active. Train and
ship its policy with the `policy-training` skill; a bundle decides only for
the policy strategy, account, index, timeframe, sizing, and contract mode it
was trained with. See docs/RL-DESIGN.md.

## Commands

```bash
node scripts/strategies.js list                       # name, status, instruments, signal
node scripts/strategies.js show orb                   # full STRATEGY.md
node scripts/strategies.js validate                   # schema + section checks
node scripts/strategies.js scan bars.json --symbol MNQ   # candidates on the latest bar
```
