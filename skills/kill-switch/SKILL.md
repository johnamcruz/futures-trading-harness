---
name: kill-switch
description: Use when an entry is refused with [kill-switch], [allowed-accounts] or [account-lock].
---

# Kill switch and account lock

## When to Use

- An entry is refused with `[kill-switch]`, `[allowed-accounts]` or
  `[account-lock]`.
- A runner or preflight reports the account traded by another runner.

## How It Works

**Kill switch.** When `<FTH_HOME>/STOP` exists the runner starts only
manage cycles and the gate refuses every entry; you don't need to check
the file (you can't read it). If an entry is refused with `[kill-switch]`,
manage or flatten open positions only, and end. `[allowed-accounts]` is
the same for you: the account isn't on the broker's allow-list (the user's
setup, checked by their preflight, `scripts/preflight.js`). It refuses
entries only: manage, protect or flatten, and end the cycle `blocked`.

**One runner per broker account.** A second live runner on an account
another runner already trades (from any harness home of this user, under
any broker name for the same server), or a manual `--once` trade or
premarket run on it, is refused at start, before any cycle: `account <id> on broker "<name>" is
already traded by another runner (pid, host, harness home, started)`.
Preflight reports it as a failed `account lock` check. It is the user's to
resolve: stop that runner, or trade another account (one runner trades
several policies). Only a lock whose runner is gone may be removed; the
runner takes such a stale lock over itself. A runner whose lock another
runner it can identify now holds takes no broker action and exits (that
runner manages the account); one whose lock it can't confirm stops new
entries (the kill switch, with the reason) and keeps managing the account's
risk. An
entry refused with `[account-lock]` is the same for you: this cycle's
runner doesn't hold the account's lock, the order names another account
than the runner's, it is a manual end of day (which never takes it), or
another runner trades the account: manage, protect or
flatten your own position, and end the cycle `blocked`. Paper runs and confirmed replays never take the lock, so a
replay never blocks a live run.

## Examples

```text
place_order -> [kill-switch]: manage the open long's stop, then
CYCLE RESULT: blocked - [kill-switch] no new entries
```
