## Summary

<!-- What changes and why. -->

## Regression (required)

- [ ] `npm run verify` passes (test incl. e2e, lint, sync check, strategies, secrets)

<!-- Paste the counts, e.g. "npm test: 609 pass, 0 fail". -->

- [ ] Goal regression: main vs this PR (tier 1 in `npm run verify`; tier 2: `npm run goal:full`, its own CI job)
- [ ] Touches entries, exits, sizing, the gate or the runner: `npm run goal:real` (local, real data) main vs this PR

<!-- Paste `node scripts/goal-check.js run`'s table and tier 2's report; any baseline or move-golden change explained
     as an improvement, metric by metric. -->

## Adversarial review (required)

- [ ] Reviewed by someone other than the change's author (an independent agent or a person), against the base branch
- [ ] Every confirmed finding fixed or answered; the regression re-run; the fixes reviewed again until nothing new
- [ ] Golden files: every change under `tests/fixtures/golden/` (and `tests/scripts/cli-parity.snapshot.json`) is explained below, line by line, as intended (none changed: say so)
- [ ] Documents only (Markdown under `docs/`, README, CONTRIBUTING, nothing else; not a document agents are pointed to, see CLAUDE.md): the regression still ran, and the review was for soundness and the truth of its claims about the code

<!-- The findings and what was done about each. -->
