# Execution

- **Hard rule: trade only in the harness's hours inside the Topstep trading day (its 17:00 CT reset): the day opens at 18:00 ET
  and runs overnight until 16:00 ET the next day (Sunday evening to Friday
  afternoon). The market is open all of that time, the regular session
  09:30-16:00 ET included; it is closed only from 16:00 to 18:00 ET and on
  weekends (the harness stops at 16:00 ET, before Topstep's 16:10 ET flatten; CME's Globex trades on to 17:00 ET, background only). Never carry a position past the 16:00 ET close.** Every position is
  flat by end of day (`eodAt`, no later than 16:00 ET). The order gate
  refuses entries outside the session whatever the configuration says, and
  the runner closes any position it finds outside it. Exits are always
  allowed. A strategy's `sessions` narrows its own hours (`asia`,
  `london`, `ny`).
- Re-read state with `get_account_snapshot` before every order. Never assume
  the position, price, or working orders.
- Prices are multiples of `tickSize` (MNQ/MES 0.25). Round before sending.
- `trailPrice` is an absolute price level, not a distance.
- Every entry carries `stopLossBracket` (and `takeProfitBracket` when it has
  a target), in whole ticks from the fill. A broker that can't attach them
  refuses the entry: never enter without them; report the broker's message.
  A refusal is `success: false` with an `errorCode` other than 6
  (`OrderPending`) or 7 (`UnknownError`). Any other error reply (codes 6 and 7
  included) is an unknown outcome: read positions and orders, protect first,
  never re-send.
- `close_position` does not cancel resting stops and targets. After any exit,
  check `list_open_orders` and cancel leftovers.
- Rationale convention (the order gate reads it):
  - New entry: `setup:<name> ... stop <price> ...` (and a plan in the journal).
  - Exit or scale-out: start with `[exit]`.
  - Protective stop for a fill no working stop covers: start with `[protect]`.
    Otherwise adjust the entry's bracket with `modify_order`; a `[protect]`
    limit (a stand-alone target) is refused.
  Labelling an entry `[exit]`/`[protect]` to dodge the gate is a rule
  violation the reviewer will flag.
- One order per decision. If an order is blocked, read the reason and stand
  aside or fix the cause. Never split, resize, or reroute to get around a block.
