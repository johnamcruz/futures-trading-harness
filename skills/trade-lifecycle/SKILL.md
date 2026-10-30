---
name: trade-lifecycle
description: Use before a trade_lifecycle entry - compose the trade as reads with compose_check, send it as the record says, and what the gate refuses.
---

# Trade Lifecycle

## When to Use

- You compose a trade yourself (`setup:trade_lifecycle`): read this before
  the entry; the gate refuses a composed entry without it.

## How It Works

1. **Compose: the flow, a with-trend pullback** (`trader-process`).
   trend side, a reaction at a level, the trigger closed → compose (`confluence-counting`); the plan, never you, works out R:R. Call
   `compose_check` with one true read per step at least, each your side's
   way (the against stay in the count), and your size. The standard plan
   says OK → compose with its reads. The record is for this bar and side;
   it expires `valid_bars` base bars after its bar's close.

   | Step | The read, your side's way | The skill for the fact |
   | --- | --- | --- |
   | bias | the 4h and 1h both your way give the side (`htf-to-ltf`): `15m down`, `1h bos up`, `trend long allowed`, regime, prior RTH range, read, day type; against it only by step 4 | `multi-timeframe-analysis`, `trend-vs-range`, `daily-bias`, `bos-vs-choch` |
   | location | the pullback into a key level: `at <level>`, `at 15m fvg`, `vwap above`, `value below` | `levels-and-reactions`, `vwap-volume-profile`, `fair-value-gaps`, `compression` |
   | setup | the reaction ending it, the trend's way, on a closed candle above the base: `15m rejected prior vah up`, a gap edge, pattern, `15m cisd down`, a breakout, `15m compression break up` (3m too, a candle later); else never 3m: nothing later confirms it; or a Setups-line setup: `momentum_continuation fired up` (then `3m momentum up`, `stop 3m low <price>`, `target 2r`; market) | `rejection`, `breakout`, `fair-value-gaps`, `pullback-vs-reversal`, `breakout-vs-fakeout`, `cisd`, `candle-reading`, `compression` |
   | entry | continuation on a candle closed after the setup's: `3m close top` (short: bottom), `3m momentum up`, pattern (hammer, bullish engulfing; short: shooting star, bearish engulfing), absorption | `candle-reading`, `momentum-and-volume`, `absorption` |
   | stop | beyond the pullback's extreme: `stop 15m low <price>` (short: high), `stop swing low <price>`, `stop 15m box low <price>` | `invalidation` |
   | target | HTF-aligned: `target trail` (a level ahead is context); else the first level named at 2R or more, beyond any at price or broken: `target 1h swing high <price>`, `target <level> <price>`; none: `target 2r` | `take-profit` |
   | size | contracts | `position-sizing`, `prop-challenge-pacing`, `prop-pacing-judgment` |
   | management | once filled: the record's stop and target exit it; the policy's exit may trail it past the target; never widen it or close early by feel | `manage-position` |

   Support only, never the setup or entry read: `at`, `touched`, `swept`,
   `in ote`, `3m volume high`, `participation high`; a CISD or compression setup is
   timed from its confirming or expansion candle. A refusal's `HINT`
   lines list what is TRUE per step; `HINT these reads pass together` →
   compose them if they are your trade, else pass. Target NOT OK, `HINT target` of
   2R+: re-compose once with it; still NOT OK: pass.

   A normal trade risks about $200-300 (less or a pass is fine; never
   over $300). Target the first real level at 2:1 to 3:1 (about $600); beyond 3:1 only at the real level. In an
   attempt, NOT OK `no size fits`: a closer stop, or pass (healthy, code may
   stretch the floor).

2. **Then read** `confluence-counting` and `invalidation` whenever you
   composed on the bar, `rejection` when a read says a candle rejected a
   level, `breakout` when one says it broke one: in your prompt when it
   embeds them (don't look them up); else load each (no skill tool:
   `skill_lookup`; in index mode the gate requires them). The gate requires
   the journal plan (`[plan-required]`), `setup-judgment` and `trade-plan`
   (`[skills-at-entry]`) and the role round (`[roles-ran]`).
3. **Send it as the record says** (runner runs the entry: `planned`): `place_order` at the record's
   entry (`limit` or better; a fired setup's: `market`), with its `stopLossBracket.ticks`,
   `takeProfitBracket.ticks`, size and contract, rationale
   `setup:trade_lifecycle long|short ...`
   (in an attempt, `setup:prop_portfolio`); `order_plan` gives these and
   refuses a size over code's caps ($300, the broker's max, the verdict);
   in an attempt it translates yours to the rulebook's. No priority order halves a composed trade.
4. **Against the trend**: a true CHoCH read your way at or above its frame
   (15m trend: 15m or 1h; 1h: 1h; 4h: 1h plus `4h rejected <level> up|down`
   your way, a key level, not a gap edge); else the trend rule refuses it.
5. **`[composed-reads]` refusals**: no record for this bar and side, or
   expired (compose again); an entry already placed on this bar and side;
   another contract; a read false, unverifiable or against your side now
   (drop it or pass), or no setup or entry read your way; the plan, ticks, limit or size not the record's. The
   stop is never widened: name a farther level or pass. `[late-entry]`:
   missed the plan's entry, or price past its stop before the order went
   → pass, never late. Exits and protective orders are never held.

| Tool | Arguments | What it returns | Script (people) |
| --- | --- | --- | --- |
| `compose_check` | `symbol`, `side`, `reads`, `size` | each read TRUE, FALSE or UNCHECKED, with or against your side, then the plan in code; recorded, OK or what fails | `compose-check.js --symbol MNQ --side long --size 1 --reads '[...]'` |
| `experience_lookup` | `symbol`, `alternative`?, `role`? | after an OK compose_check, at most 2 a bar: your own past decisions of these skills here, then, when the run shows it (`libraryDisplay`), the code-measured library apart (not yours: counts, win rate, no-room, never R); statistics, never advice | `experience-lookup.js --symbol MNQ` |

**Your risk record**, last in `experience_lookup` when the run shows it
(`riskRecordDisplay`): a line per account state and risk decision
(stand down, size under, exit early, stop the day), counting what
reverting it did over the same Monte Carlo paths:
n is the paths it changed, then the blows it saved or caused and the passes it
cost or gained. "Too few" is no reading yet. Read it as evidence about your own
standing-down habits in that account state,
never a forecast for this trade. A rule from code always overrides it.

## Examples

```text
compose_check {"symbol": "MNQ", "side": "long", "size": 5, "reads": [
{"step": "bias", "skill": "multi-timeframe-analysis", "read": "1h up"},
{"step": "location", "skill": "levels-and-reactions", "read": "at prior vah"},
{"step": "setup", "skill": "rejection", "read": "15m rejected prior vah up"},
{"step": "entry", "skill": "candle-reading", "read": "3m close top"},
{"step": "stop", "skill": "invalidation", "read": "stop 15m low 21512.75"},
{"step": "target", "skill": "take-profit", "read": "target 1h swing 21598"}]}
-> ok, entry 21540.25, stop 111 ticks ($277.50), target 231 ticks ($577.50, 2.08R).
-> place_order MNQ buy 5 limit 21540.25, stopLossBracket.ticks 111,
   takeProfitBracket.ticks 231, rationale "setup:trade_lifecycle long ...".
```
