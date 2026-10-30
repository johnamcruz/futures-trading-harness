---
name: momentum_continuation
description: Momentum continuation on 3m - a closed momentum candle the entry rule's side (BG), 09:36-11:57 ET; trade_lifecycle cites it and enters at market, its stop beyond the candle, 2R.
version: 2
status: active                # the owner's ("build all of them", 2026-10-28); traded only through trade_lifecycle's record under prop_portfolio
instruments: [MNQ]            # the census's market (NQ 3m); MNQ covers a selected NQ, as any rules strategy
timeframe: 3m
sessions: [ny]                # the scan's session; the decision window is the minute_et rules below
signal: rules
rules:
  long:
    - chain_side > 0          # the side the shipped entry rule allows is long (chain-side.js: BG on the 4h and 1h; both ranging, the 15m and the declared trend)
    - htfd_momentum(3) > 0    # the closed 3m candle has momentum up (momentum.js: range >= 1 ATR, volume >= its average, close in the top third)
    - minute_et >= 576        # the candle opened 09:36 ET or later (closed 09:39, after the opening print)
    - minute_et <= 714        # and by 11:54 ET (closed by 11:57)
  short:
    - chain_side < 0
    - htfd_momentum(3) < 0
    - minute_et >= 576
    - minute_et <= 714
exit:
  target_r: 2                 # its own target, 2R from its stop; under prop_portfolio the rulebook's exit trails past it
risk:
  stop:
    long: close - low + 0.25  # one tick (MNQ, NQ: 0.25) beyond the candle's low
    short: high - close + 0.25
  stop_min: 3                 # at least 3.00 points (12 ticks): a closer stop is widened to it
  min_rr: 2
  max_risk_usd: 300           # the composed trade's cap, the same as trade_lifecycle's
source: the owner-approved S2 census (2026-10-28, model-free, NQ 3m practice-train days 2021-04-26..2024-06-30); the momentum read is momentum.js; the side the entry rule's BG (chain-side.js), the owner's change (2026-10-29)
---

# Strategy: Momentum Continuation (`momentum_continuation`)

A closed 3m momentum candle on the entry rule's side (BG: the bias,
4h + 1h), in the morning session: the trend resuming with force. Its
fired read is the setup (the 15m may still run against it in a pullback). It is a setup the trade lifecycle cites, never a trade of its own:
the head trader weighs it through the whole top-down flow and composes it
with `compose_check`; code takes its entry, stop and target from here.

## When to Use

- The bar briefing's Setups line lists `momentum_continuation long|short`
  (the scan fired on the bar that just closed).
- You weigh it as any setup (`trade-lifecycle`, `confluence-counting`):
  take it, or pass on a decisive reason.

## How It Works

### Context filter

- The side is the one the entry rule allows (BG, `htf-to-ltf`'s side
  rule): each trending 4h or 1h its way, neither against; both ranging, the
  15m trend and the declared trend its way. Neither side allowed, or a
  frame not read yet: no setup. A deliberate change from the census's
  rule (the prevailing trend, the first of 4h, 1h, 15m with a trend),
  approved by the owner (2026-10-29), so the setup fires only where the
  gate takes its side; the candle, the stop, the 12-tick floor, the 2R
  mark and the window are the census's.

### Trigger

- The 3m candle that just closed has momentum the trend's way
  (`momentum-and-volume`): its range at least 1 ATR(14), its volume at
  least the average of the 20 before it, its close in the far third. A
  candle still forming never counts.
- It opened 09:36-11:54 ET (closed 09:39-11:57); the opening print
  (09:30-09:35) and the no-entry windows still hold.

### Entry, stop, targets

- Compose it (`compose_check`), one read per step: your bias (the
  side rule's, e.g. `4h up`), where price is (location), the setup
  `momentum_continuation fired up` (short: `down`), the entry `3m momentum
  up`, the stop `stop 3m low <the candle's low>` (short: high), the target
  `target 2r` (the 2R mark that arms the trail, not the exit).
- Code's plan: at market from the candle's close; its own stop: one tick
  beyond the candle's extreme, widened to at least 12 ticks (`stop_min`),
  and like every composed stop refused under compose's floor; the 2R mark
  arms the trail. The brackets are
  ticks from the fill. Past 2R the rulebook's exit trails it
  (`target_then_trail`: the lock, then the 15m structure trail).
- Size: the rulebook's (in an attempt `order_plan` translates yours; the
  3-contract floor, the $300 cap); no size fits: skip.
- One position at a time (the policy's rule).

### Skip when

- Any decisive reason of `confluence-counting`, the news, the windows.
- Order flow: when the broker puts flow fields on its bars, the Broker bar
  fields line holds this candle's (the last bar): a read only
  (`broker-bar-fields`). No flow or extra volume filter: in the census
  every confirmation tried lowered the combine pass on the second half.

### What to expect (census, model-free)

- About 2 setups a session (2.2).
- About 39% are false starts that never reach +0.5R: the price of catching
  about 30% of the big legs (32%, against about 19% for today's plans).
  Each loser is -1R, held by the bracket stop.
- Mean +0.08R and +0.06R a trade on the two halves, both intervals
  including 0: no proven edge alone. 30-session combine pass about 8% on
  both halves, 0 blows.
- The census ran at a 240h trend window; the live scan uses the current
  window. A model-free re-run at 504h (practice-train, split 2022-11-23)
  still beat today's plans on both halves: R caught/available 18.2% vs 9.9%
  (A) and 25.7% vs 10.0% (B); 30-session pass 10.85% vs 6.61% (A) and
  8.38% vs 1.57% (B) on real starts; resampled paired-gain intervals above 0
  on both halves; 0 blows. 2021 and 2024 H1 were weaker on mean R.

## Examples

```text
MNQ, prevailing 4h up. The 3m candle 10:12-10:15 ET: O 21500.00 H 21512.50
L 21498.25 C 21511.75, range 14.25 pts = 1.19 ATR(14) (12.00), volume 1.3x,
close in the top third: momentum_continuation long fires.
Stop 21511.75 - 21498.25 + 0.25 = 13.75 pts = 55 ticks: 21498.00, one tick
under the low ($27.50 an MNQ). Target 2R = 110 ticks: 21539.25.
compose_check reads: "4h up", "vwap above", "momentum_continuation fired up",
"3m momentum up", "stop 3m low 21498.25", "target 2r" -> OK, entry market from
21511.75, stop 55 ticks, target 110 ticks. 10 MNQ risk $275.00 at the stop.
place_order MNQ buy 10 market, stopLossBracket.ticks 55, takeProfitBracket.ticks
110, rationale "setup:prop_portfolio long trade_lifecycle at market from 21511.75 ..."
(order_plan gives it).
A short candle whose high is 1.75 pts above its close: 2.00 pts, under the
3.00 minimum: the stop is 12 ticks, $6.00 an MNQ.
```
