---
name: mtf-entry
description: An MTF entry arm (replay only) - select among code-surfaced valid pullbacks (ENTER, WAIT or PASS); structural stop; trail. Never against the 1h.
---

# MTF Entry

## When to Use

- The briefing prints `- MTF candidate` lines: an MTF entry arm is on (a replay;
  `config/runner.json` `mtfEntry`). Read with `bos-vs-choch` (the MTF lines) and
  `pullback-vs-reversal`.
- No candidate lines: this skill does not apply; today's entry rules do.

## How It Works

**Objective:** enter valid trends during structurally confirmed pullbacks and capture
continuation with the existing trailing exit. The structure engine establishes
observable facts; you interpret them and select opportunities.

**Market reading**, in order:

1. The parent trend and its protected structure (the 1h side: the primary line's
   "1h structure UP" or "DOWN"; the 4h "(context)" is context, not a refusal).
2. The active and completed pullback instances.
3. The setup timeframe's structure relative to the parent (the 15m line decides the
   pullback; the 3m line only times it).
4. The execution timeframe's CHoCH and BOS aligned with the parent.
5. Early internal resumption (the aggressive trigger) against synchronized structural
   resumption (balanced, conservative).
6. Failed execution attempts and renewed countertrend progression.
7. Whether the current candidate remains actionable (not void, not stale).

**Decision rules:**

- Structural readiness is eligibility, not an obligation. A stage word alone is not
  an order.
- Do not assume every BOS or CHoCH is predictive.
- The rank is a fact, not a preference: do not prefer the first pullback because of
  its rank.
- Do not require order blocks, FVGs or Fibonacci retracements.
- Do not reuse invalidated execution confirmations: a void candidate stays void.
- Never enter against the 1h (never against it). In an MTF arm the side is the 1h
  structure's: today's trend rule line does not refuse a verified MTF candidate (the
  gate exempts a verified MTF entry from `[mtf-trend]`).
- The Market state class describes the market: weigh it like any other fact. It is
  not a refusal and not a rule.
- Never substitute an unrelated stop for the verified structural invalidation level.
- WAIT keeps an active candidate for a later bar (a 3m trigger); a 1m-trigger candidate
  lives one bar, so a WAIT on it is a pass. PASS rejects this opportunity.

**State your decision** on one line of its own, at the line's start, before the
CYCLE RESULT line: `SELECTION: ENTER - <reason>`, `SELECTION: WAIT - <reason>` or
`SELECTION: PASS - <reason>`, naming the candidate (side, model, trigger time). The
last such line counts; none is an unlabelled decision. In the PLAN, step 8's decision
and the SELECTION line say the same thing; the SELECTION line is the one that counts.

**Entry and management:** enter only when the candidate is structurally valid and you
select it; the verified execution invalidation stop (`stop mtf`); keep the original
risk reference throughout (the Position line's one R basis: the structural stop); the
approved trail manages the stop.

**Evidence discipline:** structure is observable information, not proof of future
direction. Do not invent advantages for patterns testing has not shown.

**What prints.** Only READY candidates get a `- MTF candidate` line; the earliest
trigger per side is `(chosen)`, the only one the gate takes: name it in your
SELECTION line and your reads (`mtf ready` with another model is refused, "the ready
candidate is X, not Y"). A model still waiting is in the one `- MTF waiting`
clause: not ready, not an entry. A void one says so plainly, whatever its reason
("candidate void (stop traded)", "candidate void (price ran 0.8R past the trigger)"):
no entry. `(position open: not a pick)`: context, never an entry.

**A candidate line**, part by part (the trend's way: never a counter-trend trigger):

| Part | Means |
|---|---|
| model, stage | aggressive (the first CHoCH or CISD back), balanced (a CHoCH back, then a BOS), conservative (15m CHoCH + fresh BOS): the models `mtfEntry.models` enables; `(early)`: before the 15m pullback is established |
| trigger 3m or 1m | the timing frame, the candidate's own; its age (`new this bar`, `N min ago`). A 1m candidate is timed by its 1m trigger: today's 3m pullback trigger does not apply to it. A 1m trigger fired since the previous 3m close is current: it fired inside the bar that just closed; enter at the next bar or pass (this bar or never) |
| drift NR past the trigger | how far price ran past the trigger's close, in the trigger's R (its close to the stop). Negative: the price is back toward the stop, the stop closer than at the trigger: not stale, not void. Once any close since the trigger was over 0.5R the candidate is void for good; a trigger over 60 minutes old, or from an earlier session, is void too |
| fresh turn | the parent's last CHoCH the side's way (this session or the previous one) and the BOS that confirmed it, the BOS count since; "turn N sessions ago (not fresh)": older; "no turn": the trend has run since its first break |
| impulse | the move the pullback came from: its size in ATR, bars, displacement candles, cleanness (net move over the bars' ranges, 0-1) |
| pullback #N of this 1h leg | its count since the 1h break that started the leg: a fact to weigh, not a preference |
| depth N% (class): the stop X pts away, the impulse extreme Y pts away | how far the pullback retraced the parent impulse (shallow under 30%, moderate 30-75%, deep 75-100%, breached past the protected level) and the room it leaves: judge room against risk, never a forecast; depth alone is not an entry signal |
| structural stop, `$ a contract all in`, `cap fits K` | the stop (the trigger's origin, a tick beyond) and the size the code will take; under the floor: the stretch only while healthy, else skip |
| previous high (exit target) | the exit option; under 1R: weigh whether the room pays; "already past": no exit target, the trail |

**The reads** (`compose_check`):

- An MTF entry cites no setup: the candidate line is the setup. Never add a
  `<strategy> fired` read.
- setup: `mtf ready <model> long|short`: the chosen candidate's model.
- stop: `stop mtf <price>`: its structural stop (the printed one, or its origin). An
  MTF entry takes no other stop, and no other entry takes `stop mtf`.
- target: `target trail`. The 2R mark arms today's trail. `min_rr` holds.
- bias, location, entry: as always.

**Refusals** (each one is final for that bar):

- `against the 1h structure`: wrong side.
- `[mtf-cited]`: you cited a setup beside an MTF entry. Remove the `fired` read and
  compose again with the MTF reads only.
- `[mtf-target]`, `[mtf-stop]`: its target is `target trail`; its plan's stop is the structural stop;
  `stop mtf` on any other entry.
- `withheld: <reason>`: stop traded, a warning close, the 1m
  trigger before the previous close, ran past (a close since the trigger over 0.5R),
  too old (over 60 minutes), an earlier session, drift unknown, a position open.
- `[entry-mode]`: in arms A, B and AB only MTF entries go. Outside a replay an MTF arm
  enters nothing.
- `[late-entry]` beyond-stop: price already went through the structural stop.
- `MTF structure: unavailable`, `MTF 1m execution: unavailable`: no MTF entry.

**Exit.** `trail`: today's exit from the structural stop (1R, the +0.5R lock, the
structure trail). `prev_high_or_trail`:

- Before the target, today's stop management.
- A 3m candle that touches the target and closes back: the runner closes at market.
- A 15m close past it: ride the trail.

The Position line prints `target X (previous high): not reached | rejected | broken: riding`.

## Examples

- "balanced at stage REVERSING, trigger 3m BOS up 10:12 (new this bar); drift 0R past
  the trigger; ...; depth 45% (moderate): the stop 11.5 pts away, the impulse extreme
  57.75 pts away; structural stop 21528.75". You select it: `SELECTION: ENTER - long
  balanced 10:12`, compose `mtf ready balanced long`, `stop mtf 21528.75`, `target trail`.
- The same line, the 3m still pressing into the stop's side: `SELECTION: WAIT - ...` (it
  stays a candidate; the next bar's line decides again).
- "candidate void (price ran 0.8R past the trigger)": no entry; it never comes back.
- An "MTF waiting" clause and no candidate line: nothing to enter.
- The 1h structure UP and a short idea: never.
