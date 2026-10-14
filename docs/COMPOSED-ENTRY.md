# Composed entry: design

Status: a design for the owner's OK. Nothing in it is built. Every claim
about today's code names its file and line on `main` at the time of writing.

## 1. Goal

The reasoning model trades on its own. At each bar it combines its skills in
the order bias, location, setup, entry, stop, target, and either places that
combination or passes. Strategies stay as worked examples and as a baseline
to compare against. No sweep, TPE or strategy-combo search picks the
combination: the model does.

Two things are mechanical and stay mechanical. Every part of a combination
must be a fact that code checks before the order goes ("verified reads").
Risk is code: the gate fails closed and never holds an exit, sizing is a
share of the account's cushion above its MLL floor, and the zero-blow goal
stays.

This design covers the foundation only: how a composed entry is stated,
checked, sized, gated and recorded. The learning loop (practice in replay,
score each combination, an append-only log, an index, an
`experience_lookup` tool) is sketched in section 5 so the foundation doesn't
block it. It is built later, in its own design.

### The two acceptance trades

**Scenario 1, the owner's ideal trade:** bias up (60m BOS up, holding above
the prior-day high); location: the prior VAH; setup: a 15m rejection
candle; entry: a 3m bullish close with momentum; wrong below 21512.75;
target the next 60m swing, 21598.00.

| Step | Skill | Briefing field | Verifier today |
|---|---|---|---|
| Bias: 60m BOS up | `bos-vs-choch` | `h1.lastBreak.last` (`briefing.js:440`, `structure-events.js:39`) | None. `fact-claims.js` checks `1h up` (the trend), not a break |
| Bias: above the prior-day high | `daily-bias`, `levels-and-reactions` | `m3.location.priorRthRange` (`briefing.js:406`) | None (closed forms: `fact-claims.js:74`) |
| Location: prior VAH | `vwap-volume-profile` | `day.priorProfile.vah` (`briefing.js:449`); the candle's meeting of it in `m3.candles.<tf>.levels` | `value inside\|above\|below` only (price against the area, not a touch) |
| Setup: 15m rejection | `rejection`, `candle-reading` | `m3.candles.15m.levels["prior VAH"]`, `pattern` (`candle-facts.js:438-447`) | None |
| Entry: 3m bullish close, momentum | `candle-reading`, `momentum-and-volume` | `m3.candles.3m.closeLocation`, `pattern`, `rangeAtr`, `volRatio` | None. No shared momentum read exists |
| Stop: below 21512.75 | `invalidation` | a candle low, `m3.swings`, `m3.liquidity.swingLows` | None. Stops come only from a strategy's scan (`order-plan.js:54-69`) |
| Target: 60m swing 21598.00 | `top-down-entry` | `m3.swingTargets.above[frame=60m]` (`briefing.js:419`) | None. Targets come only from a strategy's exit |

Every fact scenario 1 needs is already in the briefing. What is missing is
the verifier and a path for the order.

**Scenario 2, the owner's chart:** a 4h candle sweeps the prior 4h low and
closes back; a 5m bullish structure shift follows; entry on the 5m FVG
retest; target the 4h high.

| Step | Skill | Briefing field | Status |
|---|---|---|---|
| 4h sweep of the prior 4h low, close back | `breakout-vs-fakeout`, `rejection` | none: candle facts cover 3m, 5m, 15m, 60m (`candle-facts.js:74`); a 1h candle only meets the "CRT 4h range low" level (`candle-facts.js:425-429`) | Missing fact |
| 5m bullish structure shift | `bos-vs-choch` | none: `lastBreak` is on the trigger bars, 15m and 1h (`briefing.js:383, 427, 440`) | Missing fact |
| Entry: 5m FVG retest | `fair-value-gaps` | none: FVGs are on the trigger bars only (`briefing.js:379`), the last three (`market-snapshot.js:258`) | Missing fact |
| Stop | `invalidation` | the 5m swing low of the shift | Missing with the 5m structure |
| Target: the 4h high | `top-down-entry` | none: swing targets are on the base bars, 15m and 60m (`briefing.js:419`) | Missing fact |

Scenario 2 needs new facts first (section 7).

## 2. What blocks a model-originated entry today

| Where | What it does |
|---|---|
| `order-gate.js:38, 273-275` | `setup-tag`: the rationale opens with `setup:<name>` |
| `order-gate.js:276-278`, `strategies.js:558-578` | `strategy`: the name is a strategy document that is valid, `active`, trades the contract and is in its sessions |
| `order-gate.js:299-302` | `trigger-fired`: a rules strategy's own trigger fired on the side, on a recent bar (hard) |
| `order-gate.js:320-325` | `combine`: while a prop attempt runs, only a policy strategy may enter, and its entry needs a runner verdict recorded at a scan candidate (`prop-state.js:465-496`) |
| `agents/risk-manager.md:84-91` | Step 0 vetoes any plan the scan doesn't list as a candidate (a manual strategy aside) |
| `agents/risk-manager.md:111-127`, `harness-tools/order-plan.js:58, 64` | `order_plan` plans only a rules candidate or a policy verdict; the risk manager vetoes on its refusal |
| `skills/trade-plan/SKILL.md:57-60` | The numbers come from `order_plan`, never the model's arithmetic |
| `fact-claims.js:74, 156-198` | Phase-2 FACTS are a closed set (window, entries, news, trend, read, tf, vwap, value, room); a room fact must match the order's setup among `m3.candidates` (`fact-claims.js:261-268`) |
| `trading/reasons.js:89`, `replay/scorecard.js:34, 135` | No setup on the bar means the expected decision is no trade; an entry there scores `bad size` |
| `replay/labels.js:31, 888-909` | A target other than the strategy's own exit is a clone reason |
| `decision-history.js:60, 97-104` | The history names the setup from the order's tag and the scan; a composed entry has no scan setup |
| `skills/trader-process/SKILL.md:19, 37, 44` and `rejection:16-19`, `breakout:16-19`, `top-down-entry:30`, `absorption:48`, `fib-retracement:65`, `cisd:53` | Doctrine: no setup without a fired strategy |

A `signal: manual` strategy is the nearest thing today (`strategies.js:34`),
and no strategy uses it. It is not the answer: the gate never checks a
manual trigger (`trigger-fired` is for rules strategies only,
`order-gate.js:299`), `order_plan` refuses it (`harness-tools/order-plan.js:64`),
and its room facts can't match a candidate. A composed entry is, in effect,
a manual strategy whose trigger code verifies.

## 3. The composed entry

### 3.1 How the model states it

The model calls one new harness tool, `compose_check`, with its combination
as a list of reads, one per step:

```json
{
  "symbol": "MNQ", "side": "long",
  "reads": [
    { "step": "bias",     "skill": "bos-vs-choch",       "read": "1h bos up" },
    { "step": "bias",     "skill": "daily-bias",         "read": "above prior RTH high" },
    { "step": "location", "skill": "vwap-volume-profile","read": "at prior VAH" },
    { "step": "setup",    "skill": "rejection",          "read": "15m rejected prior VAH up" },
    { "step": "entry",    "skill": "candle-reading",     "read": "3m close top" },
    { "step": "entry",    "skill": "momentum-and-volume","read": "3m momentum up" },
    { "step": "stop",     "skill": "invalidation",       "read": "stop 15m low 21512.75" },
    { "step": "target",   "skill": "top-down-entry",     "read": "target 60m swing 21598.00" }
  ]
}
```

Each `read` is one closed form, parsed the way `fact-claims.js` parses FACTS
items today (no negations, no brackets, ASCII only; `fact-claims.js:92-94`).
Code maps the form to its briefing field; the model never names the field.
`skill` is recorded, not checked against the form, except that it must be a
skill folder that exists.

### 3.2 The read vocabulary

The closed set grows from today's FACTS forms. Each form is one fact field
and one comparison.

| Step | Form | Field | Today |
|---|---|---|---|
| bias | `<tf> up\|down\|range` | `m15.frame.trend`, `h1.h1.trend`, `h1.h4.trend` | Exists (`fact-claims.js:66`) |
| bias | `<tf> bos\|choch up\|down` (60m is written 1h) | `<section>.lastBreak.last` (3m, 15m, 1h) | Field exists; form new |
| bias | `above\|below\|inside prior RTH range` | `m3.location.priorRthRange` | Field exists; form new |
| bias | `trend <side> allowed`, `read <side> <label>` | `m3.trendRule`, `m15.alignment` | Exists |
| location | `at <level name>` | the level within the trigger candle's range, or in `m3.candles.<tf>.levels` | Fields exist; form new |
| location | `vwap above\|below\|at`, `value inside\|above\|below` | `m3.vwap.side`, `m3.location.priorValue` | Exists |
| setup | `<tf> rejected\|broke <level name> up\|down` | `m3.candles.<tf>.levels[<level>]` | Field exists as text (`candle-facts.js:336`); a structured `rel`/`dir` is a small add |
| setup | `<tf> pattern <name>` | `m3.candles.<tf>.pattern(s)` | Field exists; form new |
| setup | `<tf> cisd up\|down`, `in ote` | `m3.cisd` (`briefing.js:415`) | Field exists; form new |
| setup | `swept <level name>` | `m3.sweeps` (`structure-events.js:71`) | Field exists; form new |
| setup | `<tf> fvg retest up\|down` | per-timeframe FVGs | Missing beyond the trigger bars |
| entry | `<tf> close top\|middle\|bottom` | `m3.candles.<tf>.closeLocation` | Field exists; form new |
| entry | `<tf> momentum up\|down` | a shared momentum read | Missing (definition: owner decision D4) |
| stop | `stop <source> <price>` | the source's price (section 3.4) | Fields exist; form new |
| target | `target <source> <price>` | the source's price (section 3.4) | Fields exist; form new |

A read is true, false or unchecked, as FACTS claims are
(`fact-claims.js:26`). The combination stands only when every read is
true, at least one read covers each of the six steps, and the stop and target
reads are present. Any false or unchecked read refuses it, naming the read.

### 3.3 The composed record

`compose_check` checks the reads against the cycle bar's briefing (the same
`briefingFor` the gate uses, `fact-claims.js:325`), then works out the
plan in code and appends a record to `<FTH_HOME>/composed/<ROOT>.jsonl`,
the way the runner records policy verdicts (`prop-state.js:526`):

- the root, contract, side, bar (the briefing's `asOf`), `at`, `expiresAt`
  (the next base-bar close);
- each read with its form, skill, field, the briefing's value, and its check;
- the signature (section 5);
- the plan: the entry reference (the last close), the stop and target prices
  and their ticks, the R:R, the first level in the way and its R, and
  `maxSize`;
- `ok` (every read true and every plan check passed) or the reasons it is
  not.

It returns the same record as text so the model and phase 2 see each check.
The tool is a calculator and a checker, never a second opinion: it doesn't
decide whether to trade.

### 3.4 Stop and target

- **Stop.** The stated invalidation price must equal a briefing level on the
  losing side of the entry, within one tick: a completed candle's low or
  high on a named timeframe (`m3.candles.<tf>.l|h`), a confirmed swing
  (`m3.swings`, `m3.liquidity.swingLows|swingHighs`), or a named key level.
  A buffer beyond it of N ticks is owner decision D3. Stop ticks =
  ceil(|entry reference - stop| / tick), as `trade-plan` rounds today.
- **Target.** A real level on the winning side: a swing target
  (`m3.swingTargets`) or a named key level, floored toward the entry.
- **Checks.** R:R at least the composed document's `risk.min_rr`; the first
  level in the way and its R are recorded and are what a phase-2 room fact
  is checked against (section 3.6).

Scenario 1, tick-checked (MNQ, 0.25 tick, $0.50 a tick): entry reference
21540.25, stop 21512.75 = 27.50 points = 110 ticks = $55.00 per contract;
target 21598.00 = 57.75 points = 231 ticks = 2.1R.

### 3.5 order_plan and sizing

`order_plan {"strategy": "composed", "symbol", "side"}` plans from the
latest `ok` record for the root and side instead of a scan candidate. The
stop and target ticks are the record's. Size is unchanged: outside an
attempt, `position-sizing` and the composed document's `risk.max_risk_usd`;
inside one, the prop verdict (section 3.7). `trade-plan`'s rule stays true:
the numbers come from `order_plan`, never from the model's own arithmetic.

### 3.6 The gate

The order's rationale opens `setup:composed long ...`. The side must follow
the tag (`order-gate.js:49`), so a signature, if written, comes after it.

| Check | Composed entry |
|---|---|
| `setup-tag`, `strategy` | Unchanged. `composed` resolves to `strategies/composed/STRATEGY.md`, a document with a new `signal: composed` that holds the status (`paper`), sessions, contracts, `risk.min_rr` and `risk.max_risk_usd`; no rules |
| `trigger-fired` | Replaced, for `signal: composed` only, by a new hard check `composed-reads`: the latest record for the root is `ok`, for this bar (unexpired), on the order's side; the stop and target bracket ticks equal the record's; the size is at most its `maxSize`; it hasn't been used for an entry |
| `mtf-trend` | Unchanged; the style is `trend` unless owner decision D2 allows a verified reversal |
| `phase2-facts` | Unchanged forms and minimum; `factsOrder` (`order-gate.js:64-72`) gives the composed record, so a room fact is checked against the record's first level in the way instead of `m3.candidates` |
| `max-risk`, `contract-specs`, `max-order-size`, `stop-defined`, `order-consistency`, `plan-required`, `market-hours`, `time-window`, `blackout`, loss and entry limits, every gateway-only check | Unchanged |
| `combine`, `policy` | Unchanged, with `composed` as a component a policy may list (section 3.7) |

It fails closed: a missing, unreadable, expired, used or not-`ok` record,
a briefing that isn't the cycle bar's, or a check that throws, refuses the
entry. Exits and protective orders return before every entry check
(`order-gate.js:247`), so nothing here can hold one.

Strategies work as today: their path through the gate doesn't change.
`composed` starts `status: paper`, so the gate refuses its live entries
(`strategies.js:568`) while replays and paper runs record them; only the
owner promotes it.

### 3.7 Inside a prop attempt

While an attempt runs, only a policy strategy may enter
(`order-gate.js:320-325`), and each entry needs a runner verdict recorded at
a component's scan candidate (`prop-state.js:465-496`). For a composed entry,
`compose_check` asks for the verdict itself: the same `decideSetup`
(`prop/verdict.js:50`) with the record's direction and stop distance in
place of a scan's, so the budget (`combine.js:143`, a share of the cushion
above the floor), the rulebook's multiplier and the one-entry-per-verdict
rule apply unchanged. The policy must list `composed` as a component, which
is the owner's call (D5).

## 4. Records for the learning loop

| Record | Adds |
|---|---|
| The composed record (3.3) | The reads, each check, the plan, the signature; append-only |
| The journal plan | The plan text names the record (`composed <bar> <signature>`); `journal_add` has no data field (`broker/interface.js:90-93`), and the broker interface doesn't change |
| Decision history (`decision-history.js:107`) | `setup: composed`, the signature, and the record's stop and target; a pass with an `ok` record is `skipped`, so its +1R/-1R counterfactual is kept as for strategies |
| Cycle log (`cycle-log.js`) | Each `compose_check` call's record and refusal, beside `factCheck` |
| Labels (`replay/labels.js`) | The reads and signature; the record's target counts as the plan's own exit, not a clone reason |
| Scorecard (`replay/scorecard.js`, `trading/reasons.js:89`) | A composed entry is judged by its record (every read verified, the gate's answer) and its outcome in R, not as "no setup" |
| Counterfactual (`replay/counterfactual.js`) | The record's stop and target distances simulate a pass, as for a skipped candidate |

**The signature** is the reads in step order without prices, e.g.
`bias:1h-bos-up+bias:above-prior-rth-range+location:at-prior-vah+setup:15m-rejected-prior-vah-up+entry:3m-close-top+entry:3m-momentum-up+stop:15m-low+target:60m-swing`.
Same combination, same signature, so outcomes pool across days.

**What the loop builds on it later** (not in this design's PRs): replay
practice writes the records; code scores each decision (signature, context:
regime, bias, session, outcome in R, passes with their counterfactuals) into
an append-only log; an index by signature and context with sample sizes;
an `experience_lookup` tool, like `skill_lookup`, so nothing is added to
the prompt. Nothing in sections 3-4 has to change for it.

## 5. Skill text changes

The trader-process skill is embedded in every mapped role and has a byte
budget of 4800 (`tests/plugin/trader-process.test.js:22`); it is at 4791.
So every change replaces text; the detail goes into a skill read with
`skill_lookup`.

| Skill | Today | Becomes |
|---|---|---|
| `trader-process:19-21` | "No setup without a fired strategy. ... never make a trade on their own." | "No setup without verified reads: a fired strategy, or a combination `compose_check` verifies (composed-entry)." |
| `trader-process:37, 44` (steps 4, 6) and the PLAN block (`:83, 85-86`) | The setup is a fired strategy; the trigger fired | The setup is a fired strategy or the record's setup read; line 4 may say `composed <signature>` |
| `rejection:16-19`, `breakout:16-19` | "never a reason to enter without a fired strategy" | "a setup read for a strategy or a composed entry, never an entry alone" |
| `top-down-entry:30` | "A fired strategy is the entry." | "A fired strategy, or a verified composed entry, is the entry." |
| `absorption:48`, `fib-retracement:65`, `cisd:53` | "No setup without a fired strategy" | Same replacement |
| `risk-manager.md:84-91` (step 0) | Candidate or veto | Candidate, policy verdict, or an `ok` composed record for this bar; else veto |
| `trade-plan` | `order_plan` with a strategy | Unchanged rule; one example with `strategy: "composed"` |
| A new skill, composed-entry (index only) | | The read forms, the stop and target rules, one worked example per scenario |

Each change is synced to every harness by `node scripts/sync-harness.js`.

## 6. Order of facts for scenario 2

1. **4h candle facts:** add 240 to the candle timeframes
   (`candle-facts.js:74`), so a 4h candle's sweep of the prior 4h low is a
   `rejected` relation like any other.
2. **4h swing targets:** add 240 to the target frames (`briefing.js:419`).
3. **5m structure:** `lastBreak` on 5m candles, from the base bars when
   they divide 5m, else a 1m lane's bars (as 5m candle facts are built
   today, `candle-facts.js:380`); never approximated.
4. **FVGs per timeframe:** open FVGs on 5m, 15m and 60m, each with whether
   the last completed candle retested it.
5. **Prior-candle levels per timeframe** are already met as "previous
   <tf> high/low" (`candle-facts.js:430`); nothing to add.
6. **A shared momentum read** per timeframe, once its definition is decided
   (D4).

Each is a briefing fact first (with tests and no look-ahead), then a read
form. A 5m lane is not required if the 1m bars are there.

## 7. PR sequence

Each PR is small, runs `npm run verify`, and gets the adversarial review.

1. **Reads checker.** `scripts/lib/trading/composed-reads.js`: parse and
   check reads against a briefing (scenario 1's forms), with unit tests.
   No tool, no gate change.
2. **`compose_check` and the record.** The harness tool, the record file,
   the stop and target rules, the signature; `strategies/composed`
   (`signal: composed`, `status: paper`) and its schema.
3. **Gate.** `composed-reads` check, `factsOrder` for room facts, gate and
   wiring tests (`tests/lib/order-gate.test.js`,
   `tests/hooks/trading-hooks.test.js`).
4. **order_plan and the prop verdict.** `strategy: "composed"`, and a
   verdict from the record inside an attempt.
5. **Skills and the risk manager.** Section 5's text, the new
   skill, composed-entry, synced.
6. **Records.** Decision history, cycle log, labels, scorecard,
   counterfactual.
7. **Scenario 1 end to end.** An e2e test on real bars: the model's reads,
   the record, the gate allowing it in paper and refusing a false read.
8. **Scenario 2 facts,** in section 6's order, one PR each, then their read
   forms and an e2e test.

## 8. Risks

- **Fishing for true reads.** The model can call `compose_check` until a
  combination passes. Every call is recorded; the loop scores what was
  tried, not just what passed. A per-bar call limit is D6.
- **Reads that are true but meaningless.** Verification proves the facts,
  not the edge. Paper and replay first; the outcome log decides later.
- **Stops at noise.** A stop at the nearest candle low can be tight; the
  `risk.min_rr`, the budget and the zero-blow rules still bound the loss.
- **A small local model writing closed forms.** Malformed reads refuse; the cycle
  log counts them, so the forms can be simplified from evidence.
- **Prompt size.** The new skill is index-only; the embedded text only
  swaps sentences.

## 9. Open decisions for the owner

- **D1.** Approve the design: a `signal: composed` strategy document with
  status `paper` plus a `compose_check` tool, rather than another route.
- **D2.** Trend rule: composed entries are trend-only, or a verified
  reversal (a sweep plus a CHoCH against the trend) may fade it.
- **D3.** Stop buffer beyond the invalidation level: 0, 1 tick, or a share
  of ATR.
- **D4.** Momentum read definition (e.g. a displacement or a top-third
  close with range at least 1 ATR and volume at least the average).
- **D5.** Whether `prop_portfolio` lists `composed` as a component once
  replays support it.
- **D6.** A limit on `compose_check` calls per bar.
- **D7.** Required steps: all six, or bias, setup, stop and target only.
- **D8.** Scenario 2's facts: confirm the order in section 6 and whether a
  5m lane is wanted or 1m bars suffice.
- **D9.** Promotion: what replay evidence moves `composed` from `paper` to
  `active`.
