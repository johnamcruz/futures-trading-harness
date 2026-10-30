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
   the side rule's side, the setup (15m) at a level closed (the next 3m close times it) → compose (`confluence-counting`); the plan, never you, works out R:R. Call
   `compose_check` with one true read per step at least, each your side's
   way (the against stay in the count), and your size. The standard plan
   says OK → compose with its reads. The record is for this bar and side;
   it expires `valid_bars` base bars after its bar's close.

   | Step | The read, your side's way | The skill for the fact |
   | --- | --- | --- |
   | bias | the side rule gives the side (`htf-to-ltf`): `15m down`, `1h bos up`, `trend long allowed`, regime, prior RTH range, read, day type; never against it (never counter) | `multi-timeframe-analysis`, `trend-vs-range`, `daily-bias`, `bos-vs-choch` |
   | location | the pullback into a key level: `at <level>`, `at 15m fvg`, `vwap above`, `value below` | `levels-and-reactions`, `vwap-volume-profile`, `fair-value-gaps`, `compression` |
   | setup | the reaction ending it, the trend's way, on a closed candle above the base: `15m rejected prior vah up`, a gap edge, pattern, `15m cisd down`, a breakout, `15m compression break up`; in an attempt the 15m or higher (the 3m only times the entry); or a Setups-line setup: `momentum_continuation fired up` (S2, the best-measured entry: P2R 35%; then `3m momentum up`, `stop 3m low <price>`, `target 2r`: the 2R mark that arms the trail, not the exit; market) | `rejection`, `breakout`, `fair-value-gaps`, `pullback-vs-reversal`, `breakout-vs-fakeout`, `cisd`, `candle-reading`, `compression` |
   | entry | the entry timing (3m): the next candle closed after the setup's, its way: `3m close top` (short: bottom), `3m momentum up`, absorption; no 3m turn or break to wait for | `candle-reading`, `momentum-and-volume`, `absorption` |
   | stop | the stop (compose's): one tick beyond the level you name, the setup candle's extreme as a rule: `stop 15m low <price>` (short: high), `stop swing low <price>`, `stop 15m box low <price>`; under the floor refused, never widened | `invalidation` |
   | target | `target trail`: the 2R mark that arms the trail, not the exit (a level ahead is context). Not in a prop attempt, on a side the side rule doesn't give: the first level at 2R or more (`target <level> <price>`), or `target 2r` | `take-profit` |
   | size | contracts; a healthy account (balance ≥ start, no loss streak): the full verdict size, the code computes it | `position-sizing`, `prop-challenge-pacing`, `prop-pacing-judgment` |
   | management | once filled: the stop and the trail exit it (at 2R the policy's exit locks the stop and trails it); never widen it, move it by feel or close early | `manage-position` |

   Support only, never the setup or entry read: `at`, `touched`, `swept`,
   `in ote`, `3m volume high`, `participation high`; a CISD or compression setup is
   timed from its confirming or expansion candle. A refusal's `HINT`
   lines list what is TRUE per step; `HINT these reads pass together` →
   compose them if they are your trade, else pass. Target NOT OK, `HINT target` of
   2R+: re-compose once with it; still NOT OK: pass.

   The stop: compose places it one tick beyond the level your stop read
   names (the setup candle's extreme); never tighter; on the bracket at
   entry. A normal trade risks about $200-300 (never over `risk.max_risk_usd`).
   In an attempt: at least the rulebook's `min_contracts` at the stop,
   else skip (on a healthy account code may stretch the floor); NOT OK
   `no size fits`: pass, never a closer stop.

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
4. **Against the trend**: never (never counter): the trend rule refuses
   it, whatever CHoCH or rejection the reads name.
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
{"step": "target", "skill": "take-profit", "read": "target trail"}]}
-> ok, entry 21540.25, stop 111 ticks ($277.50), target 222 ticks (the 2R mark that arms the trail).
-> place_order MNQ buy 5 limit 21540.25, stopLossBracket.ticks 111,
   takeProfitBracket.ticks 222, rationale "setup:trade_lifecycle long ...".
```
