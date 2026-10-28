---
name: trade-journal
description: The journal the gate reads - its kinds (plan, entry, exit, note, review, lesson; the server adds order_placed), what the gate reads, filtering by kind or tag.
---

# Trade journal

## When to Use

- Writing a plan, entry, exit, note, review or lesson.
- Reading the journal (`journal_read`): plans, reviews, or an entry's
  `order_placed` record (lessons: `lessons`).

## How It Works

`journal_add` / `journal_read` keep the journal the gate reads, a JSON-lines
file at the broker's journal path in the broker config (`get_server_config`: `journalPath`):
one `{ ts, kind, contractId, tags, text }` per line (order entries also carry `data`). Kinds you write: `plan`, `entry`, `exit`, `review`, `lesson`, `note`. The
server writes its own: every `place_order` an `order_placed` entry, a
guardrail refusal an `order_blocked`, `close_position` and
`partial_close_position` an `exit`, and `modify_order` with a reason a `note`. Write through the tools only; never edit the file. The gate reads
plans (a plan for this contract within `FTH_PLAN_MAX_AGE_MIN`, 120) and
reviews (every entry reviewed before the next) from it. A rules strategy's
trigger it reads from the signal record, not the plan. Optional parameters the gate and reviews use: `journal_read {kind, tag}`
filters, `journal_add {orderId}` links a review to its order, and
`modify_order {reason}` labels a stop change (`[protect] ...`).
Don't filter `journal_read` by `contractId`: the server stores its own
`order_placed` entries under the broker's contract id, so a filter on `MNQ`
drops them. Filter by `kind` / `tag` and read `contractId` in the results.

## Examples

```text
journal_add {kind:"plan", contractId:"MNQ", tags:["setup:<name>", "MNQ"], text:"..."}
journal_read {kind:"order_placed"}   by kind, never by contractId
journal_add {kind:"review", contractId:"MNQ", orderId:812, tags:["setup:<name>", "result:nofill"], text:"..."}
```
