# Live dry run

A runbook for the first sessions on a live broker account (a practice account
first): set up, check, run, watch, end, and score one trading day. Every step is
the same for any broker: the harness reaches it only through its MCP server
(`docs/BROKER-MCP-INTERFACE.md`), named in `mcp-configs/brokers.json`.

Times are New York time (ET). The market session is 18:00 ET to 16:00 ET the
next day, Sunday evening to Friday afternoon.

## 1. Environment and broker config

- `mcp-configs/brokers.json` names the default broker server and each server's
  settings (`env`), journal, paper settings (`paperEnv`) and allow-list variable
  (`allowedAccountsEnv`). Override or add brokers in
  `~/.futures-trading-harness/brokers.json`, or pick one with `FTH_BROKER`.
- Install the broker's server from its own repo (`repo` in its entry) and follow
  that repo's docs for credentials, its guardrails (max order and position size,
  daily loss) and any bar fields your strategies read.
- Put credentials and settings in `~/.futures-trading-harness/.env` (or
  `FTH_ENV_FILE`), never in the repo. Every CLI loads it; a variable already set
  in the environment wins.
- Check the server alone: `node scripts/check-broker-mcp.js --account <id> --
  <server command>`.

## 2. Account and the allow-list

- Pick the account to trade (a practice account first). Its id is in the
  server's `list_accounts` (preflight prints it).
- Set the broker's allow-list variable (the `allowedAccountsEnv` of its entry
  in `brokers.json`) to that account id in your `.env`, e.g. `<VARIABLE>=12345`.
- A live run (`"paper": false`) refuses to start, and the order gate refuses
  every live entry (`[allowed-accounts]`), while that list is empty, `any`, or
  lacks the account. The server must agree: its own `get_server_config` must
  list the account in `allowedAccountIds` (never "any"), and a run counts as
  paper only when the server reports trading off. Exits, protective stops, stop
  moves, cancels and closes are never refused by it, so a position can always
  be managed or flattened.
- Paper runs (`"paper": true`: the runner sets the broker's paper settings, so
  the server refuses every order) and confirmed replays need no list.
- In the runner config (`mcp-configs/autotrader.example.json`), set `account`
  to the same id and keep `"paper": true` until a paper day has run cleanly.

## 3. Prop attempt

If a policy strategy (`signal: policy`) trades a prop account profile
(`accounts/<name>/ACCOUNT.md`), start its attempt once, before the first
session:

```bash
node scripts/combine.js start --account <profile name>
node scripts/combine.js status
```

The gate refuses that strategy's entries until it is started. The account's
balance must fit the profile's size (preflight checks it).

## 4. Preflight

```bash
node scripts/preflight.js --config ~/autotrader.json
```

Read-only: it places no orders. It starts the broker server as the runner does
(behind the contract translator) and checks the runner config (valid, `eodAt`
and sessions, a live run's account and allow-list), that the CLI harness command
resolves (and its `--version`; skip with `--no-version`), the broker interface,
that the server trades the account, the clock against the server's, the account
(exists, can trade, balance, profile size), that no other runner trades the
account (`account lock`), prop attempts, the bar fields active
strategies read with `field(...)` (a warning when missing), market hours (a
warning when closed) and the kill switch. Exit 0: ready (warnings allowed);
exit 1: fix every `FAIL` line first. `--json` prints the report as JSON.

With opencode, the live gate requires the roles' skill lookups by default
(`FTH_ROLE_SKILLS` unset is index mode: a role's report counts for an entry only
with the lookups its bar requires). The runner's start check turns trading off
on a workspace generated for another mode: for full mode set `FTH_ROLE_SKILLS=full` and run
`FTH_ROLE_SKILLS=full node scripts/sync-harness.js`; back to the default with
`node scripts/sync-harness.js`.

## 5. Start the runner

```bash
node scripts/autotrader.js --config ~/autotrader.json --dry-run   # the next action, nothing run
node scripts/autotrader.js --config ~/autotrader.json             # the live loop
```

One runner per harness home (a lock file), and one live runner per broker
account across every harness home: the account's lock is in
`~/.futures-trading-harness/locks/` of your OS account, whatever `FTH_HOME` or
`HOME` say (another OS user has other locks). `FTH_LOCK_DIR` moves it for tests
only: without `FTH_TEST_LOCKS=1` a live run refuses to start. It is keyed by the
broker server, not by the broker's name, so one server under two names is one
lock: by its resolved command and by the API URL the broker config names
(`apiUrlEnv`: one of its `env` variables, never a credential; a live run refuses
when it is missing or empty), both checked before the server is started; and by
the API its `get_server_config` reports (`apiUrl`, which a live run requires),
checked once it answers. So another install of the server on the same API is
refused before it starts. A
second runner on the same account, or a manual `--once trade` or `premarket`
run, is refused, naming the first one's pid, harness home and start time; a
live manual run names its account. A manual end of day (risk-reducing only)
never is refused, and takes no lock, so the gate refuses its entries
(`[account-lock]`). Paper runs and confirmed replays are exempt. A lock left by
a runner that is gone is taken over at start, with a log line. Before every
pass the runner checks its lock, and does exactly one of these: a lock file of
its own that was removed and stayed gone is linked back (logged); a lock held by
another runner it positively identifies (on this host, its pid alive and an
autotrader, the same on a re-read a second later) means that runner manages the
account, so this one takes no broker action at all (no cancels, flattens, trails
or end of day), logs and records it, and exits; anything else (unreadable,
another host's, a holder it can't identify) stops new entries (the kill switch,
with the reason) while it keeps full risk management of the account, as before
the lock existed (trailing, protection, exits, the end-of-day flatten), with an
alert every pass. Agent cycles other than end of day don't run while the kill
switch is on, so agent-decided exits wait for end of day; held again, the runner
re-arms nothing, so removing the kill switch resumes it. The gate refuses that runner's cycles' entries as soon as the lock isn't its
own, and any entry of theirs on another account than the one it locked, and,
outside any runner, refuses entries on an account a live runner holds, that
name no valid account, or on a live broker whose `apiUrlEnv` variable is unset
or no URL (so a runner of another install can't be seen; the refusal names the
variable). It checks the default lock directory: an
`FTH_LOCK_DIR` override without `FTH_TEST_LOCKS=1` is ignored there. Exits,
protective stops, cancels and closes always go. The lock directory must be writable and support hard links (a local
disk). The runner also refuses to start when the server lacks an interface
tool, has trading disabled, or (live) doesn't allow the account.

## 6. What to watch

- `node scripts/autotrader.js --status` (exit 1 when the runner is silent or
  stopped): put it in cron or a monitor.
- `~/.futures-trading-harness/logs/`: `autotrader-<day>.log` (the runner),
  `alerts-<day>.jsonl` (errors, the kill switch), `gate-log.jsonl` (every
  refused order and why), `cycles-<day>.jsonl` and `cycles/<day>/` (each
  cycle's prompt, tool calls and result), `scans-<day>.jsonl` (why a setup did
  or didn't fire).
- The broker's own platform: positions, working orders and stops should match
  what the cycle logs say.
- To halt new entries at once, create `~/.futures-trading-harness/STOP` (with a
  reason inside). Manage cycles and end of day still run.

## 7. End the day

At `eodAt` (no later than 16:00 ET) the runner flattens every position, cancels
working orders and, unless `eodReview` is false, runs the end-of-day review.
Check the account is flat on the broker's platform. Stop the runner with
Ctrl-C, or leave it running for the next session; remove `STOP` only after
reading why it was created.

## 8. Score the session

The runner records each trading day as a replay is recorded, in
`~/.futures-trading-harness/sessions/<trading day>/`. Once end of day is done
and the fills are known:

```bash
node scripts/replay.js report    ~/.futures-trading-harness/sessions/<trading day>
node scripts/replay.js scorecard ~/.futures-trading-harness/sessions/<trading day>
```

The scorecard grades each decision against the priority order; score live and
replay sessions apart (the `live-session-records` skill).
