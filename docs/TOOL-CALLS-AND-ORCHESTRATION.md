# Tool calls and orchestration

The design of the two layers every model action passes through: the **tool-call
layer** (one pipeline of rules every tool call runs through) and the
**orchestration layer** (code that runs multi-role steps, such as the desk).
Owner-approved on 2026-10-16. It is the target design: the build order below
says what exists today and what each PR adds. It follows the ECC architecture
([HARNESS-DESIGN.md](HARNESS-DESIGN.md), CLAUDE.md): the rules and the
workflows are canonical documents, generated into each harness's own format,
with their logic in small tested modules.

## Why

The harness drives a small local model. In the PPC runs of 2026-10-16 its
failures were in two places:

- **Tool calls.** It invented a `task_id`, called tools by the skills' bare
  names, repeated a refused call 386 times, shortened file paths, and took a
  launch that returned for a role's report.
- **Orchestration.** Asked to launch its desk of roles, the head trader skipped
  them in most cycles. It analysed alone, or decided with no tool call at all.

Each fix (#229, #232, #234, #235, and #236, still open) answered one failure where it was
cheapest. They ended up in four places with no shared record, result format
or error format, and orchestration still depended on the model choosing to
orchestrate. This design replaces the patches with two layers. It borrows from
the DeepSeek harness (`deepseek-ai/deepseek-harness`), whose robustness comes
from strict contracts and from not asking the model to orchestrate when code can.

## The tool-call layer

### Rules are hooks

Today `hooks/hooks.json` holds the order gate (`PreToolUse` on the order tools),
session start and the stop reminder, and the opencode-specific rules live in
`scripts/opencode-plugin.js` and `scripts/lib/opencode.js`. In this design every
rule is a canonical entry in `hooks/hooks.json`:

- an event: `PreToolUse` (before a call), `PostToolUse` (after a call that
  returned), or `PostToolUseFailure` (after a call that failed);
- a matcher (the tool names it applies to);
- a thin script that runs it through `scripts/hooks/run-with-flags.js`.

A rule's logic lives in `scripts/lib/toolcall/`, one small tested module per
rule, listed in one registry. All rules share one record shape:

```text
{ id, event, matcher, failClosed, check(call, log) -> ok | repair(args) | refuse(why, route) | note(text) }
```

The `hooks.json` entry and the module are one rule. The entry is what each harness
reads: an event, a matcher, and the dispatcher `scripts/hooks/toolcall.js <event>`
through `run-with-flags.js`. The dispatcher loads the registry and runs every rule
whose event and matcher fit the call. Harnesses whose hooks start a process per call
(Claude Code) run the dispatcher, keep the per-call state in the call log file, and
pay a process start per call, as the order gate does today; it stays small and fast,
within the hook timeout. Harnesses with an in-process plugin (opencode) run the same
registry in-process.

| Outcome | Effect |
|---|---|
| `ok` | The call goes on. |
| `repair` | The call's arguments are changed before it runs (an invented `task_id` dropped). |
| `refuse` | The call doesn't run. The model reads `[rule-id] <why>. Route: <the exact next call>`. |
| `note` | Advisory text added after a result (the repeat reminder). |

### The pipeline

Every call passes these stages in order, as in the DeepSeek harness's tool
execution pipeline:

1. **Normalise the name.** A skill's bare name (`compose_check`) maps to the tool
   meant (`harness_compose_check`). Where the harness can't reroute the call,
   the answer names it.
2. **Normalise the arguments.** Repairs that keep the intent, such as dropping
   a `task_id` that names no session.
3. **Validate** against the tool's schema: the harness tools server's own
   validation (`harness-tools/validate.js`, after its repair) for our tools,
   and the harness's own schema checks for its built-ins.
4. **Policy.** Denied roles, desk preconditions. A refusal is final: no later
   rule can turn it into an allowance.
5. **Execute.**
6. **Classify** the result as `ok`, `error` or `refused`, a closed set. MCP
   tools are classified inside our own MCP servers (the harness tools server
   and the gateway), which know the outcome. It is never inferred from timing.
7. **Guards.** Repeated identical calls, per-role step caps, timeouts.
8. **Present.** One formatter, so every refusal reads the same way and names
   the route.

### One call log

`scripts/lib/toolcall/call-log.js` records each call per session: tool,
canonical arguments, outcome, time, and the launch it belongs to. It is a
file under the harness home, written append-only, so a dispatcher process per
call and an in-process plugin both read and write it. The live
rules read it, and so do `roles-ran.js` and `desk-check.js`, so the gate's
view and the live view can't disagree.

### Generated adapters

The rules are written once and run the same in every harness:

| Harness | How it runs the rules |
|---|---|
| Claude Code | Its native hooks, from `hooks/hooks.json` |
| opencode | `scripts/opencode-plugin.js`, hand-written today, becomes generated by `node scripts/sync-harness.js`: it loads `hooks/hooks.json` and runs the matching rules on `tool.execute.before` (`PreToolUse`) and `tool.execute.after` (`PostToolUse`). Failures of MCP tools come from the servers' classification, because opencode's after hook doesn't run for them. |
| Qwen Code, Codex | Their hooks where they have them. Where they don't, the repair and guard rules don't run there: only the MCP servers' own checks and the order gate (in its hook or the gateway) do. |

### What opencode can't host

These limits are measured against opencode v1.19's source:

- A call to an unknown name goes to its built-in `invalid` tool. The rule can
  answer it, but can't run the call meant; the model issues it again.
- An MCP tool that fails throws inside opencode's wrapper, so the after hook
  doesn't run. That is why MCP failures are classified in our servers.
- No scheduler control. opencode decides parallelism and order within a step.

### Invariants

- **The order gate and the gateway stay authoritative and fail closed.** The
  layer only adds refusals before them, never allowances. Nothing disables the
  gate when `FTH_AUTONOMOUS=1`.
- **No rule refuses a risk-reducing action:** an exit, a stop, a cancel, a
  partial close, or the end-of-day flatten. A rule that can refuse never
  matches those tools. A contract test checks every refusing rule's matcher
  against the broker interface's order and exit tools.
- **Fail-closed is per rule.** A rule that can refuse an entry or the step
  before it (`compose_check`, `place_order`) declares `failClosed: true`, and a
  throw refuses, as the order gate does (`FAIL_CLOSED_HOOKS` in
  `run-with-flags.js`). Every other rule fails open: a throw is logged, and the
  call goes on. An advisory `note` that throws adds nothing.
- **Every rule has a measured trigger rate** (refusals per rule id in the cycle
  log). A rule that stops firing is deleted, so the pipeline doesn't grow
  patches forever.

## The orchestration layer

### Workflows are documents

A multi-role step is a canonical document,
`workflows/<name>/WORKFLOW.md`, like a strategy or an account. Its frontmatter
decides the steps: the phases, the roles in each, how many run at once, how
many retries, which named request builder each role gets, and which named
acceptance checks a result must pass. The builders and checks are code (a
registry in `scripts/lib/orchestrate/`, as a strategy's `signal` names code).
Its body explains the workflow for people. A tested loader
(`scripts/lib/orchestrate/workflows.js`) reads and validates it and refuses an
invalid one, as `strategies.js` does. As with strategies:

- every shipped workflow is validated by its test in `npm test`, which `npm run verify` runs, and by
  `node scripts/workflows.js validate`;
- the Layout in `CLAUDE.md` names `workflows/`;
- the ECC architecture test covers the loader and its CLI.

`sync-harness` generates nothing from a workflow: the runner reads it, and no
model is given it to follow.

A phase may declare `orders: true`: it runs the one role that holds order
tools (`trade-executor`), only as the last phase, alone, with `retries: 0`. No
other phase runs that role.

```yaml
name: desk
phases:
  - name: desk
    parallel: [market-structure-analyst, trend-momentum-analyst, volume-liquidity-analyst, risk-manager]
    request: desk            # the request built in code for each role (orchestrate/requests.js)
    accept: [read-data, report-shape]
    retries: 1
```

### The engine

`scripts/lib/orchestrate/`, after the DeepSeek harness's workflow engine:

| Primitive | What it does |
|---|---|
| `agent(role, request, { retries, timeoutMs })` | One role's run. It returns an envelope `{ ok, role, text, attempts, ms, stop, why }`, with `stop` one of `completed`, `failed`, `timed_out`, `cancelled` or `invalid`. It never rejects: a failed child is a result the workflow decides about. |
| `parallel(tasks, { concurrency })` | The tasks at once, at most `concurrency` at a time (config: the model server's concurrency). |
| `phase(name)`, `log(text)` | Named steps and notes, recorded in the cycle log. |

- **Cancellation.** One signal per run, shared with the cycle's deadline. Every
  child is stopped and awaited on every path.
- **Attribution.** Every child carries `{ cycle, phase, role, seq }` in the
  cycle log, with its transcript, its data reads and its result.
- **Misuse is loud.** An unknown role, a bad option or a missing engine is an
  error, not a result.
- **The engine interface:** `engine.run(role, request, signal) -> { ok,
  timedOut, output, transcript }` (`cycle-run.js runRole`), on every harness
  that runs one role as a headless run of its own with that role's tools
  (`autotrader.js ROLE_RUNS`). Claude Code: `claude -p <request> --agent
  futures-trading-harness:<role>`, the session taking that role's prompt,
  tools and model, its `--allowedTools` the role's own tools (none wider than
  the head trader's), its `--disallowedTools` adding the subagent tool and the
  order tools it doesn't hold (only the trade-executor holds them), with the
  head trader's lock-down otherwise (`--plugin-dir`, stream-json, `dontAsk`,
  a replay's strict MCP config, `childEnv`). opencode: `opencode run --agent
  <role>`; for it, the desk's roles are `mode: "all"`, because opencode runs a
  subagent that way as its default agent instead. Each run is read the same
  way, `{ text, tools }` (`transcript.js claudeRunResult`, `opencode.js
  runResult`), tools named `<server>_<tool>`, with its lookups from its own
  transcript. Codex and Qwen Code have no headless run of a named role that
  holds its tools: there the head trader launches the desk, phase 2 and the
  trade-executor in its session, as before. Claude Code's stream-json doesn't
  time the head trader's own launches, so the gate can't order a phase 2 it
  launched itself against the runner's record (`autotrader.js
  TIMED_LAUNCHES`): there the runner runs the desk only in a cycle whose entry
  it may run (below), and drops a desk it couldn't complete, record and
  reports, so the head trader runs its whole desk, as before. Nothing above
  the interface names a harness.

### The desk, the first workflow

1. The report cache serves what it can. The desk workflow runs the rest of the
   desk: the three analysts and risk-manager phase 1, in parallel, each with
   the request built in code.
2. A report counts only if its run read data (a broker call, a file read, or a
   market or account tool, not a skill or past-decision lookup), has its
   role's report shape, and, in index mode, looked up every skill the bar
   requires of its role (`lookups`: the requirement is the gate's own, and the
   request names the skills). A role that fails is run again once; then it is
   recorded missing, a process failure for that cycle, and not given to the
   head trader, which launches it itself.
3. The reports reach the head trader in its prompt, beside the cached ones.
   The order gate learns of them from the runner's role record
   (`FTH_CYCLE_ROLES`, `scripts/lib/trading/runner-roles.js`): one line per
   role the runner ran this cycle, with the run's wall-clock start and end,
   its report, the skills it looked up naming its role, and whether it
   counted. `roles-ran.js` merges these runs into the transcript's calls, so
   they are judged by the same rules: the same ordering (phase 2 starts after
   phase 1 and every analyst ended), the same verdict and veto reading, the
   same index-mode lookups, and a recorded `trade-executor` run ends the
   round as a launch does. A missing or unreadable record adds nothing (fails
   closed). Only reports genuinely served from the cache go through
   `FTH_CYCLE_CACHED` and `FTH_CYCLE_CACHED_LOOKUPS`. The record lives under
   the harness home's `logs/` (mode 0600), the cycle log reads it for the
   desk check, and the runner deletes it when the cycle ends.
4. The head trader keeps the judgment: synthesis and `compose_check`. Where
   the runner runs the entry (below), phase 2 and the trade-executor are its;
   elsewhere the head trader runs them, as before.

The model no longer decides whether the desk runs; it is complete by
construction. The multi-agent design is kept: the same roles, their own
skills, their own analysis.

### The entry, the second workflow

`workflows/entry/WORKFLOW.md`, run by `scripts/lib/runner-entry.js` (wired by
`runner-wiring.js entryFor`), inside the cycle's time (`cycle-run.js`: after the
head trader's run, before the cycle log; per role `config/runner.json`
`entry.timeoutMinutes`, never past the cycle's limit).

1. **When.** A one-symbol full trade cycle on a harness that runs a role on
   its own (Claude Code, opencode), not manage-only or paper, with the
   runner's desk wired, that started flat with no working
   orders (the account read before the desk; unknown is not flat), and whose
   desk is complete in the runner's record or the report cache. A data lane
   (`trigger: data`) never cycles, so a 3m lane with a 1m data lane is still
   one item per cycle and runs it; two trading lanes closing together run
   the old way. (The
   trade-executor is a session of its own: a role the head trader launched
   itself is only in its transcript, which the executor's gate doesn't read.)
   Then the head trader's prompt says the route, its run gets
   `FTH_CYCLE_ENTRY=1`, and the tool-call rule `entry-route` refuses its own
   launch of the trade-executor, and of the risk manager unless phase 1 is
   still owed (`FTH_CYCLE_DESK`), naming the route: "call compose_check; when it
   is OK, end with CYCLE RESULT: planned; the runner runs risk-manager phase 2
   and the trade-executor". It matches only role launches and fails closed
   (such a cycle has nothing to exit). Any other cycle: as before.
2. **The decision.** The head trader ends `CYCLE RESULT: planned` after an OK
   `compose_check`. The runner takes the latest compose record on the cycle's
   bar (`lifecycle-gate.js recordsAt`); not OK, or none, or a planned line whose
   side (or stated size) isn't the record's, is a process failure: logged,
   nothing runs, the head trader's line kept. It records the head trader's loaded skills, derived in
   code from its transcript (`skills-loaded.js skillsInTranscript`), in the
   role record (`runner-roles.js appendHeadSkills`): the gate counts them for
   the executor's run of the runner's own (`skills-loaded`, `skills-at-entry`),
   never for a hook's own transcript. Claude Code's order hook in that run
   (an autonomous run with `FTH_CYCLE_ID` and its own `FTH_CYCLE_TRANSCRIPT`)
   judges on the run's streamed transcript and the record, as the gateway does
   (`check-order.js hookTranscript`): its session file holds none of the head
   trader's loads.
3. **`review`.** Risk-manager phase 2 on the record (the `review` request: the
   record, the desk's reports with phase 1's, the cycle's bars file and the
   `order_plan` call to check it with), the cycle's own context (bars, lanes,
   start). Accepted on `read-data`, `verdict-facts` (a verdict and its FACTS
   line, by the gate's own readers) and `lookups`; retried once. Recorded with
   its wall-clock times, so the gate orders it after phase 1 and the analysts.
4. **Between the phases, in code.** Anything but APPROVE stops the entry (a
   VETO is the cycle's no-trade with its line). The order comes from
   `order_plan`'s own operation (`harness-tools/order-plan.js` ->
   `trading/lifecycle-order.js composedOrder`; in a prop attempt the policy
   verdict it records), so its rationale and brackets are what
   `composed-reads` checks. The journal plan for the bar (`kind: plan`,
   `contractId`) goes through the broker adapter (`journalAdd`); the gate's
   `plan-required` takes, in a runner's cycle, only a plan written since the
   cycle bar's close (a composed entry: its record's bar, never another lane's).
   A record that expired first is its own outcome, `expired`.
5. **`execute`.** The trade-executor with those exact arguments and phase 2's
   verdict line (the `execute` request), `orders: true` and `retries: 0`: only
   a workflow's last phase may run the order role, once. Accepted on
   `order-sent` (its `place_order` completed, or it reported the refusal). Its
   own run has its own transcript; the gate reads the role record
   (`FTH_CYCLE_ROLES`) for the roles and phase 2's facts, the cycle's bars
   (`FTH_CYCLE_BARS`) for the record, and its orders carry the cycle's id
   (`FTH_CYCLE_ID`). Recorded: it ends the round.
6. **After the order.** The runner reads the account and open orders through
   the adapter: executed (a position on the family, or the gateway's record of
   this record's entry), blocked (the gate's refusal in its log, or the
   executor's BLOCKED or ABORTED first line, or a call that completed with
   nothing on the account), unknown (the gate let it through and its reply
   never came: reported `executed`, possibly placed), or a no-trade naming the
   failed run. A lost or late reply sends no second entry; the next cycles manage and exit it as
   any position. The cycle log records the outcome and its timing (`entry`:
   ms from the bar's close to the head trader's planned and to the order sent,
   the gate log's allowed decision of this cycle's order, or for an expired
   record to the refusal, and each role's ms), phase 2's facts
   (`factCheck`) and the desk check from the record; the decision history reads
   a veto from it.

## What each earlier fix becomes

| Fix | Becomes |
|---|---|
| #229 drop an invented `task_id` | A `PreToolUse` repair rule |
| #232 role step cap | Kept: the guard in each role's generated config |
| #232 bars-path hint | Kept in the harness tools server (the route in the error) |
| #234 tool-name hint | A `PreToolUse` rule on opencode's `invalid` tool |
| #234 repeat guard | A `PostToolUse` note rule plus a `PreToolUse` refusal, on the call log |
| #231 desk log | Kept; it reads the call log and the desk workflow's results |
| #235 desk precondition | A backstop rule; with the desk workflow nothing is left for it to wait for |
| #236 data-read check (open) | The desk workflow's `read-data` acceptance check; #236 is closed unmerged when the desk workflow lands |

## Build order

Orchestration first (the owner's order: the desk is the failure that costs most),
then tool calling. Each step is its own PR, with its tests:

1. **The orchestration engine and its loader**, plus `workflows/desk/WORKFLOW.md`
   and `node scripts/workflows.js validate`.
2. **Wiring the desk into the runner** (after the report cache, before the head
   trader's prompt), and the desk's roles as `mode: "all"`.
3. **The rules registry, the dispatcher and the generated opencode adapter**,
   with today's rules ported and their behaviour unchanged (refusal texts
   pinned), and the contract tests (matchers against the order and exit tools,
   fail-closed per rule).
4. **Classification of MCP failures** in the harness tools server and the
   gateway, and the call log.
5. **Deleting the rules the desk makes unnecessary**, and closing #236. (Each patch
   that becomes a rule in step 3 is deleted from its old place in that same PR: one
   way of doing each thing.)

## Tests

- **Unit.** Each rule and stage. The normalisers and the argument canonicaliser
  are idempotent. The engine's envelopes, retries, concurrency and
  cancellation. The workflow loader refuses invalid documents.
- **Contract.** Every rule has an id, an event, a matcher and a route in its
  refusal. No refusing rule refuses a risk-reducing action. The generated
  opencode adapter runs exactly the rules `hooks.json` declares.
- **e2e.** The scripted model drives the real pipeline and runner: an invented
  `task_id`, a bare tool name, a repeated failure, the desk run by the runner
  (four reports in the head trader's prompt, the gate counting them), a role
  that reads nothing (retried, then recorded missing), and an entry that still
  needs phase 2.
- **Live smoke.** Five cycles before a long run:
  - the desk complete in every cycle;
  - refusals per rule id;
  - failed calls per cycle;
  - minutes per cycle;
  - the `compose_check` rate.
