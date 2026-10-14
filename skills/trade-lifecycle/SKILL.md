---
name: trade-lifecycle
description: Use before a trade_lifecycle entry - compose the trade as reads with compose_check, send it as the record says, and what the gate refuses.
---

# Trade Lifecycle

## When to Use

- You compose a trade yourself (`setup:trade_lifecycle`): read this before
  the entry; the gate refuses a composed entry without it.

## How It Works

1. **Compose.** Reason through `trader-process`, each step with the skill
   that fits, and call `compose_check` with one read per step at least and
   your size. Pass unless every read is true now and agrees with your side.
   The record is for this bar and side; it expires at the next bar close.

   | Step | Read forms | The skill for the fact |
   | --- | --- | --- |
   | bias | trend, bos/choch, prior RTH range, trend rule, read, regime, day type | `multi-timeframe-analysis`, `daily-bias`, `bos-vs-choch`, `trend-vs-range` |
   | location | at a level, vwap, value | `levels-and-reactions`, `vwap-volume-profile` |
   | setup | rejected/broke/touched a level, pattern, cisd, ote, swept | `rejection`, `breakout`, `breakout-vs-fakeout`, `pullback-vs-reversal`, `cisd`, `candle-reading` |
   | entry | close location, momentum | `candle-reading`, `momentum-and-volume` |
   | stop | stop at a level | `invalidation` |
   | target | target at a level | `take-profit` |
   | size | contracts | `position-sizing`, `prop-challenge-pacing`, `prop-pacing-judgment` |
   | management | once filled | `manage-position` |

   A normal trade risks about $200-300 (less, or a pass, is fine; never
   over $300). Aim the target at the first real level at 2:1 to 3:1 (about
   $600 on that risk); beyond 3:1 only when that is the real level.

2. **Then read** with `skill_lookup`: `confluence-counting` and
   `invalidation` whenever you composed on the bar; `rejection` when a read
   says a candle rejected a level; `breakout` when one says it broke one.
   The gate requires them for a composed entry, as it requires the journal
   plan (`[plan-required]`), `setup-judgment` and `trade-plan`
   (`[skills-at-entry]`) and the full role round (`[roles-ran]`).
3. **Send it as the record says**: `place_order` type `limit` at the
   record's entry price (or better), `stopLossBracket.ticks` and
   `takeProfitBracket.ticks` the record's, the size the record states, on
   the record's contract, rationale `setup:trade_lifecycle long|short ...`.
   The ceilings are code's (the strategy's dollar cap, the broker's max
   size, in an attempt the verdict): at or below, never above. No priority
   order halves a composed trade: its size is yours under the caps.
4. **Against the trend** only with a true 15m or 1h CHoCH read your way in
   the record; else the trend rule refuses it.
5. **`[composed-reads]` refusals**: no record for this bar, or only the
   other side's (compose again); expired (a new bar: compose again); an
   entry already placed on this bar and side; another contract than the
   record's; a read false, unverifiable or against your side on the
   re-check (drop it or pass); the plan, ticks, limit or size not the
   record's (send it as given). The stop is never widened to the minimum
   stop: name a farther level or pass. Exits and protective orders are
   never held.

| Tool | Arguments | What it returns | Script (people) |
| --- | --- | --- | --- |
| `compose_check` | `symbol`, `side`, `reads`, `size` | each read TRUE, FALSE or UNCHECKED and with or against your side, then the plan in code; recorded for this bar, OK or what fails | `compose-check.js --symbol MNQ --side long --size 1 --reads '[...]'` |

## Examples

```text
compose_check MNQ long: bias "1h up", location "vwap above", setup
"15m rejected prior VAH up", entry "3m close top", stop "stop 15m low 21512.75",
target "target 1h swing 21598.00", size 5 -> ok, entry 21540.25,
stop 111 ticks ($277.50), target 231 ticks ($577.50, 2.08R).
-> place_order MNQ buy 5 limit 21540.25, stopLossBracket.ticks 111,
   takeProfitBracket.ticks 231, rationale "setup:trade_lifecycle long ...".
```
