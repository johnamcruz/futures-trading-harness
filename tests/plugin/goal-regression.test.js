'use strict';

// The goal regression, tier 1 (scripts/lib/eval/goal-check.js; docs/TRAINING.md, "The goal regression"): the harness's
// own entry rule, setups, compose timing, locked stop and D13 floor, rulebook sizing and exit on the committed CI slice
// of real sessions (tests/fixtures/goal/bars.json.gz, each session labelled trend or non-trend, and why) and the
// synthetic blow path (goal-synth.js), per half, against the committed baseline (tests/fixtures/goal/baseline.json).
// A pull request that moves the strategy away from the goal fails, in the owner's order: one more combine blow (the
// blow path included), a lower combine pass rate, a lower mean R, a smaller share of the trends' R caught, each beyond
// its tighten-only tolerance (config/training.json goalRegression.tolerance). The table it prints on a failure:
// metric, main, this PR, allowed.
//
// The baseline only rises, as the promotion gate's numbers: against the base branch's baseline (git merge-base HEAD
// origin/main), every gated metric of the committed one is at least as good (tier 2's blows, trades, total R and fills
// too); a new fixture only with its change recorded. An unreadable base fails closed. Tier 2 (the live path with the
// mock model), its break self-tests, the broker-fault days and the move goldens run in their own job (npm run
// goal:full); this test holds their committed files to this fixture and its days to the config.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const GC = require('../../scripts/lib/eval/goal-check');
const GP = require('../../scripts/lib/eval/goal-path');

const REPO = path.resolve(__dirname, '..', '..');
const REL = 'tests/fixtures/goal/baseline.json';
const SET = GC.fixtureSet('ci');
const DOC = SET.doc;
const BASELINE = JSON.parse(fs.readFileSync(path.join(REPO, REL), 'utf8'));
const CFG = require('../../scripts/lib/tunables').training().goalRegression;

/** The base branch's baseline (git merge-base HEAD origin/main), or null when the base has none yet. */
function baseBaseline() {
  const git = args => spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  const mb = git(['merge-base', 'HEAD', 'origin/main']);
  if (mb.status !== 0) throw new Error('the base branch can\'t be read (git merge-base HEAD origin/main): fetch origin/main (CI: actions/checkout fetch-depth: 0)');
  const shown = git(['show', `${mb.stdout.trim()}:${REL}`]);
  if (shown.status === 0) return JSON.parse(shown.stdout);
  const guard = git(['ls-tree', '--name-only', mb.stdout.trim(), 'tests/plugin/goal-regression.test.js']);
  if (guard.stdout.trim()) throw new Error(`the base has the goal regression but not ${REL}: renamed or removed; the baseline can't be checked`);
  return null;
}

test('the CI slice: small, real sessions of the open window, both halves, every session labelled; trend days both ways, non-trend days with a fakeout', () => {
  const sched = require('../../scripts/lib/schedule').current();
  assert.ok(fs.statSync(GC.CI_FIXTURE).size < 1024 * 1024, 'under 1 MB');
  const halves = DOC.blocks.filter(b => b.half !== 'M');
  for (const b of DOC.blocks) for (const d of b.sessions) {
    assert.ok(d >= sched.data.sessionsFrom && d < sched.learning.windows['practice-train'][1], `${d}: in the open window`);
    assert.ok(b.labels && b.labels[d] && ['trend', 'non-trend'].includes(b.labels[d].kind) && b.labels[d].why, `${d}: labelled, with why`);
  }
  for (const h of ['A', 'B']) {
    const mine = halves.filter(b => b.half === h);
    assert.strictEqual(mine.length, CFG.blocksPerHalf, h);
    assert.ok(mine.every(b => b.sessions.length === CFG.blockSessions && b.sessions.every(d => (h === 'A' ? d < CFG.split : d >= CFG.split))), h);
    const kinds = mine.flatMap(b => b.sessions.map(d => b.labels[d]));
    assert.strictEqual(kinds.filter(k => k.kind === 'trend').length, CFG.trendPerHalf, `${h}: its trend days`);
    assert.ok(kinds.some(k => k.kind === 'trend' && / long /.test(k.why)) || kinds.some(k => k.kind === 'trend' && / short /.test(k.why)), `${h}: a trend day`);
    assert.ok(kinds.some(k => k.kind === 'non-trend' && /fakeout/.test(k.why)), `${h}: a fakeout`);
  }
  const all = DOC.blocks.flatMap(b => b.sessions.map(d => b.labels[d].why));
  assert.ok(all.some(w => /PPC trend leg.* long /.test(w)) && all.some(w => /PPC trend leg.* short /.test(w)), 'trend days both ways');
  assert.deepStrictEqual(DOC.blocks.filter(b => b.half === 'M').flatMap(b => b.sessions), CFG.moveDays);
  // Each block's bars reach back the 4h and 1h reads' history before its first session (the warm-up rule; the first
  // bar at or after that point, so a weekend and a holiday at its start may shorten the span: 72 h at most).
  const GF = require('../../scripts/lib/eval/goal-fixture');
  for (const b of DOC.blocks) {
    const bars = GF.decodeBars(b.bars);
    const first = bars.findIndex(x => require('../../scripts/lib/trading/clock').tradingDayKey(new Date(Date.parse(x.t))) === b.sessions[0]);
    assert.ok(first > 0 && Date.parse(bars[first].t) - Date.parse(bars[0].t) >= (DOC.historyHours - 72) * 3600000, `${b.sessions[0]}: ${DOC.historyHours} h of warm-up`);
  }
  // The synthetic days: the blow path (half S) and the move scenarios real days can't give cleanly.
  assert.deepStrictEqual(SET.synth.blocks.map(b => `${b.half} ${b.scenario}`), ['M fakeout', 'M quiet', 'S bleed']);
});

test('goal regression tier 1: no goal metric worse than main\'s baseline beyond its tolerance (blows incl. the blow path, pass rate, mean R, R caught)', () => {
  const t0 = Date.now();
  const now = GC.summary(GC.evaluate(DOC, { root: REPO, env: {}, synth: SET.synth }));
  assert.strictEqual(BASELINE.fixture, now.fixture, 'the baseline is of this fixture (a new one: node scripts/goal-check.js baseline --write --new-fixture --why "<why>")');
  const rows = GC.compare(BASELINE, now, CFG.tolerance);
  const bad = GC.regressions(rows);
  assert.deepStrictEqual(bad.map(r => `${r.half} ${r.label}`), [], `the strategy moved away from the goal (${((Date.now() - t0) / 1000).toFixed(1)} s):\n${GC.renderTable(rows)}`);
  assert.deepStrictEqual(Object.keys(now.halves).sort(), ['A', 'B', 'S']);
});

test('the baseline only rises against the base branch\'s (tier 1 and tier 2); an unreadable base fails closed', () => {
  const base = baseBaseline();
  if (!base) return; // no baseline on the base yet: the change that brings it
  assert.deepStrictEqual(GC.riseProblems(base, BASELINE), []);
  // Tier 2: the same rule; another fixture only with the change recorded (the check above holds it to the base's hash).
  if (base.tier2 && base.tier2.fixture === (BASELINE.tier2 || {}).fixture) assert.deepStrictEqual(GP.tier2RiseProblems(base.tier2.summary, BASELINE.tier2.summary), []);
  else if (base.tier2) assert.ok(BASELINE.fixtureChange && BASELINE.fixtureChange.from === base.fixture, 'tier 2 of another fixture: the fixture change recorded');
});

test('tier 2\'s committed baseline and the move goldens are of this fixture and the configured days', () => {
  assert.ok(BASELINE.tier2, 'a tier 2 baseline (node tests/goal/tier2-run.js --write)');
  assert.strictEqual(BASELINE.tier2.fixture, DOC.hash);
  assert.ok(BASELINE.tier2.summary && GP.TIER2.every(g => typeof BASELINE.tier2.summary[g.key] === 'number'), 'tier 2\'s summary: every gated metric');
  assert.deepStrictEqual(BASELINE.tier2.days, GP.pickDays(DOC.blocks, CFG.tier2));
  for (const t of BASELINE.tier2.trades) assert.deepStrictEqual(t.steps.filter(s => s !== 'trail'), GP.STEPS.filter(s => s !== 'trail'), `${t.key}: every step in order`);
  assert.ok(BASELINE.tier2.behaviour.every(b => b.kind), 'every tier 2 day labelled');
  const moves = JSON.parse(fs.readFileSync(SET.goldenFile, 'utf8'));
  assert.deepStrictEqual(moves.scenarios.map(x => x.day), [...CFG.moveDays, ...SET.synth.blocks.filter(b => b.half === 'M').flatMap(b => b.sessions)].sort());
});
