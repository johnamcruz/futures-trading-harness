---
description: Build and journal a trade plan without executing it - parallel analysis, playbook check, sizing, and a risk-manager verdict. Use for paper trading or when trading is disabled.
argument-hint: "[SYMBOL=MNQ] [setup name, optional]"
---

# /trade-plan

Same as `/trade-session` steps 1–5 for `$ARGUMENTS`, then stop. No orders.

1. Launch `market-structure-analyst`, `trend-momentum-analyst`,
   `volume-liquidity-analyst`, and `risk-manager` (Phase 1) in parallel in one
   message. Add `news-calendar-analyst` if no premarket note exists today.
2. If a setup name was given, load that playbook and evaluate only it;
   otherwise choose at most one fired playbook.
3. Write the plan with `journal_add {kind:"plan", ...}` (tags `setup:<name>`,
   symbol, `paper` if trading is disabled), or a `note` explaining why there's
   no trade.
4. Get the `risk-manager` Phase 2 verdict and show the plan and verdict.

Paper plans still need reviews. After the hypothetical exit, journal a review
tagged `paper` so setup statistics can include them separately.
