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
   The record is for this bar and side; it expires `valid_bars` base bars
   after its bar's close (two: 6 minutes on the 3m).

   | Step | Read forms | The skill for the fact |
   | --- | --- | --- |
   | bias | trend, bos/choch, prior RTH range, trend rule, read, regime, day type | `multi-timeframe-analysis`, `daily-bias`, `bos-vs-choch`, `trend-vs-range` |
   | location | at a level, `at 15m fvg`, vwap, value | `levels-and-reactions`, `vwap-volume-profile`, `fair-value-gaps` |
   | setup | rejected/broke/touched a level or gap edge (a bullish gap holds `rejected 15m fvg low up`, fails `broke 15m fvg low down`, a close inside is touched; bearish mirrored), pattern, cisd, ote, swept | `rejection`, `breakout`, `breakout-vs-fakeout`, `pullback-vs-reversal`, `cisd`, `candle-reading`, `fair-value-gaps` |
   | entry | close location, momentum, pattern (hammer, bullish engulfing long; shooting star, bearish engulfing short), `volume high`, `participation high`, absorption | `candle-reading`, `momentum-and-volume`, `absorption` |
   | stop | stop at a level | `invalidation` |
   | target | target at a level | `take-profit` |
   | size | contracts | `position-sizing`, `prop-challenge-pacing`, `prop-pacing-judgment` |
   | management | once filled: the record's stop and target are the exit; in an attempt the rulebook's exit mode may let it run past the target, the code trailing the stop; never widen it or close early by feel | `manage-position` |

   The setup is the reaction on a closed candle (often 15m); an entry read
   your way must be on a candle that closed after it (often the next 3m).
   A CISD setup is timed from its confirming candle
   (`m3.cisd.<tf>.confirmedClose`): the entry read closes after it; a CISD
   with no close time is refused.
   Each needs a true read your way; `at`, `touched`, `swept`, volume,
   participation and a setup `in ote` only support it.

   A normal trade risks about $200-300 (less, or a pass, is fine; never
   over $300). Aim the target at the first real level at 2:1 to 3:1 (about
   $600 on that risk); beyond 3:1 only when that is the real level.

2. **Then read** `confluence-counting` and `invalidation` whenever you
   composed on the bar, `rejection` when a read says a candle rejected a
   level, `breakout` when one says it broke one: in your prompt when it
   embeds them (don't look them up); else load each (no skill tool:
   `skill_lookup`; in index mode the gate requires them). The gate requires
   the journal plan (`[plan-required]`), `setup-judgment` and `trade-plan`
   (`[skills-at-entry]`) and the role round (`[roles-ran]`).
3. **Send it as the record says**: `place_order` `limit` at the record's
   entry (or better), with its `stopLossBracket.ticks`,
   `takeProfitBracket.ticks`, size and contract, rationale
   `setup:trade_lifecycle long|short ...`
   (in an attempt, `setup:prop_portfolio`); `order_plan` gives these and
   refuses a size over code's caps ($300, the broker's max, in an attempt
   the verdict). No priority order halves a composed trade.
4. **Against the trend**: a true CHoCH read your way at or above its frame
   (15m trend: 15m or 1h; 1h: 1h; 4h: 1h plus `4h rejected <level>` your
   way, a key level, not a gap edge); else the trend rule refuses it.
5. **`[composed-reads]` refusals**: no record for this bar and side, or
   expired (compose again); an entry already placed on this bar and side;
   another contract; a read false, unverifiable or against your side now
   (drop it or pass), or no setup or entry read your way; the plan, ticks, limit or size not the record's. The
   stop is never widened: name a farther level or pass. Exits and
   protective orders are never held.

| Tool | Arguments | What it returns | Script (people) |
| --- | --- | --- | --- |
| `compose_check` | `symbol`, `side`, `reads`, `size` | each read TRUE, FALSE or UNCHECKED and with or against your side, then the plan in code; recorded for this bar, OK or what fails | `compose-check.js --symbol MNQ --side long --size 1 --reads '[...]'` |
| `experience_lookup` | `symbol`, `alternative`?, `role`? | after an OK compose_check, at most 2 a bar: your own past decisions of these skills in this context, then, only when the run enables its display (`libraryDisplay`), the code-measured history library apart (not yours: counts, win rate and no-room, never R); statistics only, never advice | `experience-lookup.js --symbol MNQ` |

## Examples

```text
compose_check MNQ long: bias "1h up", location "vwap above", setup
"15m rejected prior VAH up", entry "3m close top", stop "stop 15m low 21512.75",
target "target 1h swing 21598.00", size 5 -> ok, entry 21540.25,
stop 111 ticks ($277.50), target 231 ticks ($577.50, 2.08R).
-> place_order MNQ buy 5 limit 21540.25, stopLossBracket.ticks 111,
   takeProfitBracket.ticks 231, rationale "setup:trade_lifecycle long ...".
```
