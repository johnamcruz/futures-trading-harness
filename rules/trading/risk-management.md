# Risk Management

- Decide the stop before the entry. No stop, no trade.
- Risk per trade = |entry − stop| ÷ tickSize × tickValue × size. Keep it at or
  below 25% of the remaining daily loss allowance (`remainingBeforeLimit` in
  `get_account_snapshot`), and at or below the plan's $ risk.
- Every open position has a protective stop working at the exchange: the
  entry's `stopLossBracket`, checked as soon as the fill shows (the order's
  one status check, or the next cycle's read). A separate `[protect]` stop
  only repairs protection on an existing position (resized, or stop
  cancelled or missing), placed at once; never a way to
  enter without a bracket. If the stop can't be placed, close the position. A working entry
  without a stop bracket (one the gate never checked, e.g. placed outside
  the harness) is cancelled, not waited on (the `order-mechanics` skill); one its
  record or prompt marks "bracket attached on fill" is bracketed: keep it.
- Never widen a stop, never average down, never add to a loser. You may
  tighten a stop or move it to breakeven.
- Use micro contracts (MNQ, MES, MYM, M2K, MGC, MCL) and size 1 until the
  journal shows positive expectancy over at least 30 closed trades of that
  setup.
- Exception: while a prop attempt runs a policy strategy (`signal: policy`),
  its verdict sets the size in the selected contract, sized from the
  attempt's budget; the 25% and size-1 rules above don't apply to it, and the
  order gate enforces the verdict instead. Never exceed the verdict.
- Minimum planned reward-to-risk: the strategy's (`risk.min_rr`), measured from the entry to the plan's target; `compose_check` computes and enforces it, never your estimate (never to the first level ahead: that is a read)
  (a trailing exit: `trailActivateR`; the 4h and 1h your way: `target trail`,
  no level needed).
- After 2 losses in a row: stop, write a review and a lesson, then wait out the
  cooldown. After 3 losing trades in a trading day: done until 17:00 CT.
- Pass when the count says so. Standing aside is a position.
