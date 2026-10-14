---
name: micro-mini-specs
description: Use when sanity-checking a contract's tick size and value, a micro against its mini.
---

# Micro and Mini Specs

## When to Use

- Checking the broker's `tickSize` and `tickValue` for a contract, or a micro against its mini.

## How It Works

The broker's specs are the ones used (the `position-sizing` skill, step 1).
The table is for sanity checks only:

   | Micro | Mini | Tick size | Micro $/tick | Mini $/tick |
   |---|---|---|---|---|
   | MNQ | NQ | 0.25 | 0.50 | 5.00 |
   | MES | ES | 0.25 | 1.25 | 12.50 |
   | MYM | YM | 1.0 | 0.50 | 5.00 |
   | M2K | RTY | 0.10 | 0.50 | 5.00 |
   | MGC | GC | 0.10 | 1.00 | 10.00 |
   | MCL | CL | 0.01 | 1.00 | 10.00 |

   Contract ids can name a root by another symbol than the exchange's
   (the harness names contracts by their root: `NQ`, `MNQ`; another month is `NQ:2026-03`). Confirm with `search_contracts`.

## Examples

```text
MNQ stop 20 ticks: 20 x $0.50 = $10.00 a micro; NQ: 20 x $5.00 = $100.00 a mini.
MES stop 20 ticks: 20 x $1.25 = $25.00 a micro; ES: 20 x $12.50 = $250.00 a mini.
```
