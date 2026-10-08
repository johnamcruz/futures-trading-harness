# Execution

- **Hard rule: trade only during market hours, 09:30-16:00 ET, Monday to
  Friday, and never hold a position outside them.** Every position is flat
  by end of day (`eodAt`, no later than 16:00 ET). The order gate refuses
  entries outside market hours whatever the configuration says, and the
  runner closes any position it finds outside them. Exits are always
  allowed.
- Re-read state with `get_account_snapshot` before every order. Never assume
  the position, price, or working orders.
- Prices are multiples of `tickSize` (MNQ/MES 0.25). Round before sending.
- `trailPrice` is an absolute price level, not a distance.
- `stopLossBracket` / `takeProfitBracket` are in ticks and work only on
  accounts with Auto OCO Brackets. If the account rejects brackets, enter
  without them and immediately place a separate `[protect]` stop.
- `close_position` does not cancel resting stops and targets. After any exit,
  check `list_open_orders` and cancel leftovers.
- Rationale convention (the order gate reads it):
  - New entry: `setup:<name> ... stop <price> ...` (and a plan in the journal).
  - Exit or scale-out: start with `[exit]`.
  - Protective stop/target for an existing fill: start with `[protect]`.
  Labelling an entry `[exit]`/`[protect]` to dodge the gate is a rule
  violation the reviewer will flag.
- One order per decision. If an order is blocked, read the reason and stand
  aside or fix the cause. Never split, resize, or reroute to get around a block.
