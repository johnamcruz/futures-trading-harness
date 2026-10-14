---
name: trade-lifecycle
description: Use before a trade_lifecycle entry - compose the trade as reads with compose_check, send it as the record says, and what the gate refuses.
---

# Trade Lifecycle

## When to Use

- You compose a trade yourself (`setup:trade_lifecycle`): read this before
  the entry; the gate refuses a composed entry without it.

## How It Works

1. **Compose.** Reason through `trader-process`: bias, location, setup,
   entry, stop, target, each with the skill that fits (the target: where
   `take-profit` says to look), and call `compose_check` with one read per
   step at least (its closed forms) and your size (`position-sizing`,
   `prop-challenge-pacing`, `prop-pacing-judgment`). Pass unless every read
   is true now and agrees with your side. The record is for this bar and
   side and expires at the next bar close. Once filled, `manage-position`.
2. **Then read** with `skill_lookup`: `confluence-counting` and
   `invalidation` whenever you composed on the bar; `rejection` when a read
   says a candle rejected a level; `breakout` when one says it broke one.
   The gate requires them for a composed entry.
3. **Send it as the record says**: `place_order` type `limit` at the
   record's entry reference (or better), `stopLossBracket.ticks` and
   `takeProfitBracket.ticks` the record's, the size the record states,
   rationale `setup:trade_lifecycle long|short ...`. The ceilings are
   code's: the strategy's dollar cap, the broker's max size and, in an
   attempt, the verdict (`prop-challenge-pacing`). At or below, never
   above.
4. **`[composed-reads]` refusals**: no record for this bar, or only the
   other side's (compose again); expired (a new bar: compose again); used
   (one entry per record); a read false, unverifiable or against your side
   on the re-check (drop it or pass); the plan, ticks, limit or size not
   the record's (send it as given). The stop is never widened to the
   minimum stop: name a farther level or pass. Exits and protective orders
   are never held.

| Tool | Arguments | What it returns | Script (people) |
| --- | --- | --- | --- |
| `compose_check` | `symbol`, `side`, `reads`, `size` | each read TRUE, FALSE or UNCHECKED and with or against your side, then the plan in code; recorded for this bar, OK or what fails | `compose-check.js --symbol MNQ --side long --size 1 --reads '[...]'` |

## Examples

```text
compose_check MNQ long: bias "1h up", location "vwap above", setup
"15m rejected prior VAH up", entry "3m close top", stop "stop 15m low 21512.75",
target "target 1h swing 21598.00", size 1 -> ok, reference 21540.25,
stop 111 ticks, target 231 ticks (2.08R).
-> place_order MNQ buy 1 limit 21540.25, stopLossBracket.ticks 111,
   takeProfitBracket.ticks 231, rationale "setup:trade_lifecycle long ...".
```
