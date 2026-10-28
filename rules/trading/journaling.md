# Journaling

The broker MCP server's journal (`journal_add` / `journal_read`) is the only
trade memory. The hooks read it, so
formats matter.

- **plan** (before every entry): `contractId` set, text covers thesis, setup,
  trigger, invalidation/stop, target, size, $ risk, and skip conditions.
  Tags: `setup:<name>`, the symbol. A plan is valid for 120 minutes.
- **review** (after every entry closes, or a working entry is cancelled):
  planned vs. actual, result in R, followed-plan yes/no, mistakes. Tags must
  include exactly one of `result:win`, `result:loss`, `result:scratch`
  (|R| < 0.2), `result:nofill`, plus `setup:<name>` and any `mistake:<kind>`.
- **lesson** (session end, 1–3): advice: sample, bars condition, "ORB on MNQ
  before 09:45 ET: 2W/7L". Tag setup, symbol.
  Never a rule or a block (only the gate and rulebook block): shown with its
  record. Defying one is no mistake.
- Grade the process, not the P&L. A losing trade that followed the plan is a
  good trade; a winner that broke the plan is a mistake.
