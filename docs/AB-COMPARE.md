# A/B comparison of two replay runs

A change to a skill or the rulebook is kept only if two replays of the same
moments, run with the same seed, show it measurably better. The training loop
already pairs its runs this way (`scripts/lib/train/paired.js`). This command
does the same for two replay runs an operator has finished:

```bash
node scripts/ab-compare.js <runA home> <runB home> [--metric r-decision,process] [--field cfg.model] [--account <name>] [--out report.json]
```

## What it refuses

Every replay run records its setup when it starts (`<run dir>/setup.json`). A
resume leaves the record as it was. The comparison refuses, and prints what
differs, unless both runs:

- have the same stage;
- use the same curated list (its fingerprint and list), or the same window
  when there is no list;
- use the same practice seed;
- trade the same market (symbols and timeframe);
- read the same data (a digest of the replay broker's entry and settings,
  never a credential);
- pin the same experience index, or both pin none;
- run the same code (`scripts/`);

and differ in exactly one of two ways:

- their documents (the harness digest, which includes the skills), or
- one config field, declared with `--field` (for example `cfg.model`,
  `gate.FTH_MIN_CONFLUENCE` or `practice.quietSample`).

Two arms that differ only in the history library's display don't need
`--field`. That is the pair `learning/looks.js` already allows: the same
`setupBase`, a different `setupHash`. The command also refuses identical
setups, unfinished runs, and runs that started before setups were recorded.

## Sealed windows

A run on practice-validate, test or final is read only through the look it
recorded. That means its `learning-run.json`, and its line in the learning
ledger naming the same setup. The comparison neither takes a look nor spends
one. If either run is on a reasoning-fix look, every outcome measure (R and
the Monte Carlo) is hidden for both runs.

## What it reports

Decisions are paired by (root, bar) through `pairUp`. Each measure is B minus
A, with a 90% paired bootstrap interval:

| Measure | Verdict |
|---|---|
| Realized R per decision (a pass counts as 0) | interval clear of 0, with at least `minPairs` pairs |
| R per trade, where both runs entered | the same |
| Correct-read rate, on the decisions both runs read | `judge()` (McNemar) |
| Process adherence (scorecard categories, from `scorecard.jsonl`) | `judge()`, each category shown |
| Entries taken against passed | descriptive |
| Per-skill used, correct and missed | descriptive, when `learning/skill-usage.js` is present |
| 30-day Monte Carlo pass rate, blow rate and median days (stage 2 only) | the paired Monte Carlo's verdict, when `prop/model-score.js` `pairRuns` is present |

A measure whose source is missing shows N/A. The last line says "B better"
when one measure is better and none is worse, "B worse" when any measure is
worse, and "no significant difference" otherwise. The exit code is always 0:
this is a report, not a gate.
