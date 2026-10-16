# How the trading agent trades

A local AI model trades micro Nasdaq futures (MNQ) as a trend follower: it
reads the higher-timeframe trend, waits for a pullback to a key level, enters
on a confirmed reaction, and lets winners run on a trailing stop, while code
checks every claim and enforces every risk limit. The goal is to pass a
prop-firm challenge: reach the profit target without ever touching the
max-loss floor.

This is the plain-language overview. The design is in
[HARNESS-DESIGN.md](HARNESS-DESIGN.md), the training process in
[TRAINING.md](TRAINING.md), and the composed trade's code-level design in
[COMPOSED-ENTRY.md](COMPOSED-ENTRY.md).

## The trade, step by step

Every trade is one chain: each step is a written read that code verifies as
true before the order can go (`compose_check`, the `trade-lifecycle` skill).

| Step | What the model decides | Example read |
| --- | --- | --- |
| Bias | The side: the prevailing 1h/4h trend sets it, long and short alike | `1h up` |
| Location | A pullback into a key level inside that trend (prior day high or low, VWAP, value area, a fair value gap) | `at prior rth low` |
| Setup | The 15m candle's reaction at the level: a rejection or a breakout | `15m rejected 1h fvg low up` |
| Entry | Confirmation on a later 3m close the trend's way | `3m close top` |
| Stop | Where the trend idea is wrong: beyond the reaction's swing | `stop 15m low 21541.75` |
| Target | The next swing; then the stop trails behind the move | `target 1h swing 21568.00` |

- **The side rule** (`htf-to-ltf`): trade with the higher-timeframe trend. A
  pullback inside it is an entry once it ends. A trade against it is a pass,
  unless the structure has clearly reversed.
- **Confluence:** the model combines independent reads from its skills
  (structure breaks, CISD, VWAP, value areas, momentum). The more agree, the
  better the trade, which the data confirms (below).
- **Exit:** bank the swing target, then lock most of it and trail the stop
  behind the latest confirmed 15m swing to ride the trend (`target_then_trail`,
  the account's rulebook). Of every exit tested, a structure trail like this
  kept the most edge.
- **Selective:** a valid setup is a pass when the room to the target is under
  2R, the trend is against it, or the reads don't all check true.

## Who does what

Each 3-minute bar, a head trader runs a desk of specialist agents, all the
same local model with different roles; the trade needs the whole desk.

| Role | Job each cycle |
| --- | --- |
| Head trader | Writes the plan, composes the trade, makes the call |
| Market structure analyst | Trend, structure breaks, key levels |
| Trend and momentum analyst | Trend strength, momentum, CISD |
| Volume and liquidity analyst | VWAP, value area, liquidity in the trade's way |
| News analyst | Scheduled events and blackouts |
| Risk manager | Checks the account and attempt state, then approves or vetoes the plan with checked facts |
| Trade executor | Sends the order exactly as the plan says |

The code builds the facts every role reads: a bar briefing with candles,
levels, structure and the setups to check. The model reasons; it never
computes prices or sizes by hand.

## Risk and the order gate

The model proposes; code decides whether an order can go. The gate fails
closed: if a check can't be made, the order is refused.

- **Every read verified:** each claimed fact (trend, level, reaction, close)
  is checked against the bar data before entry; one false read refuses the
  trade.
- **Risk per trade:** a composed trade risks at most $300; the stop must
  clear a minimum distance, and reward to risk must be at least 2:1.
- **Prop rules:** the account's daily loss limit, and its rulebook's soft
  daily stop and losing-streak stop; the gate also caps entries per day. Near
  the max-loss floor the size shrinks so no single stop can end the attempt.
- **Trend rule:** trades against the prevailing higher-timeframe trend are
  refused unless a clear structural reversal is confirmed.
- **Exits are never blocked:** closing or protecting a position always goes
  through.
- **End of day:** everything is flat before the session closes.

## How it learns

The edge is meant to come from the model's own judgment and risk management,
so it learns by trading replays of history and improving its own skills; no
setup combination is hard-coded.

1. **Skills:** short written playbooks (trend, structure, levels, setups,
   entries, stops, targets, risk) that the model reads and combines.
2. **Practice:** replays of curated setup moments from historical market
   data, with the clock, fills and costs as in live trading.
3. **Its own record:** a walk-forward journal of its past decisions by setup
   combination and market regime: win rate, R, and how far each trade went for
   and against it (MAE/MFE), at natural rates.
4. **Propose-Probe-Compose:** the model proposes small edits to its skills;
   each is replayed on the same moments and kept only if it measurably improves
   decisions on moments it was not chosen on, then judged on a 30-day
   prop-challenge Monte Carlo with zero blown accounts.
5. **Later:** fine-tuning the model on its own verified correct decisions.

Every kept change is reviewed by a person before it is used.

## Evidence (as of 2026-10-16)

Taking every setup mechanically has no edge (-0.03R a trade over 27,173
curated practice setups, 2021-05 to 2024-06), but confluence and
trend-following point the right way, which is what the model is trained to
exploit. These are mechanical baselines on historical replays, before the
model's judgment; the model has to beat them, and they are re-checked on
held-out data.

| Agreeing trend reads (HTF CHoCH, minute CISD, minute trend) | Setups | Expectancy per trade |
| --- | --- | --- |
| 0 of 3 | 868 | -0.08R |
| 1 of 3 | 5,885 | -0.04R |
| 2 of 3 | 6,208 | +0.05R |
| 3 of 3 | 1,836 | +0.08R (longs +0.19R) |

| Exit (setups the trend rule allows) | Expectancy per trade |
| --- | --- |
| Swing target, then trail behind recent structure (close to the rule in use) | +0.05R |
| Swing target, then trail 2R behind | +0.05R |
| Swing target only | +0.01R |
| Fixed 2R | +0.02R |
| 1h/4h swing target, breakeven at +1R | -0.01R |

Setups the trend rule allows: +0.01R; setups it blocks: -0.08R; counter-trend setups: -0.11R.

## Where it stands

It is in stage 1, learning to trade in replay; no live money is involved.

- **Stage 1 exit test** (unseen data): average winner at least 1.8R,
  expectancy at least +0.3R a trade with its interval above zero, reads correct
  at least 80% of the time, process followed at least 80%.
- **Stage 2:** risk decisions by account state, judged on a 30-day
  prop-challenge Monte Carlo: pass within 30 days, zero blown accounts.
- **Then:** sealed tests on later data before any live account
  ([LIVE-DRY-RUN.md](LIVE-DRY-RUN.md)).
