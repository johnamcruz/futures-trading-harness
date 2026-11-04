# Prepare ahead: reason during the bar, confirm at the close

The design that moves the head trader's reasoning off the clock. Owner-approved
on 2026-11-02 (P1). It is the target design: the build order below says what
exists today and what each PR adds. It follows the ECC architecture
([HARNESS-DESIGN.md](HARNESS-DESIGN.md), CLAUDE.md): the logic in small tested
modules, what the model must know in skills, and the gate unchanged.

## Why

- The head trader's entry turn takes about 24-28 s, with a floor of about 22 s
  even when the bar has no setup: the full trader-process walk-through.
- Most of that walk-through needs only closed bars: the bias, the levels, the
  room, which setups could fire, each one's plan, and the stand-down
  conditions.
- In the eleventh PPC round, 51% of the momentum fires were refused as late.
  Of the 13 that were chased, 62% reached +2R before their stop at the plan
  price.
- The late check reads the newest closed 1m bar, so an order placed under
  60 s after the close is never late.

The owner's rule for it: accurate, not stale, and not late.

## Goal

- **Close to order:** at most about 25 s median at a 3m close (a momentum
  fire), and at most about 50 s at a 15m close. In both cases the p90 stays
  under 60 s, the late check's cliff.
- **What stays:** all of the head's reasoning (moved earlier, never cut), the
  desk, phase 2, the executor and the gate.

## The two phases

### Prepare: during the bar, off the clock

- **When:** after the cycle at close T is final (its entry or management,
  and at a 15m close the desk's reports). It must be done by T+180 s minus a
  margin (config). If it is not, it is void, and the close runs the full
  cycle as today.
- **Input:** closed bars only: every timeframe up to T, the latest valid desk
  reports, the account facts (the phase-1 facts key) and the head's skills.
  Never the bar forming.
- **The briefing section "Possible at the next close"** (code, below).
- **The head's prepare turn:** a model run with read-only tools; no
  `compose_check` and no order tool. It writes a bar plan, one line per
  scenario, in the briefing's read names:
  - `SCENARIO k: <candidate> → TAKE if <conditions on the closing candle> | PASS if <…>; reads: <the compose reads>; why: <one line>`
  - `STAND DOWN if: <account, room, window, news, a level breaking>`
  - `INVALID if: <what voids the plan before the close>`
- **Recorded:** the plan and the version of every input (the bar versions
  per timeframe, the facts key, the desk report keys, the briefing's as-of),
  in the cycle log and a plan file.
- **Skipped** when the section says nothing can fire (its `NONE` marker):
  the close then runs the cycle as today.

### Confirm: at the close, on the clock

1. **Code: is the plan still valid?** Every recorded input version is
   compared with the close's: a fill, a position or a P&L change (the facts
   key), the trend rule's side flipping, a news or stand-down window
   starting, a higher timeframe closing in a way no scenario covered. Any
   change voids the plan, and the full cycle runs.
2. **Code: does it match?** Is what the at-close briefing says fired (its
   "Setups to check" or its rules setups) one of the plan's scenarios, by
   read name?
3. **The head's confirm turn:** it resumes the prepare session (its prefix
   cached, its own reasoning in context), the at-close facts first (the new
   candle, the reaction, what fired, the Standard plan), then "your plan
   said: scenario k". Its rule: **the candle decides: confirm a scenario only
   if the closed candle meets its TAKE conditions; else pass.** It then calls
   `compose_check` with the plan's reads, or passes. Something outside the
   plan fired: it reasons fully in the same turn.
4. **Then** phase 2, the executor and the gate, as today.

**The gate is unchanged.** It checks the compose record built at the close
against the at-close briefing and the live account. Nothing prepared is
trusted by any check, so nothing can fail open on it.

## "Possible at the next close" (built: PR A)

`scripts/lib/trading/next-close.js`, tested in `tests/lib/next-close.test.js`.

### When it applies

- `possibleAtNextClose({ symbol, bars, minutes, briefing, flat, registry, strategies, selected, entryRule, inAttempt, paper, sizing, blackouts, clock, roundSteps, setupTf })`
  takes the closed bars the briefing for bar T was built from (its `asOf`
  must be their last bar, else it throws: a bundle that holds the bar
  forming or later ones is refused) and lists what can fire at the close of
  bar T+1. What the runner passes, as its own at-close code uses it:
  - `registry`: the loaded strategies (`loadStrategies`, as the gate loads
    them). Production passes it; without it the shipped tree is loaded once
    and cached for the process.
  - `strategies` and `selected`: the lane's strategies and the runner's
    symbols, as its scan (`runner-wiring.js` `runnerScan`); the threshold
    candle is scanned with them, at the next close (`now`).
  - `entryRule`, `inAttempt`, `paper`: what `compose_check` uses (the attempt
    policy's entry rule, `entryRuleOf`; whether an attempt is running, so the
    size is a suggestion; `FTH_PAPER`), for the momentum and the reaction
    plans alike.
  - `sizing`, `blackouts`, `clock`, `roundSteps`: below, and as the
    briefing's.
  - `setupTf`: the setup frame (default the 15m, `setup-moments.js`).
- `flat` must be `true` (no position, no working order); otherwise it
  returns null and there is no section. A management cycle is untouched.
- No entries at the next close (its session window, `sessionWindow`, or a
  news blackout, `newsState`, both at that close) gives the `NONE` marker
  with the reason. So does no candidate at all, with what was ruled out.
- Deterministic: the same bars give the same section, and nothing after
  bar T is read.

### Momentum candidates

- **Which:** each rules strategy that `trade_lifecycle` may cite
  (`citedSetups`; today `momentum_continuation`) on the base timeframe,
  for each side whose rules hold exactly one `htfd_momentum(<base>) > 0`
  (`< 0` for a short) condition.
- **The trigger, on the closing candle:** the momentum read
  (`momentum.js` `momentumRead`), unrounded as the rules engine reads it.
  Its inputs come only from the candles before the closing one
  (`candle-facts.js` `nextBasisOf`, the same `basisOf` and `factOf` that
  `factsOf` runs):
  - the range against the ATR(14) **as of the candle before it** (the closing
    candle's own range is not in it);
  - the volume against the mean of **up to the 20 candles before it** (at
    least 5; its own volume is not in it);
  - the close in the far third (`closeLocation`).

  So the thresholds are numbers known before the close: the least range in
  ticks and the least whole volume that read as momentum, found by asking
  `momentumRead` itself. The briefing's own `momentum` fact reads rounded
  ratios (1.00x shown for 0.996x); the trigger never does.
- **Listed** when the strategy's scan (`strategies.js` `scan`) fires that
  side on the closed bars plus the threshold candle (the least candle that
  meets the trigger, opening at the last close). Its other rules (the entry
  rule's side, `chain_side`; the window, `minute_et`) are its listed
  **preconditions**: they hold for the threshold candle, and code evaluates
  them again at the close. The evaluator's own checks (session, trend rule,
  filters) passed for the threshold candle too; they are not listed, and the
  close's scan runs them again.
- **Not computable:** an ATR or a volume average that is unknown or not
  finite, an average of 0, or a threshold past whole-number counts: no
  candidate, with the reason.

### Reaction candidates (at a 15m close)

- **When:** only when the next close completes a candle of the setup frame
  (the 15m; `setup-moments.js`) and at least one of its bars has closed.
- **Which levels:** the fixed key levels (`setup-moments.js` `KEY_LEVEL`) as
  they stood at the candle's open (`briefing.js` `candleLevelsAt`, the
  function the briefing's candles read), in reach: those inside the
  candle's range so far, and the nearest one beyond its high and beyond its
  low.
- **The trigger:** a rejection or a break as `candle-facts.js` `relation`
  defines it on the completed candle. Its open and its range so far are
  known; the closing bar adds its high, low and close. A break needs the
  close at or beyond a stated price (most of the body beyond the level). A
  rejection needs the candle to have traded beyond the level (already, or at
  a stated price) and the close back on the near side. `relation` decides
  every threshold.
- **Sides:** a side the trend rule refuses as it reads now (the bar T
  briefing's line, `trendRuleOf` false) is left out, as `standardPlans`
  refuses it. A side whose trend rule can't be read is listed, its
  precondition saying so ("unknown now"). The close's own trend rule
  decides: it is the candidate's precondition.
- **Not listed in v1:** the moving levels (the VWAP and the session profile:
  their value at the close moves with the closing bar) and the fair value
  gaps' edges (read through the gap's side). One of those reacting at the
  close is outside the plan, and the confirm reasons fully on it.

### The plan, for each candidate

- The rule in words, from the strategies' own numbers: the entry, the stop
  rule, the target rule.
- The plan code makes for the threshold candle, on the at-close briefing
  built from the closed bars plus that candle:
  - **momentum:** compose's plan of its cited reads (`checkReads`, then
    `planOf`): market from the close, its own stop (its `risk.stop`, at
    least `risk.stop_min`, ceil to ticks, never under compose's floor), its
    2R target;
  - **reaction:** the Standard plan's (`setup-library.js` `composeAt`, the
    call `standardPlans` makes): a limit at the close, the stop one buffer
    beyond the candle's far side, the first named level at the Standard
    plan's min R:R, else the 2R mark. It is checked with the attempt
    policy's entry rule, as `compose_check` applies it (`bias_agree`,
    `regime_against`, `leg_turned`). The at-close Standard plan line reads no
    entry rule, so the section can say refused where that line says OK:
    `compose_check` is the authority.
- **Size:** with the account's sizing facts (`sizing`: `{ capUsd, floor,
  tickValue, slipTicks, feePerSide, stretchUsd }`; the caller gives the cap
  in force), `size-translate.js` `floorFit` at the plan's stop: how many fit
  under the cap all in, whether the floor fits (else a skip, or exactly the
  floor by the floor stretch while healthy), and the widest stop the floor
  fits at. Without the facts, no size is stated.
- Every read is the briefing's read name, so a bar plan's reads parse in
  `compose_check`.

### Rendering

`possibleLines(section)` gives the briefing lines; `renderPrepareBriefing(b,
section)` is the briefing's text with them after its summary. The at-close
briefing (`renderBriefing`) never has the section, and nothing in production
asks for it yet: every existing briefing, golden and prompt is unchanged.

## Freshness

- **Prepare:** closed bars only, and versioned.
- **Confirm:** gets the at-close facts, never the prepared ones.
- **Any version change voids the plan.**
- **The late check:** close-to-order of about 15-25 s is under the 1m
  cliff. The real sub-minute drift is small but unmeasured in replay (1m
  fills), so the report adds an interpolated drift estimate.

## What PR B must handle

- **Preconditions move with the closing candle.** `chain_side` reads the
  declared trend when the 4h and 1h both range (the close, the VWAP, EMA20),
  and a 15m or 1h close updates the frames it reads. The trend rule can
  change the same way. The confirm's validity check voids the plan when the
  side flips. On the fixture's census sessions no precondition flipped
  (`tests/lib/next-close.test.js`).
- **The bar window.** The thresholds are exact only when the close's bars
  are the prepare's bars plus one: ATR(14) is Wilder's (it depends on the
  first bar) and the 4h read needs the long window. A runner that trims its
  bars to a fixed count shifts the start every bar; the prepare must use the
  same window the close will.
- **Standing setups.** At the next close "Setups to check" still lists the
  setups standing from earlier closes (a 15m reaction's confirmation phase,
  a compression break, a live CISD), whatever the closing candle does. They
  are not in this section; matching them is the confirm's.
- **Moving levels and gap edges** (above): outside the plan in v1, by the
  owner's decision (momentum and the fixed key levels only).
- **The inputs the runner passes** (above): its lane's strategies and
  selected contracts, and compose's entry rule, attempt and paper flags, so
  the threshold scan and plan are the ones the close runs.
- **A trigger tests only its own bar.** `triggerMet` is false for a bar
  whose `t` is not the next bar's open the section was prepared for,
  compared as instants (`Date.parse`: an ISO time with or without
  milliseconds or an offset is the same bar), so a data gap or a late bar
  never tests the wrong candle. The confirm matches the bar by time first.
- **A roll or a back-adjusted history.** Either changes the bars and the
  levels between the prepare and the close; the plan's recorded bar
  versions must void it.
- **Measure the outside-plan share on actual entries,** by level class
  (listed, VWAP and session profile, gap edges, standing setups, a trend
  rule flip), not only on the census reactions below.
- **Volumes:** the stated volume threshold is the least whole number; the
  trigger itself (`triggerMet`) is the rule's own ratio.

## Coverage on the fixture

On the momentum fixture's census days (`tests/fixtures/momentum-continuation`,
NQ 3m, 2021-05-17 to 2021-05-24), at every 15m close from 09:45 to 15:45 ET
that allowed entries (126 closes), a scratch scan compared the listed
reactions with the at-close setup moment:

- the 422 listed reactions agreed with the at-close read every time;
- of the 146 directional reactions that fired at those closes, 57 were on a
  side the close's trend rule refuses;
- of the other 89, 72 (81%) were listed and 17 (19%) were outside the plan:
  9 at a moving level (the VWAP), 6 at a gap edge, and 2 on a side the trend
  rule refused at the prepare and allowed at the close;
- no fixed key level on an allowed side and in reach fired unlisted.

On the 29 census momentum fires, every one was listed and its trigger met,
with no precondition flipping (`tests/lib/next-close.test.js`).

## Process model

- **v1: resume.** The confirm is a new CLI process that resumes the
  prepare's session at the close, with the close's cycle env, so the hook,
  the gateway and `compose_check` attribute it to the close's cycle
  unchanged. Every transcript-based gate check judges only the confirm's
  turns. Prepare runs are denied `compose_check` and every order tool.
- **v2: a warm process** (later, only if needed: a gate change).

## The desk and phase 2

- **v1:** at a 15m close the desk runs as today, and the confirm waits for
  its reports. Phase 2 runs as today.
- **v2:** the analysts and phase 2 prepare too.

## Replay is live

- The replay runs the prepare between closes on the replay clock, charged
  against the bar's 180 s: a prepare running past the bar makes the next
  cycle late, exactly as live.
- The forming bar is never served to the prepare.
- The goal regression's tier-2 mock head implements both phases, or tier 2
  measures the old path.

## Config and data

- **Key:** `prepareAhead`, opt-in, in the head's delivery keys, so its runs
  are never pooled with runs without it (PR B).
- **Tunables:** the prepare deadline margin and the maximum prepare time.
- **Logged:** prepare ms, confirm ms, the plan outcome (hit, outside, void,
  skipped, timed out), the fallback rate, close-to-order, the late kind and
  the drift estimate.

## Risks

1. **Anchoring:** the model confirms its plan against the candle. The
   mitigations: the facts first, "the candle decides", quiz traps, the paired
   decision comparison.
2. **Coverage:** something unanticipated fires, so it falls back to full
   reasoning (slower). Measured.
3. **Cost:** about +20-30% head tokens, less with the skip.
4. **Management first:** stop moves and trail actions at the close are never
   delayed by a prepare.
5. **Complexity:** the session resume and the gate's cycle attribution,
   covered by wiring tests.

## Build order

Each is its own PR, with the adversarial review and the goal regression.

1. **A (this):** the briefing section, its tests, this document.
2. **B:** the runner's prepare and confirm (resume, versions, void,
   fallback, deadline, skip), the opt-in key, the logging, the hook and
   gateway wiring tests for the cycle attribution, the tier-2 mock with both
   phases.
3. **C:** the skills (the prepare format and the confirm rule), the context
   quiz and its new questions (confirm on a met candle, pass on an unmet
   one, the anchoring trap).
4. **The paired test** on the eleventh PPC round's momentum and composed
   days, against today: decision agreement, close-to-order, late refusals,
   the fallback and void rates, R; 0 blows.
5. **Then** a PPC round with it on.
