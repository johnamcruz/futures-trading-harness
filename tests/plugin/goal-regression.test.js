'use strict';

// The goal regression, tier 1 (scripts/lib/eval/goal-check.js; docs/TRAINING.md, "The goal regression"): the harness's
// own entry rule, setups, compose timing, locked stop and D13 floor, rulebook sizing and exit on the committed CI slice
// of real sessions (tests/fixtures/goal/bars.json.gz, each session labelled trend or non-trend, and why) and the
// synthetic blow path (goal-synth.js), per half, against the committed baseline (tests/fixtures/goal/baseline.json).
// A pull request that moves the strategy away from the goal fails, in the owner's order: one more combine blow (the
// blow path included), a lower combine pass rate, a lower mean R, a smaller share of the trends' R caught, each beyond
// its tighten-only tolerance (config/training.json goalRegression.tolerance), or one trend leg fewer caught (no
// tolerance). The table it prints on a failure:
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
  assert.deepStrictEqual(SET.synth.blocks.map(b => `${b.half} ${b.scenario}`), ['M fakeout', 'M quiet', 'M listed-vwap', 'M limit-fill', 'S bleed', 'M floor-ticks', 'M floor-atr']);
});

test('goal regression tier 1: no goal metric worse than main\'s baseline beyond its tolerance (blows incl. the blow path, pass rate, mean R, R caught, trend legs caught)', () => {
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
  // The blow path's evaluated trades, for a pinned blow-path allowance (its dropped trade must be gone from them).
  const S = GC.evaluate(DOC, { root: REPO, env: {}, synth: SET.synth }).halves.S;
  assert.deepStrictEqual(GC.riseProblems(base, BASELINE, { blowPathList: S ? S.list : null }), []);
  // Tier 2: the same rule; another fixture only with the change recorded (the check above holds it to the base's hash).
  if (base.tier2 && base.tier2.fixture === (BASELINE.tier2 || {}).fixture) assert.deepStrictEqual(GP.tier2RiseProblems(base.tier2.summary, BASELINE.tier2.summary, { baseTrades: base.tier2.trades, nextTrades: BASELINE.tier2.trades }), []);
  else if (base.tier2) assert.ok(BASELINE.fixtureChange && BASELINE.fixtureChange.from === base.fixture, 'tier 2 of another fixture: the fixture change recorded');
});

// The owner-approved resets, pinned to exactly the one-time reset of 2026-10-30 (main's pre-reset tier 1 baseline under
// the old tool). A new entry is a new owner approval: it changes this pin too, and the review reads both.
test('the approved baseline resets are exactly the one-time owner-approved reset of 2026-10-30', () => {
  assert.deepStrictEqual(GC.APPROVED_RESETS.map(r => ({ ...r })), [{
    from: 'c63da23391f4e0225e642c6ea2e320cb557961f9da1891d9ba6c59399f0c6f02',
    to: '44a498c2cc6dd7803e4fc229b8972cefa8fbe296b83c78abc9a40b941a78fb96',
    why: 'one-time reset, owner-approved 2026-10-30: the old tool applied one position at a time before sizing and counted trades no account could size; the corrected tool takes one position at a time after sizing, at each attempt\'s own state, as live',
    approved: '2026-10-30',
  }]);
  assert.ok(Object.isFrozen(GC.APPROVED_RESETS) && GC.APPROVED_RESETS.every(Object.isFrozen));
  if (BASELINE.reset) assert.ok(GC.APPROVED_RESETS.some(r => r.from === GC.fromHash(BASELINE.reset.from) && r.to === GC.fromHash(GC.gatedOf(BASELINE)) && r.why === BASELINE.reset.why), 'the committed baseline\'s reset is a pinned one');
});

// The owner-approved blow-path allowances, pinned to exactly the one of 2026-10-31 (the gap 100 -> 105 ticks: one trade
// fewer, main's 2024-03-14 13:48 short not taken), its fixture hashes and its dropped trade. A new entry is a new owner approval: it changes this pin too.
test('the blow-path allowances are exactly the one-time owner-approved one of 2026-10-31', () => {
  assert.deepStrictEqual(GC.BLOW_PATH_ALLOWANCES.map(a => ({ ...a, fixture: { ...a.fixture } })), [{
    what: 'blow-path trades',
    from: '11',
    to: '10',
    fixture: { from: '7f08aa86683f62d45d1f82f73cc9c31589258947d430a9e45e5248673d95c30c', to: '4dca0c5172278224fbf8f226185f68d9db0a4f7b7e1d0e4282801198830dd6f4' },
    dropped: '2024-03-14|short|2024-03-14T13:48:00.000Z',
    why: 'owner-approved 2026-10-31: the blow path\'s gap 100 -> 105 ticks makes it harsher (mean R -1.583 -> -1.663); one trade fewer: main\'s 2024-03-14 13:48 short (-1.0303R) is not taken',
    approved: '2026-10-31',
  }]);
  assert.ok(Object.isFrozen(GC.BLOW_PATH_ALLOWANCES) && GC.BLOW_PATH_ALLOWANCES.every(a => Object.isFrozen(a) && Object.isFrozen(a.fixture)));
});

// The owner-approved tier 2 allowances, pinned to exactly the one of 2026-10-31 (PR3's setup-is-the-entry on 2023-09-25:
// one -1R stop for another). A new entry is a new owner approval: it changes this pin too.
test('the tier 2 allowances are exactly the one-time owner-approved one of 2026-10-31', () => {
  assert.deepStrictEqual(GP.TIER2_ALLOWANCES.map(a => ({ ...a, trade: { ...a.trade } })), [{
    what: 'tier 2 total R',
    day: '2023-09-25',
    from: '-2.4134',
    to: '-2.4151',
    trade: { from: '2023-09-25|short|2023-09-25T13:51:00.000Z size 8 R -1.0139', to: '2023-09-25|short|2023-09-25T13:33:00.000Z size 9 R -1.0156' },
    why: 'owner-approved 2026-10-31: PR3\'s setup-is-the-entry enters earlier on 2023-09-25 (the 13:33 1h cisd down short, 9 contracts, -1.0156R, for main\'s 13:51 short, 8 contracts, -1.0139R); one -1R stop swaps for another; tier 1 rises: A pass 0.607 -> 0.7795, mean R -0.337 -> -0.0173, R caught 0.1309 -> 0.2144, legs 3 -> 5',
    approved: '2026-10-31',
  }]);
  assert.ok(Object.isFrozen(GP.TIER2_ALLOWANCES) && GP.TIER2_ALLOWANCES.every(a => Object.isFrozen(a) && Object.isFrozen(a.trade)));
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
