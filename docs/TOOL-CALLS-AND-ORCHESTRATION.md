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

- `node scripts/workflows.js validate` joins `npm run verify`;
- the Layout in `CLAUDE.md` names `workflows/`;
- the ECC architecture test covers the loader and its CLI.

`sync-harness` generates nothing from a workflow: the runner reads it, and no
model is given it to follow.

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
  timedOut, output, transcript }`. The first engine is `opencode run --agent
  <role>`; for it, the desk's roles are `mode: "all"`, because opencode runs a
  subagent that way as its default agent instead. Nothing above the interface
  names a harness. A later engine (`opencode serve` sessions, or another
  harness) plugs in under it.

### The desk, the first workflow

1. The report cache serves what it can. The desk workflow runs the rest of the
   desk: the three analysts and risk-manager phase 1, in parallel, each with
   the request built in code.
2. A report counts only if its run read data (a broker call, a file read, or a
   market or account tool, not a skill or past-decision lookup) and has its
   role's report shape. A role that fails is run again once; then it is
   recorded missing, a process failure for that cycle.
3. The reports reach the head trader the way cached reports already do: in its
   prompt, and through `FTH_CYCLE_CACHED` and `FTH_CYCLE_CACHED_LOOKUPS`, so
   the order gate counts them as returned.
4. The head trader keeps the judgment: synthesis, `compose_check`,
   risk-manager phase 2 and the trade-executor.

The model no longer decides whether the desk runs; it is complete by
construction. The multi-agent design is kept: the same roles, their own
skills, their own analysis.

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
5. **Deleting the rules the desk makes unnecessary**, and closing #236.

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
