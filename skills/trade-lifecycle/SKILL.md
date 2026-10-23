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
   that fits; trend side, a reaction at a level, the trigger closed →
   compose (`confluence-counting`); the plan, never you, works out R:R. Call
   `compose_check` with one true read per step at least, each for your
   side (the against stay in the count), and your size.
   The record is for this bar and side; it expires `valid_bars` base bars
   after its bar's close (two: 6 minutes on the 3m).

   | Step | Read forms | The skill for the fact |
   | --- | --- | --- |
   | bias | the side, by the side rule (`htf-to-ltf`): trend (`1h up`), regime (`regime trend up`), bos/choch, prior RTH range, trend rule, read, day type | `multi-timeframe-analysis`, `trend-vs-range`, `daily-bias`, `bos-vs-choch` |
   | location | the pullback into a key level in that trend (`htf-to-ltf`): `at <level>`, `at 15m fvg`, vwap, value | `levels-and-reactions`, `vwap-volume-profile`, `fair-value-gaps` |
   | setup | the reaction ending the pullback, a "Setups to check" read: rejected/broke/touched a level or gap edge (a bullish gap holds `15m rejected 15m fvg high up`, fails `15m broke 15m fvg low down`, a close inside: `15m touched 15m fvg high`, it reached the high edge; bearish mirrored), pattern, cisd, ote, swept | `rejection`, `breakout`, `fair-value-gaps`, `pullback-vs-reversal`, `breakout-vs-fakeout`, `cisd`, `candle-reading` |
   | entry | confirmation on a later close: close location, momentum, pattern (hammer, bullish engulfing long; shooting star, bearish engulfing short), `3m volume high`, `participation high`, `3m absorption at <level> up` (short: down) | `candle-reading`, `momentum-and-volume`, `absorption` |
   | stop | `stop <tf> low <price>` (short: high): where the trend thesis fails | `invalidation` |
   | target | `target <tf> swing <price>`: the next swing; past it the runner trails | `take-profit` |
   | size | contracts | `position-sizing`, `prop-challenge-pacing`, `prop-pacing-judgment` |
   | management | once filled: the record's stop and target are the exit; the policy's exit mode (in an attempt or not) may let it run past the target, the code trailing the stop; never widen it or close early by feel | `manage-position` |

   The setup is the reaction on a closed candle (often 15m); an entry read
   your way must be on a candle that closed after it (often the next 3m).
   A CISD setup is timed from its confirming candle
   (`m3.cisd.<tf>.confirmedClose`): the entry read closes after it; a CISD
   with no close time is refused.
   Each needs a true read your way; `at`, `touched`, `swept`, volume,
   participation and a setup `in ote` only support it. Both true and the
   count for → compose now.

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
3. **Send it as the record says** (runner runs the entry: `planned`): `place_order` `limit` at the record's
   entry (or better), with its `stopLossBracket.ticks`,
   `takeProfitBracket.ticks`, size and contract, rationale
   `setup:trade_lifecycle long|short ...`
   (in an attempt, `setup:prop_portfolio`); `order_plan` gives these and
   refuses a size over code's caps ($300, the broker's max, in an attempt
   the verdict). No priority order halves a composed trade.
4. **Against the trend**: a true CHoCH read your way at or above its frame
   (15m trend: 15m or 1h; 1h: 1h; 4h: 1h plus `4h rejected <level> up|down`
   your way, a key level, not a gap edge); else the trend rule refuses it.
5. **`[composed-reads]` refusals**: no record for this bar and side, or
   expired (compose again); an entry already placed on this bar and side;
   another contract; a read false, unverifiable or against your side now
   (drop it or pass), or no setup or entry read your way; the plan, ticks, limit or size not the record's. The
   stop is never widened: name a farther level or pass. `[late-entry]`:
   missed the plan's entry, or price beyond its stop before the order went
   → pass: never enter late. Exits and protective orders are never held.

| Tool | Arguments | What it returns | Script (people) |
| --- | --- | --- | --- |
| `compose_check` | `symbol`, `side`, `reads`, `size` | each read TRUE, FALSE or UNCHECKED and with or against your side, then the plan in code; recorded for this bar, OK or what fails | `compose-check.js --symbol MNQ --side long --size 5 --reads '[...]'` |
| `experience_lookup` | `symbol`, `alternative`?, `role`? | after an OK compose_check, at most 2 a bar: your own past decisions of these skills in this context, then, only when the run enables its display (`libraryDisplay`), the code-measured history library apart (not yours: counts, win rate and no-room, never R); statistics only, never advice | `experience-lookup.js --symbol MNQ` |

**Your risk record**, last in `experience_lookup` when the run shows it
(`riskRecordDisplay`): a line per account state and risk decision of yours
(standing down, sizing under the ceiling, exiting early, stopping for the day
after losses), counting what reverting it did over the same Monte Carlo paths:
n is the paths it changed, then the blows it saved or caused and the passes it
cost or gained. "Too few" is no reading yet. Read it as a prop trader reads a
journal: evidence about your own standing-down habits in that account state,
never a forecast for this trade. A rule from code always overrides it.

## Examples

```text
compose_check {"symbol": "MNQ", "side": "long", "size": 5, "reads": [
{"step": "bias", "skill": "multi-timeframe-analysis", "read": "1h up"},
{"step": "location", "skill": "vwap-volume-profile", "read": "vwap above"},
{"step": "setup", "skill": "rejection", "read": "15m rejected prior vah up"},
{"step": "entry", "skill": "candle-reading", "read": "3m close top"},
{"step": "stop", "skill": "invalidation", "read": "stop 15m low 21512.75"},
{"step": "target", "skill": "take-profit", "read": "target 1h swing 21598"}]}
-> ok, entry 21540.25, stop 111 ticks ($277.50), target 231 ticks ($577.50, 2.08R).
-> place_order MNQ buy 5 limit 21540.25, stopLossBracket.ticks 111,
   takeProfitBracket.ticks 231, rationale "setup:trade_lifecycle long ...".
```
