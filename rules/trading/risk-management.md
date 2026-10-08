# Risk Management

- Decide the stop before the entry. No stop, no trade.
- Risk per trade = |entry − stop| ÷ tickSize × tickValue × size. Keep it at or
  below 25% of the remaining daily loss allowance (`remainingBeforeLimit` in
  `get_account_snapshot`), and at or below the plan's stated $ risk.
- Every open position has a protective stop working at the exchange: a
  `stopLossBracket`, or a separate `[protect]` stop order placed as soon as the
  fill shows in `list_open_positions`. If the stop can't be placed, close the
  position.
- Never widen a stop, never average down, never add to a loser. You may
  tighten a stop or move it to breakeven.
- Use micro contracts (MNQ, MES, MYM, M2K, MGC, MCL) and size 1 until the
  journal shows positive expectancy over at least 30 closed trades of that
  setup.
- Minimum planned reward-to-risk is 1.5R unless the strategy says otherwise.
- After 2 losses in a row: stop, write a review and a lesson, then wait out the
  cooldown. After 3 losing trades in a trading day: done until 17:00 CT.
- Skip the trade when unsure. Standing aside is a position.
