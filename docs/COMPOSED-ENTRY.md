# Composed entry: design

Status: a design for the owner's OK. Nothing in it is built. Every claim
about today's code names its file and line on `main` at the time of writing.

**The owner's decisions of 2026-10-14** (they supersede the text below where
it differs):

- **The one strategy is `trade_lifecycle`** (`strategies/trade_lifecycle`,
  `setup:trade_lifecycle`): the composed entry of this design, named for
  the whole trade process. The model combines its skills to read, set up,
  enter, size, manage and exit. "Composed" below is that strategy.
- **`prop_portfolio` stays, as the account layer over it**: the account,
  contracts, the rulebook's `policies.prop_portfolio` (sizing, exit,
  multipliers, numbers unchanged), the verdicts, the trail, micro or mini.
  Its one component will be `trade_lifecycle` (section 3.7). Until then it
  lists none and stays `active`: with no component it has no setup, so the
  gate refuses every entry; exits and protective stops go.
- **Every other strategy is deleted**, not phased out and not turned into
  skills or documents (done: the ten rules strategies and
  `prop_flow_1m`, with its rulebook entry; strategies/README.md, "Retired
  strategies"). Named setups like CRT are facts in the briefing only; CRT is
  a rejection concept (the `rejection` skill), not a setup of its own.
- **Sizing is a step the model states**, from the sizing skills, under the
  enforced ceiling: `prop_portfolio`'s verdict (the rulebook's budget and
  multiplier), which the gate holds; the model may only state less.
- **Skills stay as they are.** Section 7's rewrites of existing skills are
  not made; new skills are added only where this design needs one (one
  for the composed entry), and the new one for take-profit targets (in
  flight) owns targets (section 3.4).
- **The code stays** until its own PRs (section 9's table): dead code is
  kept and tested through fixtures meanwhile.

## 1. Thesis

**The model learns, from the market, which skills to combine.** Owner,
2026-10-14: "The whole idea is the model learns what skills to combine based
on what it learns from the market." The composed entry exists for that: at
each bar the model puts its skills together (bias, location, setup, entry,
stop, target) or passes; code checks every read and records the decision
and its outcome in R; and the model consults that record, on demand, the
next time it faces a similar market. Over replay practice, and later live,
it learns which combination works in which context. Section 4, the learning
loop, is the heart of the design; the other sections exist to serve it, and
each is tested against it: does it let the model choose freely, check what
it claims, and learn from what happened?

**The trader process is how the model thinks.** Owner: "The whole purpose
of using a reasoning model is that it will learn to think like a trader and
use the trading process with all the skills." Each bar the model reasons
through bias, location, setup, entry, stop and target, with whichever
skills fit, and says why at each step; it is not a checklist to fill.
The record keeps that short reason beside each verified read, so the
lessons, `experience_lookup` and the scorecard see how it thought, and the
loop improves the thinking, not only which combination it picks.

**Think like a pro trader.** A pro reads context before setups (the
higher-timeframe bias and the day's levels first), waits at levels for
price to come to them, takes only setups where the reads line up and the
room to the target pays for the risk, and passes by default: a pass is a
good decision and is scored as one. Invalidation is defined before entry,
every trade is managed and reviewed, and size comes from risk, never
conviction. The learning loop rewards that discipline (good passes, honest
reasons), never the number of trades.

Three things follow.

- **The model chooses; code verifies.** The trader-process steps are the
  frame. Which skill the model uses at each step, and which read, is its
  choice and is what it learns. The gate checks that each claimed read is
  true and agrees with the order's side; it never prescribes a skill.
- **No search picks the combination.** No sweep, TPE or strategy-combo
  search: "a sweep defeats the purpose of a reasoning model".
- **Risk is code.** The gate fails closed and never holds an exit; sizing is
  a share of the account's cushion above its MLL floor; the zero-blow goal
  stays.

**The only strategy.** Owner, 2026-10-14: "We can delete all the old
strategies like crt, cisd, vwap, OFI to avoid confusion. This is the only
strategy and it learns from the market which skills to combine to trade the
current market", and "it combines all the concepts from the others". The
composed entry is packaged as one strategy document, `strategies/trade_lifecycle`,
so it rides the existing strategy plumbing (the gate's strategy checks,
sizing, the prop verdict, the records); it hardcodes no combination. Every
other strategy document is deleted (section 9), after each concept it
encodes is a skill, a briefing fact and a read the checker verifies
(section 6), so no knowledge is lost. Nothing on the composed path depends
on another strategy having fired. The harness places no entries while this
is built (owner: "we won't trade until this is done and perfected"); exits
and protection keep working throughout.

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
| Stop: below 21512.75 | `invalidation` | a candle low, `m3.swings`, `m3.liquidity.swingLows` | None. Stops come only from a strategy's scan (`harness-tools/order-plan.js:54-69`) |
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

Scenario 2 needs new facts first (section 8).

## 2. What blocks a model-originated entry today

Each row is something section 3 replaces for the composed path, or section 9
deletes with the old strategies.

| Where | What it does |
|---|---|
| `order-gate.js:38, 273-275` | `setup-tag`: the rationale opens with `setup:<name>` |
| `order-gate.js:276-278`, `strategies.js:558-578` | `strategy`: the name is a strategy document that is valid, `active`, trades the contract and is in its sessions |
| `order-gate.js:299-302` | `trigger-fired`: a rules strategy's own trigger fired on the side, on a recent bar (hard) |
| `order-gate.js:320-325` | `combine`: while a prop attempt runs, only a policy strategy may enter, and its entry needs a runner verdict recorded at a scan candidate (`prop-state.js:465-496`) |
| `strategies.js:368-380`, `strategies.js:545` | A policy may list only rules strategies (`componentRefusal` refuses any other component) |
| `strategies.js:568`, `order-gate.js:262`, `replay/config.js:67` | A strategy whose status isn't `active` may not enter; paper mode (`FTH_PAPER=1`) refuses every entry (`paper-mode`) and only journals the plan; a replay run pins `FTH_PAPER=0`. So a `paper` strategy gets no fills, and no outcome in R, in replay today |
| `autotrader.js:711-716`, `skills/runner-lanes/SKILL.md:22-24` | In trigger `signal` mode, and on a 1m lane, the runner starts a cycle only when a mechanical strategy is a candidate or a position or order is open: with nothing fired, the model never sees the bar |
| `agents/risk-manager.md:84-91` | Step 0 vetoes any plan the scan doesn't list as a candidate (a manual strategy aside) |
| `agents/risk-manager.md:111-127`, `harness-tools/order-plan.js:58, 64` | `order_plan` plans only a rules candidate or a policy verdict; the risk manager vetoes on its refusal |
| `skills/trade-plan/SKILL.md:57-60` | The numbers come from `order_plan`, never the model's arithmetic |
| `fact-claims.js:74, 156-198` | Phase-2 FACTS are a closed set (window, entries, news, trend, read, tf, vwap, value, room); a room fact must match the order's setup among `m3.candidates` (`fact-claims.js:261-268`) |
| `trading/reasons.js:89`, `replay/scorecard.js:34, 135` | No setup on the bar means the expected decision is no trade; an entry there scores `bad size` |
| `replay/labels.js:31, 888-909` | A target other than the strategy's own exit is a clone reason |
| `decision-history.js:60, 97-104` | The history names the setup from the order's tag and the scan; a composed entry has no scan setup |
| `trading/skills-loaded.js:44` | The skills required for an entry name `strategy-library`, `strategy-scan` and `strategy-gate-checks` |
| `skills/trader-process/SKILL.md:19, 37, 44` and `rejection:16-19`, `breakout:16-19`, `top-down-entry:30`, `absorption:48`, `fib-retracement:65`, `cisd:53`, `fair-value-gaps:42`; the descriptions of `rejection` and `breakout` (line 3: "Use when a strategy fired") and their line 10 | Doctrine: no setup without a fired strategy |

A `signal: manual` strategy is the nearest thing today (`strategies.js:34`),
and no strategy uses it. It is not the answer: the gate never checks a
manual trigger (`trigger-fired` is for rules strategies only,
`order-gate.js:299`), `order_plan` refuses it (`harness-tools/order-plan.js:64`),
and its room facts can't match a candidate. A composed entry is, in effect,
a manual strategy whose trigger code verifies.

## 3. The composed entry

### 3.1 How the model states it

The head trader (the main session) calls one new harness tool,
`compose_check`, in setup-judgment, with its combination as a list of reads:

```json
{
  "symbol": "MNQ", "side": "long",
  "reads": [
    { "step": "bias",     "skill": "bos-vs-choch",       "read": "1h bos up",
      "why": "60m broke the last swing high: buyers in control" },
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

Each read carries `why`: the model's reason for that step in a sentence
(at most 160 characters), as it thought it. Code never checks a `why`; it
records it (only the first read is shown with one above, for space).

Each `read` is one closed form, parsed the way `fact-claims.js` parses FACTS
items today (no negations, no brackets, ASCII only; `fact-claims.js:90-92`).
Code maps the form to its briefing field; the model never names the field.
`skill` is recorded, not checked against the form, except that it must be a
skill folder that exists: which skill the model reached for is what the
learning loop scores (section 4), so the gate never prescribes it.

The risk manager reads the result through `order_plan` (section 3.5); no
other role holds `compose_check`. Its schema joins the cached head of the
head trader's prompt once (an estimated 1.2-1.8 KB, as `order_plan`'s
1,774 bytes of name, description and schema today), and changes nothing per
cycle.

### 3.2 The read vocabulary

The closed set grows from today's FACTS forms. Each form is one fact field
and one comparison.

| Step | Form | Field | Today |
|---|---|---|---|
| bias | `<tf> up\|down\|range` | `m15.frame.trend`, `h1.h1.trend`, `h1.h4.trend` | Exists (`fact-claims.js:66`) |
| bias | `<tf> bos\|choch up\|down` (60m is written 1h) | `<section>.lastBreak.last` (3m, 15m, 1h) | Field exists; form new |
| bias | `above\|below\|inside prior RTH range` | `m3.location.priorRthRange` | Field exists; form new |
| bias | `trend <side> allowed`, `read <side> <label>` | `m3.trendRule`, `m15.alignment` | Exists |
| location | `at <level name>` | the level within the trigger candle's range, or met by the base timeframe's last completed candle or the next one up (a structured relation, below) and within one ATR(14) of price; a higher timeframe's candle or a distant level is not "at" it | Fields exist; form new |
| location | `vwap above\|below\|at`, `value inside\|above\|below` | `m3.vwap.side`, `m3.location.priorValue` | Exists |
| setup | `<tf> rejected\|broke <level name> up\|down` | a completed candle's relation to the level | The briefing's text keeps only four per candle (`candle-facts.js:330, 444-445`); the checker needs every relation, structured (`rel`, `dir`, level) |
| setup | `<tf> pattern <name>` | `m3.candles.<tf>.pattern(s)` | Field exists; form new |
| setup | `<tf> cisd up\|down`, `[<tf>] in ote` | `m3.cisd` (`briefing.js:415`): a live CISD only (a `void`, `expired` or `weak` one is false); the OTE zone points its CISD's way | Field exists; form new |
| setup | `swept <level name>` | `m3.sweeps` (`structure-events.js:71`) | Field exists; form new |
| setup | `<tf> fvg retest up\|down` | per-timeframe FVGs | Missing beyond the trigger bars |
| entry | `<tf> close top\|middle\|bottom` | `m3.candles.<tf>.closeLocation` | Field exists; form new |
| entry | `<tf> momentum up\|down` | a shared momentum read | Missing (definition: owner decision D4) |
| stop | `stop <source> <price>` | the source's price (section 3.4) | Fields exist; form new |
| target | `target <source> <price>` | the source's price (section 3.4) | Fields exist; form new |

Section 6 adds the forms for every concept the deleted strategies knew.

**The checker reads every relation.** The candle levels the prompt shows are
capped at four per candle, strongest first (`MAX_LEVELS`,
`candle-facts.js:330`; `moreLevels` counts the rest, `:445`). The checker
needs the full, structured list, which today exists only while the facts
are built (`found`, `candle-facts.js:431-437`); the saved briefing keeps the
capped text (`:444`). So the briefing stores the full list as a structured
field the prompt never renders (the prompt keeps the capped text), and the
checker reads that field: a true relation the text left out still verifies,
and a level name is matched exactly, never against the text.

**Side agreement.** Every read with a direction must agree with the order's
side: `up`, `bos up`, `choch up`, `rejected ... up`, `cisd up`, `momentum
up`, `close top`, `above prior RTH range`, `in ote` in a bullish CISD's zone
for a long; their mirrors for a short. A long with `1h bos down` is refused,
even though the read is true. A read with no direction (`at prior VAH`,
`value inside`) agrees with either side. The only exception is the verified
reversal of owner decision D2: a trend or break read against the side is
allowed when the combination also has a true 15m or 1h CHoCH the order's way,
on a timeframe at or below that CHoCH's (a 15m CHoCH never excuses the 1h or
4h trend; a 3m CHoCH excuses nothing). It is the reads' agreement only: the
gate's trend rule is checked on its own.

**Each step its own reads.** The step a read belongs to is fixed by its
form, as the table above lists it (bias: trend, break, prior RTH range, trend
rule, alignment, regime, day type; location: `at`, `vwap`, `value`; setup:
relations, patterns, CISD, OTE, sweeps; entry: close, momentum), and no read
is stated twice, so one read can't fill several steps. Which skill and which
form within a step stay the model's choice.

**When it stands.** A read is true, false or unchecked, as FACTS claims are
(`fact-claims.js:26`). The combination stands only when every read is true
and agrees with the side, the required steps are covered (D7), and the stop
and target reads are present. Any false, unchecked or disagreeing read
refuses it, naming the read.

### 3.3 The composed record

`compose_check` checks the reads against the cycle bar's briefing, with
`briefingFor(home, root, { cycleBar })` (`fact-claims.js:47, 325`): the
runner passes the cycle bar; without it `briefingFor` would return the
briefing current at the wall clock, so the tool refuses rather than guess.
It then works out the plan in code and appends a record to
`<FTH_HOME>/trade-lifecycle/<ROOT>.jsonl` (one file per index family; its
schema is `RECORD_KEYS` in `trading/trade-lifecycle.js`), the way the runner
records policy verdicts (`prop-state.js:526`):

- the root, contract, side, bar (the briefing's `asOf`), `at`, `expiresAt`
  (the next base-bar close), the cycle id and the lane (the briefing's base
  timeframe); the run id comes with the runner (PR 14);
- the context: `m3.regime` (primary and volatility), `m3.window`, the trend
  rule for the side, `m15.alignment` for the side, `m3.today.dayType`
  (section 4.2);
- each read with its form, skill, field, the briefing's value, its check,
  its side agreement and the model's `why` for that step;
- the skill and read signatures (section 3.8);
- the plan: the entry reference (the last close), the stop and target prices
  and their ticks, the R:R, the first level in the way and its R, and
  `maxSize`;
- `exploratory` (section 4.5);
- `ok` (every read true and agreeing, every plan check passed) or the
  reasons it is not.

It returns the same record as text so the model and phase 2 see each check.
The tool is a calculator and a checker, never a second opinion: it doesn't
decide whether to trade.

### 3.4 Stop and target

- **Stop.** The stated invalidation price must equal a briefing level on the
  losing side of the entry, within one tick: a completed candle's low or
  high on a named timeframe (`m3.candles.<tf>.l|h`), a confirmed swing
  (`m3.swings`, `m3.liquidity.swingLows|swingHighs`), or a named key level.
  The stop is placed a buffer beyond it (D3). Stop ticks =
  ceil(|entry reference - stop| / tick), as `trade-plan` rounds today.
- **Minimum stop.** The stop is at least a floor (D13), so a stop at the
  nearest candle low isn't inside one bar's noise. A stop closer than the
  floor is refused, never widened: a wider stop would no longer be the
  level the model named.
- **The fill and the level.** The bracket is in ticks from the fill, and a
  market order fills away from the last close, so the stop could land short
  of the level. The gate reads only local state (no quote), so it can't
  measure that at send time. The entry is therefore a limit order at the
  entry reference, valid until the record expires (D13): it fills at the
  reference or better, so the stop lands at the level or beyond it.
  `composed-reads` requires `type: limit` with `limitPrice` equal to the
  record's reference, or better for the side. The broker interface has no
  time in force (`broker/interface.js:74-76`), so the runner cancels a
  working composed limit at the record's `expiresAt`.
- **Target.** A real level on the winning side: a swing target
  (`m3.swingTargets`, `target <tf> swing [high|low] <price>`), the prior
  completed 1h or 4h candle's high, mid or low (`m3.rangeTargets`,
  `target prior 1h|4h high|mid|low <price>`; an off-tick mid is the price on
  the tick toward the entry), a fair value gap's edge (`m3.fvgs`, `target
  <tf> fvg high|low <price>`: an open gap's edges, a partly filled one's
  unfilled part), or a named key level, floored toward the entry. A prior
  candle's side the candle forming has already taken is spent: no target.
  The new skill for take-profit targets (in flight) teaches how the model
  picks the swing and prior-candle targets; no skill teaches a gap's edge as
  a target yet.
- **Checks.** R:R at least the composed document's `risk.min_rr`; the first
  level in the way and its R are recorded and are what a phase-2 room fact
  is checked against (section 3.6).

Scenario 1, tick-checked (MNQ, 0.25 tick, $0.50 a tick): entry reference
21540.25, stop 21512.75 = 27.50 points = 110 ticks = $55.00 per contract;
target 21598.00 = 57.75 points = 231 ticks = 2.1R. With D3's 1-tick
buffer the stop is 21512.50: 111 ticks, $55.50 per contract, 2.08R.

### 3.5 order_plan and sizing

`order_plan {"strategy": "trade_lifecycle", "symbol", "side"}` plans from the
latest `ok` record for the root and side instead of a scan candidate. The
stop and target ticks are the record's. Size: outside an attempt,
`position-sizing` and the composed document's `risk.max_risk_usd`; inside
one, the prop verdict (section 3.7). `trade-plan`'s rule stays true: the
numbers come from `order_plan`, never from the model's own arithmetic.

`risk.max_risk_usd` is required for `signal: composed`: the gate's risk cap
is skipped when a strategy doesn't state it (`order-limits.js:79`), so the
schema refuses a composed document without it.

### 3.6 The gate

The order's rationale opens `setup:trade_lifecycle long ...`. The side must follow
the tag (`order-gate.js:49`), so a signature, if written, comes after it.

| Check | Composed entry |
|---|---|
| `setup-tag`, `strategy` | Unchanged. `trade_lifecycle` resolves to `strategies/trade_lifecycle/STRATEGY.md`, a document with a new `signal: composed` that holds the status (`active`, the owner's decision: until this check is built the strategy check refuses its entries), sessions, contracts, `risk.min_rr` and `risk.max_risk_usd` (required); no rules, no combination |
| `trigger-fired` | Replaced, for `setup:composed`, by a new hard check `composed-reads`, keyed on the tag and run outside the skippable checks, so it runs even when the composed document is missing or invalid (not behind `named.valid !== false`, `order-gate.js:280-284`). It loads the latest record for the root and **re-runs the pure reads checker** on the record's reads against `briefingFor(home, root, { cycleBar })`: it never trusts the record's `ok` flag. The reads must be true and side-agreeing, the record for this bar (unexpired) and the order's side; the plan is recomputed and the bracket ticks must equal it; the size at most `maxSize`; the order `type: limit` at the record's reference or better (section 3.4); the record not yet used for an entry; an exploratory record only in replay practice (D18); and, once required (D15), an `experience_lookup` on the record recorded this cycle |
| `mtf-trend` | Unchanged; the style is `trend` unless D2's verified reversal applies |
| `phase2-facts` | Unchanged forms and minimum; `factsOrder` (`order-gate.js:64-72`) gives the composed record, so a room fact is checked against the record's first level in the way instead of `m3.candidates` |
| `review-before-next-entry` | Unchanged (`order-gate.js:373`): a composed entry on a root whose earlier entry has no review is refused; the review tags `setup:trade_lifecycle` |
| `max-risk`, `contract-specs`, `max-order-size`, `stop-defined`, `order-consistency`, `plan-required`, `market-hours`, `time-window`, `blackout`, loss and entry limits, every gateway-only check | Unchanged |
| `paper-mode` and the `strategy` status | A `paper` composed entry may enter only when the broker and the run config are both replay, as the account lock exempts a replay run (`account-lock.js:199-203`, `lockExemption`); anywhere else a `paper` status refuses as today (`strategies.js:568`) (D10) |
| `combine`, `policy` | Section 3.7 |

It fails closed: a missing, unreadable, expired, used or not-`ok` record, a
read that is false or disagrees on re-check, a briefing that isn't the
cycle bar's, or a check that throws, refuses the entry. Exits and protective
orders return before every entry check (`order-gate.js:247`), so nothing
here can hold one.

**Paper in replay.** Without the D10 exemption a `paper` composed entry gets
no fill in replay: replay runs with `FTH_PAPER=0` (`replay/config.js:67`), so
the status check refuses it, and paper mode would refuse it too
(`order-gate.js:262`), whose refusal says to journal the plan instead.
The learning loop needs real replay fills, so the exemption is what lets
practice score outcomes while `trade_lifecycle` is still `paper`; only the owner
promotes it to `active`.

**The runner.** On the composed lane the runner cycles every bar (trigger
`bar`, D11), since nothing fires for it: in trigger `signal` it would never
start a cycle (`autotrader.js:711-716`).

### 3.7 Inside a prop attempt

`prop_portfolio` stays the account's policy (the owner, 2026-10-14) and
`trade_lifecycle` becomes its one component: `prop_portfolio` lists
`strategies: [trade_lifecycle]`, and the rulebook's `policies.prop_portfolio`
(its `sizing`, `exit` and `multipliers`) sizes and trails every
`trade_lifecycle` trade, as it did the rules strategies'. Its numbers are
unchanged: `accounts/<account>/RULEBOOK.md` holds them, the one place (R1).
Today `prop_portfolio` lists no strategies (`strategies: []`, allowed
since 2026-10-14: no component, no setup, no verdict, so every entry is
refused). The model states its size in the record from the sizing skills;
the verdict is the ceiling and the gate holds the order to it. Code changes
this needs:

- `strategies.js` (the policy component check after the load) and
  `componentRefusal`: a policy lists only rules components; it must also
  accept a `signal: composed` component (`trade_lifecycle`), on its
  timeframe and instruments.
- The verdict: `compose_check` asks for it, the same `decideSetup`
  (`prop/verdict.js:50`) with the record's direction and stop distance in
  place of a scan's, so the budget (`combine.js:143`, a share of the cushion
  above the floor), the rulebook's multiplier and the one-entry-per-verdict
  rule apply unchanged. It is recorded at the record's bar.
  `verdictBarProblem` (`prop-state.js:403-404`) ties it to the cycle bar
  through `lastRecordedBar`, which reads the runner's per-bar signal record
  (`signal-state.js:202-209`): that per-bar record must survive the
  deletion of the strategies (section 9), and
  `openEntryVerdicts` (`prop-state.js:515`, the latest verdict per policy
  and index family, unexpired and unused) sees it as the open setup, as it
  sees a policy's today; with one policy, lane priority has nothing to
  settle.
- A model-callable tool now creates prop verdicts, so D6's per-bar call
  limit is a hard rule inside an attempt: past it, `compose_check` records
  the call and returns no verdict.

### 3.8 The signature

The **read signature** is the reads in step order, sorted within a step by
skill then form, without prices, e.g.
`bias:1h-bos-up+bias:above-prior-rth-range+location:at-prior-vah+setup:15m-rejected-prior-vah-up+entry:3m-close-top+entry:3m-momentum-up+stop:15m-low+target:60m-swing-1.5-2.5r`
(scenario 1's target is 2.1R).
The **skill signature** is the same without the reads: which skill at each
step. Same combination, same signature, so outcomes pool across days
(section 4.2).

## 4. How the model learns what to pick

This is the heart of the design. Section 3's tool and gate exist so that
every decision is a set of checked reads with a real outcome; this section
turns those decisions into a record the model consults, so that over many
practice days it learns **which skills to combine in which market
context**.

### 4.1 The loop

1. **Practice.** The runner replays teaching months (D23; section 4.7). At each bar
   the model composes a candidate from its skills and either enters it or
   passes. Nothing about the choice is fixed: the steps are the frame, the
   skill and the read at each step are the model's.
2. **Record.** Code writes every decision, composed or passed, to an
   append-only experience log with its signature, its context and, once the
   session is over, its outcome in R (section 4.2).
3. **Index.** Between sessions, code builds an index of the log: per
   signature and context, how many, how often it won, its mean R with a
   confidence interval (section 4.3). The model never writes the log or the
   index.
4. **Consult.** In the next session, when it has a candidate, the model
   calls `experience_lookup` and gets its own record for that combination in
   this context (section 4.4). Nothing is embedded in the prompt.
5. **Review.** After a session the reviewer writes lessons; code attaches the
   real statistics to each (section 4.6). The model proposes, code measures,
   and the model never judges its own lessons (`docs/LEARNED-RULEBOOK.md`
   section 7a: "The proposer never judges").
6. **Judge.** Whether it learned is measured on held-out months by a paired
   replay, with and without the record (section 4.8).

There is no sweep, TPE or combination search anywhere in the loop: the only
thing that chooses a combination is the model, and the only thing the record
does is tell it what happened when it chose that way before.

### 4.2 The experience log

**One record per decision.** A decision is a cycle bar on which the model
had an `ok` composed record (it called `compose_check` and every read was
true), whether it entered or passed. A bar with no `ok` record is logged as
a plain pass with no signature (it counts how often the model found
nothing). Each record holds:

- the run id, lane, root, contract, bar, side, and the decision (`entered`,
  `passed`, `refused` with the gate's check);
- the composed record's reads, plan and `exploratory` flag (section 4.5);
- the two signatures below;
- the context (below);
- the outcome, written after the session's end of day by code: for an
  entry, the real R from its fills; for a pass, the counterfactual R of the
  record's own stop and target on the bars after the decision;
- each step's read and the model's `why` for it, so a lesson or a lookup
  shows how it thought;
- the decision's grade: an entry by its R; a pass by its counterfactual
  (a pass whose counterfactual lost is a **good pass** and is scored as a
  good decision); and the scorecard's reason grade (right reason, wrong
  reason: a `why` the briefing contradicts or a reason that doesn't match
  its read);
- the split role of the bar's date (`prop/splits.js:190`, `roleOf`): train,
  select, oos or recent.

**Two signatures.** Each answers a different question.

| Signature | Built from | Answers | Example (scenario 1) |
|---|---|---|---|
| Skill signature | step -> skill, steps in the fixed order, skills sorted within a step | Which skills, combined, work in which context | `bias:bos-vs-choch,daily-bias+location:vwap-volume-profile+setup:rejection+entry:candle-reading,momentum-and-volume+stop:invalidation+target:top-down-entry` |
| Read signature | step -> skill -> read kind, values bucketed | Which specific reads, combined, work | section 3.8's signature |

Within a step, reads sort by skill then form, so the same combination always
has the same signature whatever order the model wrote it in. Values are
bucketed so that similar setups group: prices are dropped (a stop is its
source, `15m-low`, not 21512.75); timeframes stay; a target's R is bucketed
(under 1.5R, 1.5-2.5R, over 2.5R); a level name stays (`prior-vah`).

**Context keys.** Code reads them from the cycle bar's briefing; the model
never states them.

| Key | Field | Buckets |
|---|---|---|
| Regime | `m3.regime.primary` (`briefing.js:365`) | as the briefing names it |
| Volatility | `m3.regime.volatility` (`briefing.js:365`) | as the briefing names it |
| Session | `m3.window` (`briefing.js:360`) | the session-timing windows |
| Trend side | `m3.trendRule` for the order's side | with, against |
| Timeframe alignment | `m15.alignment` for the side (`briefing.js:426`) | as the briefing names it |
| Day type | `m3.today.dayType` (`briefing.js:398`) | as the briefing names it |

**What feeds it.** The log is a new file built from records that already
exist or that section 3 adds; it re-derives nothing the harness already
computes.

| Source | Gives the log |
|---|---|
| The composed record (`<FTH_HOME>/trade-lifecycle/<ROOT>.jsonl`, section 3.3) | The reads, plan, signature, bar and context fields |
| Cycle log (`cycle-log.js`: `<FTH_HOME>/logs/cycles-<day>.jsonl`) | The cycle's result, its `compose_check` and `experience_lookup` calls, the gate's refusals |
| Decision history (`decision-history.js`) | The action words (entered, skipped, no-trade) and its fill matching for an entered trade's real R (`closedTrade`, `decision-history.js:326`). The history itself is not the log: the runner keeps only the last ten (`runner.js:1410`) |
| Counterfactual (`replay/counterfactual.js:70`, `simulate`) | A pass's R from the record's stop and target distances, with the backtester's slippage |
| Scorecard (`replay/scorecard.js`) | Each decision's adherence verdict (reads verified, the gate's answer, the stated reasons checked) |
| The run directory (`replay/driver.js:68`, `paths.runDir`) | The run id and the replayed bars the outcome is read from |

**Where it lives.** `<run home>/experience/decisions.jsonl`, one file per
run, written at the run's end of day by a code step (a CLI, under 200
lines, with the logic in `scripts/lib/`). Never in the repo, and never read
in the session that wrote it.

### 4.3 The index

**Built by code, from the log.** A CLI builds an index file from a list of
runs: `<FTH_HOME>/experience/index-<hash>.json`, with a manifest naming every
run it read and each run's split role. For each skill signature and for each
read signature, overall and per context key (one key at a time, and the
full context):

- `n`, the decisions; entries and passes counted apart;
- the win rate with a 90% Wilson interval (`prop/stats.js:74`);
- the mean R with a 90% interval from resampling whole trading days, so
  one day's cluster counts once (`prop/stats.js:50`'s `blockBootstrap`
  blocks by a fixed number of outcomes, not by day, so the index needs a
  by-day variant);
- the first and last date seen, and the split by regime and by year;
- per step, the mean R grouped by the skill chosen at that step with the
  other steps' skills held, so "does the location step add anything" is
  answerable from the record (owner decision D7).

**Minimum sample.** A cell with fewer than `MIN_N` decisions, or fewer than
`MIN_DAYS` distinct trading days (D16), shows `n too small (n=7, 3 days)`
and no rate or mean; its count still shows.

**Many cells, one test.** The index has many cells, and some will look good
by chance. Its intervals describe; they don't prove. The guard is the
paired replay (section 4.8), which tests the agent as a whole once, on
months it never practised on.

**No leakage.** An index is built only from records whose bar dates are
teaching months (D23; Train, 2021-01-01 to 2023-07-01, `splits.js:51`, by
default). Records from Select,
Out-of-sample and Recent replays are kept in their run's log but never
indexed: those months judge, they don't teach (`docs/LEARNED-RULEBOOK.md`
section 4; `prop/looks.js`). A Recent replay is a reasoning-fix look whose
scorecard hides every outcome (`replay/scorecard.js:412, 460`), so it has no
outcome to index anyway. A live or paper-live session's records are indexed
only by an owner-approved rebuild (section 4.7).

**Frozen during a session.** The runner pins one index file at start; every
lookup in the session reads it, and the cycle log records its hash. It is
rebuilt only between sessions, by the CLI, never by the runner.

### 4.4 `experience_lookup`

A read-only harness tool, modelled on `skill_lookup`
(`harness-tools/skills.js`, registered in `harness-tools/registry.js:200-210`):

```json
{ "symbol": "MNQ",
  "alternative": [ { "step": "setup", "skill": "breakout-vs-fakeout" } ] }
```

- **Input.** The symbol: the tool reads the latest `ok` composed record for
  the root on the cycle bar, so the candidate and its context are the ones
  code checked, never restated by the model. `alternative` (optional, at most
  two) swaps one step's skill to ask how a nearby combination did. `role`
  (optional, as in `skill_lookup`) records who asked.
- **Output.** Plain text, capped at 4 KB (far under the protocol's 256 KB
  cap, `harness-tools/protocol.js:40`): the record's skill and read
  signatures and context; the closest matching cells with `n`, win rate and
  mean R with their intervals, last seen and the regime split, the exact
  cell first, then the cell with one context key dropped, then the skill
  signature alone; up to three similar past decisions (same skill signature,
  closest context) with their reads and `why` per step, decision, outcome in
  R and any lesson
  (section 4.6) with the statistics code attached to it; and the index's
  hash and its months. With no index or no match it says so. It never says
  what to do.
- **Who calls it.** The head trader (the main session), in setup-judgment,
  and only after a `compose_check` returned `ok`: with no candidate there is
  nothing to look up. The risk manager may call it in phase 2 to see the
  same record; it is not required of it.
- **Budget.** At most two calls per cycle bar (D22); a third is refused.
- **Prompt stays stable.** The tool's schema joins the cached head of the
  roles that hold it (about 0.8-1 KB, as `skill_lookup`'s 737 bytes); its
  output is a tool result, not prompt text, so no statistic is embedded and
  the prompt prefix doesn't change from cycle to cycle.
- **One channel, not two.** Today's journal instincts are embedded in the
  cycle prompt (`runner.js:126`, `trading/instincts.js`): per-setup and
  regime expectancy, repeated mistakes and lessons, read from the whole
  journal with no split filter. That is a second learning channel outside
  this loop's guards. For composed runs it is off (practice, judging and
  live alike); its useful parts (mistakes, lessons) reach the model only
  through `experience_lookup`, filtered like everything else.
- **Recorded.** Each call appends `{ at, role, record, index }` next to the
  cycle's transcript, as `skill_lookup` records its lookups
  (`trading/skill-lookups.js:48`). The gate can then require a lookup on the
  record before a composed entry (D15): recorded from the first PR,
  required once the pinned index holds data for the root.

### 4.5 Practice and exploration

**Practice runs.** A run is practice when the broker and the run config are
both replay (D10) **and** every day of the run falls in teaching months
(D23), by the split role of each date (`prop/splits.js:190`, `roleOf`), as
the run's manifest records it. The composed document trades in `paper`
under the replay exemption, the runner cycling every bar on the composed
lane (D11). At each bar the model composes or passes; the gate checks every
read; fills are the replay broker's.

**Exploration.** "No record" is judged on a coarse cell: the skill signature
with only the trend side (with or against) as context. A candidate whose
coarse cell has fewer than `MIN_N` decisions is exploratory:
`compose_check` marks the record `exploratory: true`, and the size is the
minimum (one micro) whatever the budget allows. A cell is not exploratory
just because its six-key context is thin, which would make nearly every
candidate exploratory. Exploration happens only in practice runs: in any
other run an exploratory record is not an entry (the gate refuses it,
D18). So the record grows where it is thin without risking more than a
micro on an untested combination.

**No sizing confound.** Judging runs (section 4.8) are not practice runs, so
no entry in any arm is exploratory: every arm sizes from the same budget,
and the arms differ only in what `experience_lookup` returns.

**How picking uses the record.** Taught in the new skill, composed-entry (index
only), not enforced by the gate (D19):

- prefer a combination whose cell's mean-R interval lies above zero in this
  context;
- pass on one whose interval lies below zero, and say so in the reasons;
- with `n too small`: in practice, explore at the minimum; elsewhere, pass
  unless the skill signature alone (any context) has a positive interval;
- never treat a win rate without its `n` as evidence; a lesson counts only
  with the statistics code attached to it.

Whether the model followed its own record is measured, not enforced: the
scorecard compares each decision with the cell it looked up.

### 4.6 Lessons

After a practice session the trade-reviewer writes lessons as today
(`agents/trade-reviewer.md`), each naming a skill or read signature
(`signature:<sig>` tag) and a context, and say what the thinking got
right or wrong at which step (the `why` beside each read is there to read). Code, not the reviewer, then attaches
to the lesson the cell's statistics at that moment (`n`, win rate, mean R
and intervals, the index hash). The lookup shows a lesson only beside those
statistics, and marks it `contradicted` when the cell's interval now lies on
the other side of zero from what the lesson claims. A lesson never changes a
statistic, and no LLM decides whether a lesson is right. A lesson is
shown only when every trade it cites is from teaching months (by split
role); a lesson written on a judging or live session is kept but never
shown until an owner-approved rebuild (section 4.7).

### 4.7 Discipline: splits, looks and the champion

- **Teaching months.** Practice and indexing use teaching months only
  (D23; Train by default). Judging uses other months (section 4.8), each
  look logged in the ledger (`prop/looks.js`; Out-of-sample under its look
  budget). Recent takes only reasoning-fix looks, whose scorecard hides P&L
  (`replay/scorecard.js:412`).
- **The model's memory of the market.** Train (2021-2023), Select and
  Out-of-sample (2023-2025) are all before the model's training cutoff.
  The LLM's own replays are meant for months after it (`LLM_FROM`,
  `prop/splits.js:62-63`; `docs/LEARNED-RULEBOOK.md` section 4, the "LLM"
  row: "it cannot remember them"), and the briefing shows dates and prices,
  so on older months the model may recall what happened. The statistics
  stay true (code computes every outcome from the bars), but the model's
  choices there may reflect recall, and a judgment on those months would
  overstate it. D23 decides; its proposed default judges only on months
  after the cutoff.
- **Live never edits the running agent.** A live or paper-live session reads
  its pinned index; its own decisions are logged but enter an index only at
  a rebuild between sessions, and that rebuild is a change to the champion.
- **The champion.** The agent that trades (its skills, the composed document
  and its pinned index) changes only with the owner's approval, after the
  paired replay (section 4.8) and the frozen promotion gate. A practice
  index rebuilt between practice sessions is a challenger, never the
  champion.
- **Paper and replay first.** No live entry until the owner promotes
  `trade_lifecycle` from `paper` (D9).

### 4.8 How we know it learned

A **paired replay** on held-out months after the model's cutoff (D23: the
held-out quarter of each walk-forward half-year from 2026-H2, and the
reserve once it is an out-of-sample window; Select and Out-of-sample only
as a pre-check marked as possibly recalled): the same bars, the same
skills and the same composed document, run once per arm.

| Arm | `experience_lookup` |
|---|---|
| With experience | reads the index built from practice in teaching months |
| Without experience | returns "no record" every time |
| Shuffled (recommended) | reads the same index with its statistics permuted across cells |

The shuffled arm separates "the record taught it which combination works"
from "being shown any numbers makes it cautious".

Measured per arm, from the scorecard and the experience log:

- adherence: reads verified, gate refusals, false stated reasons, lookups
  made when required;
- mean R per entry and per decision (passes counted at their
  counterfactual), each with a block-bootstrap interval, and the paired
  difference by day;
- how often it entered a cell with a positive interval and passed one with a
  negative interval; good passes; right-reason against wrong-reason
  decisions. Trade count is reported, never rewarded;
- blows, and the combine attempts through the frozen promotion gate
  (`prop/promotion.js:12`: zero blows in every out-of-sample month, at least
  40% passes over at least 20 independent attempts and two months).

It learned when the with-experience arm beats both other arms on mean R
with the paired interval above zero, with adherence no worse, zero blows,
and the promotion gate passed; then the owner decides.

**Guards against fooling ourselves.**

- *Outcome noise:* intervals, not point values; `MIN_N`; day-block
  bootstrap so a day's cluster counts once.
- *Self-confirmation:* the model's choices decide what gets entered, so
  passes are logged with their counterfactual R: a combination the model
  avoids still accumulates outcomes, and a bad record can recover.
- *Regime shift:* the regime split and last-seen date in every cell; a cell
  whose last year has the opposite sign of its whole is flagged `shifted`.
- *Old records:* no hidden decay weight (D21): the per-year split and
  last-seen show age openly.
- *Leakage:* indexing from teaching months only (section 4.3); every
  held-out look logged; judging after the model's cutoff (D23).
- *Many comparisons:* the paired replay tests the whole agent once
  (section 4.3).
- *Fishing:* `compose_check` is limited per bar (D6) and every call is
  logged, so the record covers what was tried, not only what passed.

## 5. Changes to today's records

| Record | Change |
|---|---|
| The composed record (3.3) | New: the reads, each check, the plan, the signatures, the context; append-only |
| The journal plan | The plan text names the record (`composed <bar> <signature>`); `journal_add` has no data field (`broker/interface.js:90-93`), and the broker interface doesn't change |
| Decision history (`decision-history.js:107`) | `setup: trade_lifecycle`, the signature, and the record's stop and target; a pass with an `ok` record is `skipped`, so its +1R/-1R counterfactual is kept |
| Cycle log (`cycle-log.js`) | Each `compose_check` and `experience_lookup` call, its record and refusal, and the pinned index's hash, beside `factCheck` |
| Labels (`replay/labels.js`) | The reads and signatures; the record's target counts as the plan's own exit, and a limit entry as the plan's own order type: neither is a clone reason (limit entries are one today, `replay/labels.js:30`) |
| Scorecard (`replay/scorecard.js`, `trading/reasons.js:89`) | The expected decision comes from the reads: a bar with an `ok` record is not "no setup"; a composed entry is judged by its record (every read verified and side-agreeing, the gate's answer), each step's `why` (right or wrong reason) and its outcome in R; a pass whose counterfactual lost is a good pass |
| Counterfactual (`replay/counterfactual.js:70`) | A pass is simulated as the entry would have traded: the same limit at the record's reference until `expiresAt` (today a counterfactual fills at market at the next bar's open, `replay/counterfactual.js:15-18`), the record's stop and target, and the rulebook's trail (section 6), so entries and passes are scored alike |
| Experience log (section 4.2) | New, built from the rows above at each run's end of day |

## 6. Concept inventory: what the old strategies knew

Owner: composed "combines all the concepts from the others". Before any
strategy is deleted, every concept it encodes must be (a) taught by a skill,
(b) readable from a briefing fact and (c) verifiable by a read form. Status
is for the briefing fact today; no setup concept has a verifier today (the
FACTS kinds check window, entries, news, trend, read, vwap side, value
location and room only, `fact-claims.js:64-69, 171-176`), so column (c) is
the read form section 3.2's checker gains.

| Strategy | Concept | (a) Skill | (b) Briefing fact today | (c) Read form | Status |
|---|---|---|---|---|---|
| `cisd_ote` | CISD: a displacement through the run's open | `cisd` | `m3.cisd.<tf>` dir, level, displacement (`briefing.js:189-200, 415`; 3m, 5m, 15m, 60m) | `<tf> cisd up\|down` | present |
| `cisd_ote` | Sweep before the CISD | `cisd` | `m3.cisd.<tf>.sweep`, `m3.sweeps` (`briefing.js:384`) | `swept <level>` | present |
| `cisd_ote` | OTE zone, price in it, a bounce closing back the trade's way | `fib-retracement` | `m3.cisd.<tf>.ote`, `priceInOte` (`briefing.js:199`); no bounce flag | `in ote`, `<tf> ote bounce up\|down` | partial |
| `cisd_ote` | Momentum: a large bar closing at its extreme on volume (version 5, on the unmerged branch `feat/cisd-ote-momentum` at `a270c9db`; `main` has version 4) | `momentum-and-volume` | `m3.bar.rangeAtr` (`briefing.js:358`); no bar close third or 1-bar volume against the 20-bar average | `<tf> momentum up\|down` (D4) | partial |
| `cisd_ote` | The 15m trend agrees (ADX, EMA20 beyond EMA50): a separate bias read, not part of momentum | `trend-momentum-indicators` | 15m ADX and EMAs (`briefing.js:167, 429`) | `<tf> adx above <n>`, `<tf> ema20 above\|below ema50` | present (fact); form new |
| `crt_1h`, `crt_4h` | The prior 1h or 4h candle's range swept and closed back inside | `candle-reading`, `rejection`, `breakout` | `m3.candles.<tf>.levels["CRT 1h\|4h range high\|low"]` (`candle-facts.js:425-430`); the detector `crt.js` feeds only the rules (`rules.js:142`) | `<tf> rejected CRT <tf> range low\|high` | partial |
| `crt_1h`, `crt_4h` | A 3m structure shift after the sweep | `bos-vs-choch` | `m3.lastBreak` (`briefing.js:383`), not tied to the sweep | `crt <tf> shift up\|down` | partial |
| `crt_1h`, `crt_4h` | The range's far side as the target | `top-down-entry` | none | `target crt <tf> far side <price>` | missing |
| `orb` | Opening range, a close beyond it | `breakout`, `breakout-vs-fakeout`, `session-timing` | `m3.today.openingRange` (`briefing.js:398`); the 3m candle's "broke" relation | `3m broke opening range high\|low up\|down` | partial (no break-this-bar flag) |
| `orb`, `vwap_reclaim` | ADX floor, EMA side | `trend-momentum-indicators` | `m3.trend.adx`, `ema50` (`briefing.js:366`) | `<tf> adx above <n>`, `<tf> ema50 above\|below` | present (fact); form new |
| `vwap_reclaim` | A close back through RTH VWAP; not chasing far from it | `vwap-volume-profile`, `levels-and-reactions` | `m3.vwap` rth, side, crosses (`briefing.js:369-371`); no reclaim-this-bar flag | `3m reclaimed vwap up\|down` | partial |
| `value_area` (all three) | Prior POC, VAH, VAL | `vwap-volume-profile` | `day.priorProfile` (`briefing.js:449`) | `at prior VAH\|VAL\|POC` | present |
| `value_area` | Rejection or break of the POC | `rejection`, `levels-and-reactions` | candle relations to "prior POC" | `<tf> rejected\|broke prior POC up\|down` | present (fact); form new |
| `value_area_breakout` | Acceptance: two closes outside value | `breakout`, `vwap-volume-profile` | `m3.location.priorValue` (`briefing.js:403-404`); no close count | `accepted above\|below value` | partial |
| `value_area_reentry` | The 80% rule: open outside value, two closes back inside | `vwap-volume-profile` | `m3.today.openVs` (`briefing.js:398`), `priorValue`; no close count | `reentered value up\|down` | partial |
| `value_area`, `ofi` | Order-flow imbalance over 1, 3 and 5 bars | none | none: the bars carry the broker's flow fields (`indicators.js:26-29`), the briefing's bar keeps only OHLCV (`briefing.js:358`) | `<tf> flow up\|down` | missing |
| `ofi_absorption` | Absorption: heavy flow without progress, then a turn | `absorption` (bar volume only) | `m3.participation` (`briefing.js:372`); no flow | `<tf> absorbed up\|down` | partial |
| `ofi`, `ofi_absorption` | Volume surge against a longer average | `momentum-and-volume` | `m3.participation.relVolLast3VsPrior20` (`market-snapshot.js:163`), other windows | `<tf> volume above average` | partial |
| `orb`, `vwap_reclaim`, `value_area_breakout` | Trade only in some regimes (`regimes: [trend, transition]` or `[trend]`; `regime_gate: true`: the gate refused other regimes) | `trend-vs-range` | `m3.regime.primary` (`briefing.js:365`) | `regime trend\|transition\|range` | present (fact); form new. The gate no longer enforces a regime: which regime suits which combination is what the record learns |
| `crt_1h`, `crt_4h` | Context filters (`strategies/crt_1h/STRATEGY.md:66-125`): the draw on liquidity, premium or discount half of the range, an outside candle voids the hour, skip on a trend day | `daily-bias`, `levels-and-reactions`, `candle-reading`, `trend-vs-range` | `m3.liquidity` and swing targets; today's high and low (`briefing.js:398`, no half); `pattern: outside` on 3m-60m (`candle-facts.js:41`), not 4h; `m3.today.dayType` | `in premium\|discount`, `<tf> pattern outside`, `day type <name>` | partial |
| All (policies' rulebook `exit`) | The trail: hold the setup's stop until a profit in R, then trail behind the best price (the values are the account's RULEBOOK.md `exit`) | `manage-position` | the rulebook's `exit` per policy | none: the exit stays code; the runner's exit plan (`runner.js:405-407`, `exitPlan`) and the counterfactual need it for `trade_lifecycle` | partial |
| `prop_portfolio`, `prop_flow_1m` | Sizing and the priority order of their components | `position-sizing` | the account's rulebook | none: sizing stays code (section 3.7) | n/a |

**Parameters worth keeping as skill guidance:** momentum is a bar read: a
range at least 1 ATR(14), a close in the far third, volume at least the
20-bar average (the version-5 rule's bar part; section 7 rewrites the
skill's momentum read to match); the higher-timeframe
trend (ADX(14) at least 20, EMA20 beyond EMA50) is a separate bias read,
so pairing them is the model's choice, not a definition; a strong CISD candle (body at least 0.6 of its
range, close in its extreme third, range at least 1 ATR); a CRT sweep is
shallow (at most half the range beyond it), and the far side should be at
least 2R away; acceptance is two closes; don't chase VWAP past 1.5 ATR;
breakouts want an ADX floor; flow must agree across windows, and flow
without price progress is absorption. **Tuned quirks, not kept:** the
minute-of-day windows (09:48, 10:00-15:00, 573/600/900), CRT key times,
`cisdMaxWait`, `cisdExpiry`, `cisdVoidTol`, ATR buffers of 0.1-0.5, the
range-ATR floors of 3 and 6 for CRT, and the flow thresholds of 0.25 and
0.3 (the flow strategies were never backtested). Which concepts work, in
which context, is what the learning loop finds; the skills state each
concept, not a tuned number.

**The gaps,** each a PR in phase A (section 10) before anything is deleted:

1. CRT as a fact: the sweep, the shift after it and the far side, from
   `crt.js` moved into the briefing (it feeds only the rules today).
2. "This bar" flags: the VWAP reclaim, the opening-range break, two-close
   acceptance outside value, the 80% re-entry, the OTE bounce.
3. The momentum read (D4) and the 1-bar volume ratio against the 20-bar
   average; the bar's close third.
4. Order flow: the flow fields per bar in the briefing (a fact, read-only),
   a new skill teaching order-flow imbalance, and absorption with flow.
5. Section 8's scenario-2 facts.
6. CRT's context: the premium or discount half of the range, the outside
   candle on 4h, the trend day as a read; the regime as a read.
7. The exit: the trail stated in `manage-position` as guidance now; the
   rulebook's trail for `trade_lifecycle`, in the runner's exit plan and the
   counterfactual, is built with composed (PR 14).
8. The read forms for all of the above, in the reads checker.

## 7. Skill text changes

*Superseded for existing skills by the owner's decision of 2026-10-14
("all our current skills are good"): they stay as they are. The table below
is kept as the record of what was proposed; only new skills (one for the
composed entry, one for take-profit targets) are added.*

The doctrine "no setup without a fired strategy" becomes **"no entry
without verified reads"**. The trader-process skill is embedded in every
mapped role and has a byte budget of 4800
(`tests/plugin/trader-process.test.js:22`), at 4791 today, and its PLAN
block a budget of 760 (`:23`); every change replaces text, and the detail
goes into skills read with `skill_lookup`.

| Skill | Today | Becomes |
|---|---|---|
| `trader-process:19-21` | "No setup without a fired strategy. ... never make a trade on their own." | "No entry without verified reads: a combination `compose_check` verifies." |
| `trader-process:37, 44` (steps 4, 6) and the PLAN block (`:83, 85-86`) | The setup is a fired strategy; the trigger fired | The setup is the record's setup read; line 4 says `composed <signature>` |
| `rejection`, `breakout`: description (line 3, "Use when a strategy fired") and lines 10, 16-19 | "never a reason to enter without a fired strategy" | "a setup read in a composed entry, never an entry alone" |
| `top-down-entry:30` | "A fired strategy is the entry." | "A verified composed entry is the entry." |
| `absorption:48`, `fib-retracement:65`, `cisd:53`, `fair-value-gaps:42` | "No setup without a fired strategy" / "and a fired strategy" | "No entry without verified reads" |
| `setup-judgment` | Judges each fired strategy's setup | Composes from the skills, calls `compose_check`, then `experience_lookup` (section 4.4) |
| `agents/risk-manager.md:84-91` (step 0) | Candidate or veto | An `ok` composed record for this bar (and, in an attempt, its verdict); else veto |
| `momentum-and-volume:56-57` | "Momentum: closes at the side's extreme, ranges at or above ATR, participation 1 or more, ADX rising" | The bar read of D4 (close in the far third, range at least 1 ATR, volume at least the 20-bar average); "ADX rising" leaves the momentum read, since the trend is its own read |
| `trade-plan` | `order_plan` with a strategy | Unchanged rule; the example uses `strategy: "trade_lifecycle"` |
| `trading/skills-loaded.js:44` (`REQUIRED_FOR_ENTRY`) | Names `strategy-library`, `strategy-scan`, `strategy-gate-checks` | Names the new skill, composed-entry, instead (section 9 deletes the three) |
| A new skill, composed-entry (index only) | | The read forms, side agreement, the stop and target rules, how to use the record (section 4.5), one worked example per scenario |
| The concept gaps (section 6) | | A new skill teaching order flow; CRT, acceptance and the 80% rule in the existing skills; the kept parameters as guidance |

Each change is synced to every harness by `node scripts/sync-harness.js`.

## 8. Facts for scenario 2

1. **4h candle facts:** add 240 to the candle timeframes
   (`candle-facts.js:74`), so a 4h candle's sweep of the prior 4h low is a
   `rejected` relation like any other.
2. **4h swing targets:** add 240 to the target frames (`briefing.js:419`).
3. **FVGs per timeframe:** open FVGs on 5m, 15m and 60m, each with whether
   the last completed candle retested it.
4. **5m structure:** `lastBreak` on 5m candles, from the base bars when
   they divide 5m, else a 1m lane's bars (as 5m candle facts are built
   today, `candle-facts.js:380`); never approximated. No 5m lane.
5. **Prior-candle levels per timeframe** are already met as "previous
   <tf> high/low" (`candle-facts.js:430`); nothing to add.
6. **The shared momentum read** per timeframe (D4).

Each is a briefing fact first (with tests and no look-ahead), then a read
form. The same holds for section 6's gaps. Prompt size: a new fact goes in
the briefing's data; it reaches the rendered prompt text only when a skill
reads it there, and each PR reports the head trader's prompt bytes before
and after, so phase A doesn't grow the prompt unnoticed.

## 9. Composed as the only strategy

The owner: "We can delete all the old strategies ... This is the only
strategy." No gradual demotion: every strategy document goes, and
`strategies/trade_lifecycle` is the only one. The harness places no entries
between the deletion and composed's proof ("we won't trade until this is
done and perfected"); the gate refuses any entry naming a deleted strategy
(`strategies.js` `checkStrategyForOrder`), which is failing closed. Exits
and protection return before every entry check (`order-gate.js`
`evaluateOrder`, its first line) and keep working throughout; the runner's
exit management (`runner.js`, `exitPlan`) keeps a position's exit until it
closes.

**Deleted documents.** Every folder under `strategies/`: `cisd_ote`,
`crt_1h`, `crt_4h`, `ofi`, `ofi_absorption`, `orb`, `prop_flow_1m`,
`prop_portfolio`, `value_area`, `value_area_breakout`, `value_area_reentry`,
`vwap_reclaim`, except `prop_portfolio`, which stays as the account layer
with no components (the owner, 2026-10-14; section 3.7). Done on
2026-10-14: the ten rules strategies and `prop_flow_1m` are deleted and
listed in `strategies/retired.json` (an entry or config naming one is
refused, saying so), and `prop_flow_1m`'s rulebook entry went with it.
Still to do, with `trade_lifecycle` in phase C: `_template` and
`README.md` rewritten for `signal: composed`.

**Kept as facts** (they feed the briefing, the candle facts or the
snapshot): `cisd.js` and `fib.js` (`briefing.js:93`, `market-snapshot.js:15`),
`candle-facts.js`, `structure-events.js`, `volume-profile.js`,
`day-context.js`, `regime.js`, `mtf.js`, `mtf-state.js`, `indicators.js`,
`round-numbers.js`, `market-snapshot.js`, `trading/order-plan.js`
(`sideTarget`, `briefing.js:89`). `crt.js` moves into the facts first
(section 6, gap 1).

**Strategy-only code, removed in its own PRs after the documents:**

| Code | What goes | What stays |
|---|---|---|
| `trading/rules.js` | The rule compiler and evaluator | `readField`, `causalLevels`, `sideValuesText` (the briefing uses them, `briefing.js:92`) |
| `trading/crt.js` | Its rule-only parts | The detector, now a fact |
| `trading/strategies.js` | `scan`, `recentSignals`, `withConfluence`, `RETIRED`, the policy component check (in the validator), `componentRefusal` | The loader, the validator, `withRulebook` for `prop_portfolio` |
| `trading/signal-state.js` | The trigger and retired-lane logic, the candidates in the record | The per-bar record the runner writes every bar and `lastRecordedBar` (`signal-state.js:202-209`), which `verdictBarProblem` needs (`prop-state.js:403-404`); bar timing (`sameBar`, `barMs`, `prop-state.js:21`) |
| `trading/skills-loaded.js:66-76` (`SITUATIONAL`), `trading/skill-lookups.js:96-102, 119` | Triggers on `m3.candidates` and the signal record's setups | Rekeyed on the composed record's reads and skills (a `rejected` setup read requires `rejection`, any `ok` record `confluence-counting` and `invalidation`), in phase C. Until then no entry is possible, so no lookup is required |
| `prop/trade-stream.js:35` (`scan`), `prop/evaluate-run.js:17` (`backtest/run.js`) | Building combine attempts from strategy scans | A trade stream from replay fills into `prop/attempts.js`, built before `scan` and `run.js` go, since the promotion gate (D9) evaluates on it |
| `trading/scan-log.js`, `trading/track-record.js` | All | |
| `trading/evaluator.js` | Rule evaluation | `exitPlan`, `timeframeMs` |
| `backtest/run.js`, `walk-forward.js`, `report.js` | All, once `roundHalfEven` moves out of `engine.js` (used by `prop/verdict.js:17`) | `data.js`, `sim-broker.js` (the counterfactual), `engine.js` math |
| `autotrader.js:711-716`, `lanes.js` | Trigger `signal` (`lanes.js:61`, `signalLaneErrors` `:153`) and the per-lane strategy lists | Trigger `bar` |
| `runner.js`, `runner-wiring.js` | The per-bar scan, `laneSignals`, `scanLog`, `trackRecord` | Exit management; `exit-memory.js` keyed `trade_lifecycle` |
| `briefing.js` | `m3.candidates` and the Setups line | Every fact |
| `order-gate.js` | `trigger-fired` (`:300`), the policy-component and retired-lane checks | `setup-tag`, `strategy` (for `trade_lifecycle`), every risk check |
| `fact-claims.js:257-269` | The room fact against `m3.candidates` | The room fact against the composed record |
| `harness-tools/order-plan.js` | The candidate path (`candidateOf`, `:53`) | `order_plan` from the record |
| `harness-tools/registry.js:35-76` | `strategies_scan`, `strategies_recent` | `strategies_list`, `show`, `validate` |
| `replay/labels.js`, `scorecard.js`, `failures.js`, `trading/reasons.js` | What fired (`scans-<day>.jsonl`), labels keyed on a strategy, the strategy clone reason | Labels and scores keyed on the record |
| `prop/live-runner.js` | Picking among component scans | The verdict from the record |

**Skills, agents, commands.** Deleted: `strategy-library`, `strategy-scan`,
`strategy-rules`, `strategy-tools`, `strategy-authoring`,
`strategy-backtest`, `strategy-gate-checks`; `setup-expectancy` is rewritten
around the experience record; the `strategy-researcher` agent goes; the
commands `new-strategy` and `setup-scorecard` go or are rewritten. About 46
skill, agent and command files name a specific strategy and are rewritten
(heaviest: `prop-challenge-pacing`, `gate-refusals-limits`,
`setup-judgment`, `rejection`, `breakout`, `cisd`).

**Tests and goldens.** About 95 test files and 35 fixtures name a strategy.
Module tests leave with their code; gate, runner and replay tests that use a
real strategy switch to the fixture registries
(`tests/fixtures/strategies-fx`, `strategies-ext`, `strategies-fx-parity`)
so the plumbing composed keeps stays covered; the e2e tests
(`tests/e2e/mock-trading-e2e.test.js` uses `prop_portfolio` at line 305 and
`setup:orb` at 281) move to fixtures, then to composed. The 15 goldens in
`tests/fixtures/golden/` and `tests/scripts/cli-parity.snapshot.json` that
name a strategy are regenerated, each change explained in its PR.

**Docs.** `docs/research/mtf-setup-catalog.md` and
`docs/research/cisd-ote-textbook.md` stay as history (the skills that cite
them are rewritten to cite this inventory); `docs/LEARNED-RULEBOOK.md`,
`docs/BACKTESTING.md`, `docs/ORDER-FLOW.md`, `docs/QUANT-PLAN.md` and
`CLAUDE.md` (its policy-strategy paragraph and the strategies commands)
are updated in the PR that changes what they describe.

**Order, so the regression is never red:** phase A (section 6's gaps
filled: facts, skills, read forms) -> phase B (delete the documents,
rewrite their tests against fixtures, then remove the dead code, a few
PRs) -> phase C (build composed on the clean base) -> phase D (the
learning loop). Every PR passes `npm run verify`.

## 10. PR sequence

Each PR is small, runs `npm run verify`, and gets the adversarial review.

**Phase A: nothing the old strategies knew is lost.**

- **PR 1.** **CRT as a fact** (section 6, gaps 1 and 6: the sweep, the shift,
  the far side, its context; the regime read).
- **PR 2.** **"This bar" flags** (gap 2).
- **PR 3.** **Momentum and volume reads** (gap 3; D4).
- **PR 4.** **Order-flow facts and a new skill teaching order flow** (gap 4).
- **PR 5.** **Scenario 2's facts**, in section 8's order, one PR each (D8).
- **PR 6.** **Reads checker.** `scripts/lib/trading/composed-reads.js`: parse and
  check reads against a briefing, side agreement, the full structured
  candle relations, every form of sections 3.2 and 6, the signatures; pure,
  with unit tests. No tool, no gate change.
- **PR 7.** **Skills** for the concepts (section 6's guidance), synced.

**Phase B: delete the old strategies (D14).**

- **PR 8.** **Documents and their tests.** Delete every strategy folder and the
  rulebook policies; move gate, runner and replay tests to fixture
  strategies; regenerate and explain goldens; delete the strategy skills,
  agent and commands; `REQUIRED_FOR_ENTRY` names no deleted skill.
- **PR 9.** **Attempts from replay fills:** the trade stream from replay
  fills into `prop/attempts.js`, replacing `prop/trade-stream.js`'s scan and
  `prop/evaluate-run.js`'s `backtest/run.js`, so the promotion gate keeps
  an input.
- **PR 10.** **Dead code,** one PR per area of section 9's table (runner and
  lanes, keeping the per-bar record; gate and fact claims; replay;
  backtest; tools).

**Phase C: composed.**

- **PR 11.** **`compose_check` and the record.** The tool, the record file, the stop
  and target rules, the minimum stop; `strategies/trade_lifecycle`
  (`signal: composed`, `status: active` with its entries refused until PR 12, `risk.max_risk_usd` required).
- **PR 12.** **Gate.** `composed-reads` (re-runs the checker, keyed on the tag,
  requires the limit entry), side agreement, the replay exemption (D10),
  `factsOrder` for room facts, `SITUATIONAL` rekeyed on the record; gate and wiring
  tests (`tests/lib/order-gate.test.js`,
  `tests/hooks/trading-hooks.test.js`).
- **PR 13.** **order_plan, the limit entry and the prop verdict** (section 3.7).
- **PR 14.** **Runner:** every bar on the composed lane (D11); cancel a
  working composed limit at `expiresAt`; the exit plan and trail for
  `trade_lifecycle`; the journal instincts off for composed runs.
- **PR 15.** **Skills and the risk manager:** section 7's text, the new skill
  composed-entry, synced.
- **PR 16.** **Records:** section 5.
- **PR 17.** **Scenario 1 and 2 end to end:** e2e tests on real bars, the model's
  reads, the record, the gate allowing a paper entry in replay and
  refusing a false or disagreeing read.

**Phase D: the learning loop.**

- **PR 18.** **Experience log:** the end-of-day step and its module (section 4.2).
- **PR 19.** **Index:** the CLI and module, teaching months only, the by-day interval, `MIN_N`, the intervals, the
  pinned hash (section 4.3).
- **PR 20.** **`experience_lookup`:** the tool, its recording, and the gate's lookup
  requirement behind D15 (section 4.4).
- **PR 21.** **Exploration and lessons:** the `exploratory` flag and its gate rule,
  the lesson statistics (sections 4.5, 4.6).
- **PR 22.** **Paired replay:** the three arms, the scorecard's adherence-to-record
  measure, the ledger entries (section 4.8).

Then practice on teaching months, the paired replay on months after the
model's cutoff (D23), the frozen
promotion gate, and the owner's decision.

## 11. Risks

- **Fishing for true reads.** The model can call `compose_check` until a
  combination passes. Every call is recorded; the log scores what was
  tried, not just what passed. The per-bar limit is D6.
- **Reads that are true but meaningless.** Verification proves the facts,
  not the edge. That is what the learning loop measures (section 4).
- **Stops at noise.** The minimum stop (D13), `risk.min_rr`, the budget and
  the zero-blow rules bound the loss.
- **A small local model writing closed forms.** Malformed reads refuse; the
  cycle log counts them, so the forms can be simplified from evidence.
- **Cycle cost.** Cycling every bar (D11) runs the full role round on bars
  where nothing is worth composing; the report cache and the lookup budget
  bound it, and the cycle log measures it.
- **Learning noise.** Small samples and regime shifts can teach the wrong
  lesson; section 4.8's guards and the paired replay answer it.
- **No trading during the rebuild.** Accepted by the owner; exits keep
  working.
- **Prompt size.** The new skills are index-only; the embedded text only
  swaps sentences; the two tools add their schemas once to the cached head.

## 12. Owner decisions

Each has a proposed default; the owner may change any of them.

- **D1.** Approve the design: one `signal: composed` strategy document plus
  `compose_check` and the learning loop. *Proposed default: yes.*
- **D2.** Trend rule. *Proposed default: follow today's trend rule;
  against the trend only with a code-verified reversal (a higher-timeframe
  CHoCH the order's way).*
- **D3.** Stop buffer beyond the invalidation level. *Proposed default:
  1 tick.*
- **D4.** The momentum read. *Proposed default: a bar read only: the bar's
  range at least 1 ATR(14), a close in its far third, volume at least the
  20-bar average (the bar part of `cisd_ote` version 5). The trend
  (ADX(14) at least 20, EMA20 beyond EMA50) is its own read, so the model
  chooses whether to pair them.*
- **D5.** `trade_lifecycle` in a prop attempt. *Decided 2026-10-14:
  `prop_portfolio` stays the account's policy and lists `trade_lifecycle`
  as its one component (section 3.7); it enters an attempt only once replay
  proves it.*
- **D6.** `compose_check` calls per bar. *Proposed default: about 3; a hard
  limit inside an attempt.*
- **D7.** Required steps. *Proposed default: all six steps stated, each with
  the model's own read; the skill at each step is free. A step becomes
  optional only if the per-step record (section 4.3) shows it adds nothing,
  and only by the owner's decision.*
- **D8.** Scenario 2's facts. *Proposed default: 4h candle facts and 4h
  swing targets first, then FVGs per timeframe, then 5m structure from 1m
  bars (no 5m lane).*
- **D9.** What moves `trade_lifecycle` from `paper` to `active`. *Proposed default:
  the frozen promotion gate (`prop/promotion.js:12`) on the paired replay,
  then the owner's approval.*
- **D10.** How a `paper` composed entry trades in replay. *Proposed default:
  only when the broker and the run config are both replay, as
  `lockExemption` (`account-lock.js:199-203`); refused everywhere else.*
- **D11.** The runner's trigger for composed. *Proposed default: every bar
  (trigger `bar`) on the composed lane in replay practice; trigger `signal`
  is removed with the strategies.*
- **D12.** Side agreement. *Proposed default: required and code-enforced
  (section 3.2).*
- **D13.** Minimum stop and the entry order. *Proposed default: a stop of at
  least the larger of 8 ticks and 0.25 x ATR(20) of the base bars (half the
  briefing's 0.5 x ATR(20) reference stop, `briefing.js:38`; 8 ticks is
  2.00 points, $4.00 a micro contract on MNQ); a closer stop is refused,
  never widened; the entry a limit at the entry reference or better,
  cancelled at the record's expiry.*
- **D14.** When the old strategies are deleted. *Proposed default: right
  after phase A, when every concept in section 6 is present as a skill, a
  fact and a read form; before composed is built. No trading until composed
  passes D9.*
- **D15.** Whether the gate requires an `experience_lookup` before a
  composed entry. *Proposed default: recorded from the first PR; required
  once the pinned index holds data for the root.*
- **D16.** Minimum sample before a statistic is shown. *Proposed default:
  20 decisions over at least 10 distinct trading days per cell; 90%
  intervals from resampling days.*
- **D17.** The context keys. *Proposed default: the six of section 4.2,
  bucketed as the briefing names them.*
- **D18.** Exploration. *Proposed default: replay practice only, at the
  minimum size, flagged; refused elsewhere.*
- **D19.** Whether the record binds. *Proposed default: advice, taught in
  the new skill, composed-entry, not enforced by the gate; adherence to it is
  measured.*
- **D20.** Adopting a new index into the champion. *Proposed default: only
  after the paired replay and the promotion gate, with the owner's
  approval; practice indexes rebuild freely between practice sessions.*
- **D21.** Old records. *Proposed default: no decay weight; the per-year
  split, last-seen date and `shifted` flag show age.*
- **D22.** The lookup's budget. *Proposed default: at most 2 calls per
  cycle bar, output at most 4 KB.*
- **D23.** Which months teach and which judge, given the model's training
  cutoff (section 4.7). Today's replay bars end around 2026-07-20, so
  months after the cutoff (`LLM_FROM` 2026-06-01) are scarce: June 2026 is
  in Recent (reasoning-fix looks only), and 2026-H2 has begun. Options:
  - *Wait for data:* practise and judge only after the cutoff. Clean, but
    the promotion gate needs at least 20 attempts over two months, so
    months of waiting.
  - *Practise before, judge after:* practise and index on Train; judge
    only on months after the cutoff. Each walk-forward half-year (2026-H2,
    2027-H2, ...) is a tuning quarter then a held-out quarter
    (`prop/splits.js:23-26, 171-172`): the paired replay and the promotion
    gate judge on the held-out quarter; a look at the tuning quarter is a
    logged pre-check. The reserve half-years (2027-H1, ...) become an
    out-of-sample window only once they hold `RESERVE_MIN_MONTHS` (12)
    months (`prop/splits.js:65`). The record's statistics stay true (code computes them);
    practice choices may reflect recall, which the clean judgment exposes
    rather than rewards. Judging waits for those months.
  - *Mask dates and rebase prices:* hide the date and shift every price in
    practice briefings. It weakens recall but breaks replay equals live
    (the briefing would differ from live), round-number levels, holidays,
    rolls and news, and doesn't hide the shape of famous days.

  *Proposed default: practise before, judge after. Practice and indexing on
  Train; Select and Out-of-sample only as a pre-check marked as possibly
  recalled; the tuning quarter of 2026-H2 as a logged pre-check; the paired
  replay and the promotion gate (D9) on the held-out quarters (2026-Q4
  first), then the reserve once it is an out-of-sample window.*
