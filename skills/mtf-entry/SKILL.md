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

1. The parent trend and its protected structure. The side is the primary line's
   "1h structure UP" or "DOWN". The 4h "(context)" is a fact, never a refusal.
2. The MTF 15m pullbacks (the primary line): active and completed.
3. The setup timeframe's structure relative to the parent (the 15m line decides the
   pullback; the 3m line only times it).
4. The execution timeframe's CHoCH and BOS aligned with the parent.
5. Early internal resumption (the aggressive trigger) against synchronized structural
   resumption (balanced, conservative).
6. Failed execution attempts and renewed countertrend progression.
7. Whether the current candidate remains actionable (not void).

**Decision rules:**

- Structural readiness is eligibility, not an obligation. A stage word alone is not
  an order.
- Do not assume every BOS or CHoCH is predictive.
- The rank is a fact, not a preference: do not prefer the first pullback because of
  its rank.
- Do not require order blocks, FVGs or Fibonacci retracements.
- A void candidate stays void.
- Never enter against the 1h structure. The 1h trend label is context.
- For a candidate the side is the 1h structure's. The Trend rule line does not refuse
  a verified MTF candidate: the gate exempts a verified MTF entry from `[mtf-trend]`.
- The class is a fact to weigh, never a refusal. Any class rule (sit out, no trend
  trade, avoid trend entries, a take needs the class and your 4h and 1h) is arm D's.
- A PASS gives your own reason. Never cite the class as a rule.
- Never substitute an unrelated stop for the verified structural invalidation level.
- 3m trigger: WAIT keeps it for the next bar. 1m trigger: ENTER or PASS (it lives one
  bar). PASS rejects this opportunity.

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

**What prints.** Only READY candidates get a `- MTF candidate` line. READY: eligible
to select (bos-vs-choch's `Entry:` fact is arm D's). A candidate's stage is printed on
its own line (arm B: the 15m > 3m pullback timed on the 1m). bos-vs-choch's stage
actions describe the primary line. A printed candidate is eligible at its own stage,
not the primary line's or a context line's. A stage word names the pullback's stage:
WEAKENING, REVERSING and CONFIRMED REVERSAL are the trend resuming, never ending.
The earliest trigger per side is `(chosen)`: the only one the gate takes. Name it in
your SELECTION line and your reads (`mtf ready` with another model is refused: "the
ready candidate is X, not Y"). A model still waiting is in the one `- MTF waiting`
clause: not ready, not an entry. A void one says so plainly, whatever its reason
("candidate void (stop traded)", "candidate void (price ran 0.8R past the trigger)"):
no entry. `(position open: not a pick)`: context, never an entry.

**A candidate line**, part by part (the 1h structure's way; never a trigger against it):

| Part | Means |
|---|---|
| model, stage | aggressive (the first CHoCH or CISD back), balanced (a CHoCH back, then a BOS), conservative (15m CHoCH + fresh BOS): the models `mtfEntry.models` enables; `(early)`: before the MTF 15m pullback is established. Still eligible: no 15m turn and no 3m trigger rule apply (the Pullback setup and its three lines are arm D's) |
| trigger 3m or 1m | the timing frame, the candidate's own; its age (`new this bar`, `N min ago`). A 1m candidate is timed by its 1m trigger: today's 3m pullback trigger does not apply to it. A 1m trigger fired since the previous 3m close is current: it fired inside the bar that just closed; enter at the next bar or pass (this bar or never) |
| ran NR past the trigger, or NR back toward the stop | how far price moved from the trigger's close, in the trigger's R (its close to the stop). Back toward the stop: still valid. Once any close since the trigger ran over 0.5R past it, the candidate is void for good. A trigger over 60 minutes old, or from an earlier session, is void too |
| 1h turn (the parent's frame) | the parent's last CHoCH the side's way (this session or the previous one) and the BOS that confirmed it, the BOS count since; "turn N sessions ago (older)": older; "no turn": the trend has run since its first break |
| impulse | the move the pullback came from: its size in ATR, bars, displacement candles, cleanness (net move over the bars' ranges, 0-1) |
| pullback #N of this 1h leg | its count since the 1h break that started the leg: a fact to weigh, not a preference |
| depth N% (depth band): the stop X pts away, the impulse extreme Y pts away | how far the pullback retraced the parent impulse (shallow under 30%, moderate 30-75%, deep 75-100%, breached past the protected level) and the room it leaves: judge room against risk, never a forecast; depth alone is not an entry signal |
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
