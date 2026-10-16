---
name: trade-lifecycle
description: Use before a trade_lifecycle entry - compose the trade as reads with compose_check, send it as the record says, and what the gate refuses.
---

# Trade Lifecycle

## When to Use

- Before a composed entry (`setup:trade_lifecycle`); the gate refuses one
  without it.

## How It Works

1. **Compose.** Work through `trader-process`, each step with its skill;
   `compose_check` with at least one read per step and your size. Pass
   unless every read is true now and agrees with your side. The record is
   for this bar and side; it expires `valid_bars` base bars after the
   bar's close (two: 6 minutes on the 3m).

   | Step | Read forms | Skill |
   | --- | --- | --- |
   | bias | trend, bos/choch, prior RTH range, trend rule, read, regime, day type | `multi-timeframe-analysis`, `daily-bias`, `bos-vs-choch`, `trend-vs-range` |
   | location | at a level, `at 15m fvg`, vwap, value | `levels-and-reactions`, `vwap-volume-profile`, `fair-value-gaps` |
   | setup | rejected/broke/touched a level or gap edge (bullish gap holds `rejected 15m fvg low up`, fails `broke 15m fvg low down`, closes inside: touched; bearish mirrored), pattern, cisd, ote, swept | `rejection`, `breakout`, `breakout-vs-fakeout`, `pullback-vs-reversal`, `cisd`, `candle-reading`, `fair-value-gaps` |
   | entry | close location, momentum, pattern (long: hammer, bullish engulfing; short: shooting star, bearish engulfing), `volume high`, `participation high`, absorption | `candle-reading`, `momentum-and-volume`, `absorption` |
   | stop | stop at a level | `invalidation` |
   | target | target at a level | `take-profit` |
   | size | contracts | `position-sizing`, `prop-challenge-pacing`, `prop-pacing-judgment` |
   | management | filled: the record's stop and target are the exit (attempt: the rulebook's exit mode may run past the target, code trailing the stop); never widen or close early by feel | `manage-position` |

   - Setup: the reaction on a closed candle (often 15m). Entry read: your
     way, on a candle closed after it (often the next 3m).
   - CISD setup: timed from its confirming candle
     (`m3.cisd.<tf>.confirmedClose`); the entry read closes after it. No
     close time: refused.
   - Setup and entry each need a true read your way. `at`, `touched`,
     `swept`, volume, participation, a setup `in ote`: support only.
   - Risk about $200-300 (less, or pass, is fine; never over $300).
   - Target the first real level at 2:1 to 3:1 (about $600 on that risk);
     past 3:1 only when that is the real level.

2. **Then read** `confluence-counting` and `invalidation` whenever you
   composed on the bar; `rejection` when a read says a candle rejected a
   level; `breakout` when one says it broke one. Embedded in your prompt:
   don't look them up; else load each (no skill tool: `skill_lookup`; in
   index mode the gate requires them). The gate also requires the journal
   plan (`[plan-required]`), `setup-judgment` and `trade-plan`
   (`[skills-at-entry]`), the role round (`[roles-ran]`).
3. **Send it as the record says**: `place_order` `limit` at its entry (or
   better), its `stopLossBracket.ticks`, `takeProfitBracket.ticks`, size,
   contract; rationale `setup:trade_lifecycle long|short ...` (attempt:
   `setup:prop_portfolio`). `order_plan` gives these; it refuses a size
   over code's caps ($300, the broker's max, attempt: the verdict). No
   priority order halves a composed trade.
4. **Against the trend**: a true CHoCH read your way at or above its frame
   (15m trend: 15m or 1h; 1h: 1h; 4h: 1h plus `4h rejected <level>` your
   way, a key level, not a gap edge); else the trend rule refuses it.
5. **`[composed-reads]` refuses**:
   - no record for this bar and side, or expired: compose again;
   - an entry already placed on this bar and side; another contract;
   - a read false, unverifiable or against your side now: drop it or pass;
   - no setup or entry read your way;
   - plan, ticks, limit or size not the record's.

   Never a widened stop: name a farther level or pass. Exits and
   protective orders are never held.

| Tool | Arguments | What it returns | Script (people) |
| --- | --- | --- | --- |
| `compose_check` | `symbol`, `side`, `reads`, `size` | per read TRUE, FALSE or UNCHECKED, with or against your side; the plan; recorded for this bar: OK or what fails | `compose-check.js --symbol MNQ --side long --size 1 --reads '[...]'` |
| `experience_lookup` | `symbol`, `alternative`?, `role`? | after an OK compose_check, at most 2 a bar: your past decisions of these skills in this context; then, only if the run enables it (`libraryDisplay`), the code-measured history library apart (not yours: counts, win rate, no-room, never R). Statistics, never advice | `experience-lookup.js --symbol MNQ` |

**Your risk record**, last in `experience_lookup` when shown
(`riskRecordDisplay`): per account state and risk decision of yours
(standing down, sizing under the ceiling, exiting early, stopping for the
day after losses), what reverting it did over the same Monte Carlo paths:
n is the paths it changed, then blows saved or caused, passes cost or
gained. "Too few" is no reading yet. Read it as a journal: evidence of
your standing-down habits in that account state, never a forecast for this
trade. A rule from code always overrides it.

## Examples

```text
compose_check MNQ long: bias "1h up", location "vwap above", setup
"15m rejected prior VAH up", entry "3m close top", stop "stop 15m low 21512.75",
target "target 1h swing 21598.00", size 5 -> ok, entry 21540.25,
stop 111 ticks ($277.50), target 231 ticks ($577.50, 2.08R).
-> place_order MNQ buy 5 limit 21540.25, stopLossBracket.ticks 111,
   takeProfitBracket.ticks 231, rationale "setup:trade_lifecycle long ...".
```
