---
name: mtf-entry
description: An MTF entry arm (replay only) - select among code-surfaced valid pullbacks (ENTER, WAIT or PASS); structural stop; trail. Never against the 1h.
---

# MTF Entry

## When to Use

- The briefing prints `- MTF candidate` lines: an MTF entry arm is on (a replay).
  Read with `bos-vs-choch` (the MTF lines).
- No candidate lines in an MTF arm: no entry this bar.
- Arm A: parent 1h, pullback 15m, trigger 3m. Arm B: parent 15m, pullback 3m,
  trigger 1m. Arm D: the default (non-MTF) entry rules.

## How It Works

**Objective:** enter trends on code-surfaced pullback candidates and capture
continuation with the existing trailing exit. The structure engine establishes
observable facts; you interpret them and select opportunities.

**Market reading**, in order:

1. The parent trend and its protected structure. The side is the primary line's
   1h structure (UP or DOWN); the 4h is context.
2. The MTF pullbacks: active and completed.
3. The setup timeframe's structure relative to the parent (the 15m line decides the
   pullback; the 3m line only times it).
4. The execution timeframe's CHoCH and BOS aligned with the parent.
5. Early internal resumption (the aggressive trigger) against synchronized structural
   resumption (balanced, conservative).
6. Failed execution attempts and renewed countertrend progression.
7. Whether the line prints `candidate void` (code decides void; never compute it).

**Decision rules:**

- Structural readiness is eligibility, not an obligation. A stage word alone is not
  an order.
- Do not assume every BOS or CHoCH is predictive.
- The rank is a fact, not a preference: do not prefer the first pullback because of
  its rank.
- Do not require order blocks, FVGs or Fibonacci retracements.
- Do not reuse invalidated confirmations: a void candidate stays void.
- Never enter against the 1h structure; its trend label is context. For a candidate
  the side is the 1h structure's. The Trend rule line does not refuse a verified MTF
  candidate (the gate exempts it from `[mtf-trend]`).
- The class is a fact to weigh, never a refusal; any class rule is arm D's. Never
  cite the class as a rule. A PASS reason is a candidate-line fact or your own read; the
  class, the 1h label and no 15m turn are context, never the reason.
- Never substitute an unrelated stop for the verified structural invalidation level.
- 3m trigger: WAIT keeps it for the next bar. 1m trigger: ENTER or PASS; a WAIT counts
  as a PASS. PASS rejects this opportunity (this bar only).
- Room: in the candidate's own R.

**State your decision** on its own line, before the CYCLE RESULT line:
`SELECTION: ENTER - <side> <model> <trigger time>: <reason>`, or the same with WAIT or
PASS. The last such line counts; none is an unlabelled decision. Step 8 says the same (ENTER: take; WAIT
or PASS: pass); the SELECTION line is the one that counts.

**Entry and management:** enter only a printed candidate you select; its stop is
`stop mtf`; the Position line's one R basis is the structural stop; the approved trail
manages the stop.

**Evidence discipline:** structure is observable, not proof of direction. Invent no
advantage testing has not shown.

**What prints.** Only READY candidates get a `- MTF candidate` line. READY: code
checked it and it is eligible to select. A printed candidate is eligible at its own
stage, not the primary line's or a context line's; bos-vs-choch's stage actions and
`Entry:` describe the primary line. A stage word names the pullback's stage:
WEAKENING, REVERSING and CONFIRMED REVERSAL mean price turned back toward the parent
trend (a definition, not a forecast). `(chosen)`: the
earliest trigger per side, the only one the gate takes; you select or pass it. Name it
in your SELECTION line and reads (`mtf ready` with another model is refused). A model still waiting is in the one `- MTF waiting`
clause: not ready, not an entry. A void one says so plainly, whatever its reason
("candidate void (stop traded)", "candidate void (price ran 0.8R past the trigger)"):
no entry. `(position open: not a pick)`: context, never an entry.

**A candidate line**, part by part (the 1h structure's way; never a trigger against it):

| Part | Means |
|---|---|
| model, stage | aggressive (the first CHoCH or CISD back), balanced (a CHoCH back, then a BOS), conservative (15m CHoCH + fresh BOS); `(early)`: before the MTF pullback (arm A: 15m; arm B: 3m) is established. Still eligible: the 15m-turn rule and the 3m-trigger rule do not apply |
| trigger 3m or 1m | the timing frame, the candidate's own; its age (`new this bar`, `N min ago`). A 1m candidate is timed by its 1m trigger. A 1m trigger fired since the previous 3m close is current, not expired: it fired inside the bar that just closed; enter or pass now |
| ran NR past the trigger, or NR back toward the stop | how far price moved from the trigger's close, in the trigger's R (its close to the stop). Back toward the stop: still valid. Once any close since the trigger ran over 0.5R past it, the candidate is void for good. A trigger over 60 minutes old, or from an earlier session, is void too |
| 1h turn (the parent's frame: 1h in arm A, 15m in arm B) | a fact, never a wait: the parent's last CHoCH the side's way (this session or the previous one), the BOS that confirmed it, the BOS count since; "N sessions ago (older)"; "no turn": the trend has run since its first break |
| impulse | the move the pullback came from: its size in ATR, bars, displacement candles, cleanness (net move over the bars' ranges, 0-1) |
| pullback #N of this 1h leg | its count since the 1h break that started the leg: a fact to weigh, not a preference |
| depth N% (depth band): the stop X pts away, the impulse extreme Y pts away | how far the pullback retraced the parent impulse (shallow under 30%, moderate 30-75%, deep 75-100%, breached past the protected level) and the room it leaves: judge room against risk, never a forecast; depth alone is not an entry signal |
| structural stop, `$ a contract all in`, `cap fits K` | the stop (the trigger's origin, a tick beyond) and the size the code will take; under the floor: the stretch only while healthy, else skip |
| previous high (exit target) | the exit option; under 1R: weigh whether the room pays; "already past": no exit target, the trail |

**The reads** (`compose_check`):

- An MTF entry cites no setup: the candidate line is the setup. Never add a
  `<strategy> fired` read.
- setup: `mtf ready <model> long|short`: the chosen candidate's model.
- stop: `stop mtf <price>`: the printed structural stop price. An MTF entry takes no
  other stop; no other entry takes `stop mtf`.
- size: the printed `cap fits K`.
- target: `target trail`. The 2R mark arms today's trail. `min_rr` holds.
- bias, location, entry: as always.

**Refusals.** `[mtf-cited]`, `[mtf-target]`, `[mtf-stop]`: fix the read and compose
once more. Every other refusal is final for that bar.

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

- "balanced at stage REVERSING, trigger 3m BOS up 10:12 (new this bar); ran 0R past
  the trigger; ...; depth 45% (moderate): the stop 11.5 pts away, the impulse extreme
  57.75 pts away; structural stop 21528.75". You select it: `SELECTION: ENTER - long
  balanced 10:12: <reason>`, compose `mtf ready balanced long`, `stop mtf 21528.75`, `target trail`.
- The same line, the 3m still pressing into the stop's side: `SELECTION: WAIT - ...` (it
  stays a candidate; the next bar's line decides again).
- "candidate void (price ran 0.8R past the trigger)": no entry; it never comes back.
- An "MTF waiting" clause and no candidate line: nothing to enter.
