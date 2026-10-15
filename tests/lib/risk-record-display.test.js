'use strict';

// The model's risk record in experience_lookup (learning/risk-record-index.js; replay/config.js riskRecordDisplay; the
// look's +risk arm dimension; run-pins): hidden by default, shown with the flag, walk-forward, practice-train only,
// dropped first under the cap.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../../scripts/lib/learning/risk-record-index');
const H = require('../../scripts/lib/harness-tools/experience');
const X = require('../../scripts/lib/learning/experience-index');
const K = require('../../scripts/lib/learning/looks');
const L = require('../../scripts/lib/learning/experience-lookups');
const { pinForRun } = require('../../scripts/lib/learning/run-pins');
const { fromLifecycleRecord } = require('../../scripts/lib/learning/lifecycle-record');
const { record, tmpHome } = require('../fixtures/learning');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fth-risk-record-'));
const AT = '2023-03-15T14:00:00.000Z';
const NOW = () => new Date('2023-03-15T14:01:00.000Z');

/** A scoreRiskActions-shaped result: `rows` is { 'kind|state': [applied, saved, caused, costPasses, gained] }. */
function result(rows, look = {}) {
  const actions = {};
  for (const kind of ['pass', 'day-stop', 'size-down', 'early-exit']) {
    actions[kind] = { n: 0, byState: {} };
    for (const state of ['fresh', 'mid', 'near-target', 'near-mll', 'all']) {
      const [applied = 0, s = 0, c = 0, cp = 0, g = 0] = rows[`${kind}|${state}`] || [];
      actions[kind].byState[state] = { applied, savedBlows: s, causedBlows: c, costPasses: cp, gainedPasses: g };
    }
  }
  return { counterfactual: true, actions, look };
}
const entry = (day, rows) => R.riskDayEntry(day, result(rows));

/** Two days before the bar's day with 12 paths of standing down near the max loss (saved 4, cost 1), 4 of sizing; the bar's day and the day after flood it. */
function index() {
  return R.buildRiskIndex([
    entry('2023-03-01', { 'pass|near-mll': [6, 2, 0, 1, 0], 'size-down|mid': [2, 0, 1, 0, 0] }),
    entry('2023-03-02', { 'pass|near-mll': [6, 2, 0, 0, 1], 'size-down|mid': [2, 0, 0, 0, 0] }),
    entry('2023-03-15', { 'pass|near-mll': [500, 90, 0, 0, 0] }),
    entry('2023-03-16', { 'pass|near-mll': [500, 90, 0, 0, 0] }),
  ], { now: new Date('2023-04-01T00:00:00Z') });
}

/** A home with one verified candidate, an experience index of past decisions, and (risk) a pinned risk record. */
function home({ risk = null, display = true } = {}) {
  const h = tmpHome();
  fs.mkdirSync(path.join(h, 'trade-lifecycle'));
  fs.writeFileSync(path.join(h, 'trade-lifecycle', 'MNQ.jsonl'), `${JSON.stringify(record({ at: AT }))}\n`);
  const r = fromLifecycleRecord(record({ at: AT }));
  const days = Array.from({ length: 12 }, (_, i) => `2022-03-${String(i + 1).padStart(2, '0')}`);
  const past = Array.from({ length: 24 }, (_, i) => ({ id: `p${i}`, day: days[i % 12], decision: i % 2 ? 'entered' : 'passed', side: 'long', signatures: r.signatures, reads: r.reads, context: r.context, outcome: { R: i % 2 ? 2 : -1 }, grade: i % 2 ? 'win' : 'good-pass' }));
  X.pinIndex(h, X.writeIndex(path.join(h, 'built'), X.buildIndex(past, { reps: 200 })));
  if (risk) R.pinRiskRecord(h, R.writeRiskIndex(path.join(h, 'rbuilt'), risk), { display });
  const env = { FTH_HOME: h, FTH_CYCLE_TRANSCRIPT: path.join(h, 'cycle.jsonl') };
  return { h, env, ctx: { env, now: NOW, wallNow: () => 1000 } };
}
const lookup = o => H.experienceLookup({ symbol: 'MNQ' }, home(o).ctx).text;

test('hidden by default: not pinned, or pinned alone, the lookup has no risk section', () => {
  assert.doesNotMatch(lookup({}), /risk record/i);
  assert.doesNotMatch(lookup({ risk: index(), display: false }), /risk record/i);
});

test('shown with the flag: each line with its sample size or "too few"; walk-forward by day; counts only', () => {
  const text = lookup({ risk: index() });
  assert.match(text, /^Your risk record \(counterfactual, practice-train days before 2023-03-15 only/m);
  // 12 paths from the two days before the bar's day; the bar's day and the later day are never counted.
  assert.match(text, /^- near the max loss, standing down: n 12, saved 4 blows, caused 0, cost 1 pass, gained 1$/m);
  assert.doesNotMatch(text, /n 512|n 1012|saved 94|saved 184/);
  // 4 paths of sizing is under the minimum: no count of outcomes.
  assert.match(text, /^- mid-attempt, sizing under the ceiling: too few$/m);
  assert.match(text, /^- fresh \(first session\), standing down: too few$/m);
  assert.match(text, /^- near the target, exiting early: too few$/m);
  assert.match(text, /^- after losses, stopping for the day: too few$/m);
  assert.ok(Buffer.byteLength(text) <= H.MAX_BYTES);
  assert.doesNotMatch(text, /\b(should|avoid|must|better to|recommend)\b/i, 'counts and outcomes, no advice');
});

test('walk-forward: the same bar one day later sees the day before it', () => {
  const idx = index();
  assert.strictEqual(R.riskCellAt(idx, 'pass', 'near-mll', '2023-03-02').n, 6);
  assert.strictEqual(R.riskCellAt(idx, 'pass', 'near-mll', '2023-03-02').enough, false);
  assert.strictEqual(R.riskCellAt(idx, 'pass', 'near-mll', '2023-03-03').n, 12);
  assert.strictEqual(R.riskCellAt(idx, 'pass', 'near-mll', '2023-03-15').n, 12, 'the day itself is not before it');
  assert.strictEqual(R.riskCellAt(idx, 'pass', 'near-mll', '2023-03-16').n, 512);
});

test('the cap drops the risk record first, whole lines from its end, before the model\'s cells', () => {
  const risk = R.riskRecordLines(index(), '2023-03-15');
  const out = H.capped(['head'], ['- a cell', 'x'.repeat(H.MAX_BYTES - 700)], ['Similar:', '- s'], ['tail'], [], risk.slice());
  assert.ok(Buffer.byteLength(out) <= H.MAX_BYTES);
  assert.match(out, /- a cell/);
  assert.match(out, /Similar:/, 'similar decisions outlast the risk record');
  assert.match(out, /Your risk record/, 'some of it still fits');
  assert.doesNotMatch(out, /after losses, stopping/, 'its last lines go first');
  const tight = H.capped(['head'], ['- a cell', 'y'.repeat(H.MAX_BYTES - 150)], ['Similar:', '- s'], ['tail'], [], risk.slice());
  assert.doesNotMatch(tight, /Your risk record/);
  assert.match(tight, /- a cell/);
  assert.match(tight, /tail/);
  // Without the record the output is what it was.
  assert.strictEqual(H.capped(['head'], ['- a cell'], ['Similar:', '- s'], ['tail'], []), H.capped(['head'], ['- a cell'], ['Similar:', '- s'], ['tail']));
});

test('the lookup records the risk record hash it showed; an unreadable record is said in the tail', () => {
  const idx = index();
  const t = home({ risk: idx });
  H.experienceLookup({ symbol: 'MNQ' }, t.ctx);
  assert.strictEqual(L.readExperienceLookups(t.env.FTH_CYCLE_TRANSCRIPT)[0].risk, idx.hash);
  const u = home({ risk: idx });
  const file = fs.readdirSync(path.join(u.h, 'experience')).find(f => /^risk-record-[0-9a-f]{16}\.json$/.test(f));
  fs.writeFileSync(path.join(u.h, 'experience', file), '{}');
  const text = H.experienceLookup({ symbol: 'MNQ' }, u.ctx).text;
  assert.match(text, /Your risk record: unreadable \(.*not a risk record index\); no risk record this lookup\./);
});

test('practice-train only: a day of another split, or a held-out role, is refused at the build and the read', () => {
  for (const day of ['2024-09-02', '2025-03-03', '2026-06-02']) assert.throws(() => entry(day, { 'pass|mid': [5] }), /practice-train/, day);
  for (const role of ['practice-validate', 'test', 'final']) {
    assert.throws(() => R.riskDayEntry('2023-03-01', result({ 'pass|mid': [5] }), { role }), /judged, never shown to the model/);
    assert.throws(() => R.riskDayEntry('2023-03-01', result({ 'pass|mid': [5] }, { role })), /judged, never shown to the model/);
    assert.throws(() => R.buildRiskIndex([{ day: '2023-03-01', role, cells: {} }]), /practice-train only/);
  }
  const dir = tmp();
  const file = R.writeRiskIndex(dir, index());
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.entries[0].day = '2025-03-03';
  fs.writeFileSync(file, JSON.stringify(doc));
  assert.throws(() => R.readRiskIndex(file), /changed after it was built/);
  // A forged hash still can't carry a later day.
  const { hash: _h, builtAt: _b, ...rest } = doc;
  const forged = { ...doc, hash: require('crypto').createHash('sha256').update(JSON.stringify(rest)).digest('hex') };
  fs.writeFileSync(file, JSON.stringify(forged));
  assert.throws(() => R.pinRiskRecord(tmp(), file), /practice-train/);
});

test('the same day twice, a cell that is not whole counts, minN under 1: refused', () => {
  assert.throws(() => R.buildRiskIndex([entry('2023-03-01', {}), entry('2023-03-01', {})]), /twice/);
  assert.throws(() => R.buildRiskIndex([{ day: '2023-03-01', role: 'practice-train', cells: { 'pass|mid': { n: -1, savedBlows: 0, causedBlows: 0, costPasses: 0, gainedPasses: 0 } } }]), /whole counts/);
  assert.throws(() => R.buildRiskIndex([], { minN: 0 }), /minN/);
});

const ROOT = path.join(__dirname, '..', '..');
function configs() {
  const { resolveReplay } = require('../../scripts/lib/replay/config');
  const user = tmp();
  const env = { PATH: process.env.PATH, HOME: user, FTH_HOME: path.join(user, 'live') };
  const raw = o => ({ runId: 'a', workDir: path.join(user, 'replays'), broker: 'replaymock', start: '2025-03-03T14:30:00Z', end: '2025-03-03T15:00:00Z', premarket: false, autotrader: { harness: 'custom', command: ['true', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3 }, ...o });
  const file = R.writeRiskIndex(path.join(user, 'r'), index());
  return { run: o => resolveReplay(raw(o), { baseDir: user, env, root: ROOT }), file, user };
}

test('config: off by default, needs a record to show, and enters the setup hash only when on; its arm', () => {
  const C = require('../../scripts/lib/replay/config');
  const { run, file, user } = configs();
  assert.strictEqual(run({}).riskRecordDisplay, false);
  assert.strictEqual(run({ riskRecord: file }).riskRecordDisplay, false);
  assert.strictEqual(run({ riskRecord: file, riskRecordDisplay: true }).riskRecordDisplay, true);
  assert.throws(() => run({ riskRecordDisplay: 'yes', riskRecord: file }), /riskRecordDisplay: true or false/);
  assert.throws(() => run({ riskRecordDisplay: true }), /riskRecordDisplay: shows the pinned risk record; name it \(riskRecord\)/);
  assert.throws(() => run({ riskRecord: '' }), /riskRecord: a risk record index file/);
  // Existing hashes unchanged: naming the record without showing it is the setup it was.
  const plain = C.setupHash(run({}));
  assert.strictEqual(C.setupHash(run({ riskRecord: file })), plain);
  assert.strictEqual(C.setupHash(run({ riskRecord: file, riskRecordDisplay: false })), plain);
  const on = run({ riskRecord: file, riskRecordDisplay: true });
  assert.notStrictEqual(C.setupHash(on), plain);
  assert.strictEqual(C.setupBase(on), plain, 'the pair shares its base');
  // Another record shown: another setup.
  const other = R.writeRiskIndex(path.join(user, 'o'), R.buildRiskIndex([entry('2023-03-01', { 'pass|mid': [3] })]));
  assert.notStrictEqual(C.setupHash(run({ riskRecord: other, riskRecordDisplay: true })), C.setupHash(on));
  // The arm.
  const h16 = R.readRiskIndex(file).hash.slice(0, 16);
  assert.strictEqual(C.lookArm(run({})), 'without');
  assert.strictEqual(C.lookArm(run({ riskRecord: file })), 'without', 'pinned alone: no arm');
  assert.strictEqual(C.lookArm(on), `without+risk:${h16}`);
  assert.ok(K.ARM.test(C.lookArm(on)) && K.ARM.test(`with:${'a'.repeat(16)}+library:${'b'.repeat(16)}+risk:${'c'.repeat(16)}`));
  assert.ok(!K.ARM.test(`without+risk:${'c'.repeat(16)}+library:${'b'.repeat(16)}`));
});

test('looks: a with/without risk record comparison is an arm dimension; two dimensions at once, or a wrong base, are refused', () => {
  const C = require('../../scripts/lib/replay/config');
  const { run, file } = configs();
  const off = run({});
  const on = run({ riskRecord: file, riskRecordDisplay: true });
  const look = (runId, r, over = {}) => ({ evaluation: 'evR', candidate: 'champ', purpose: 'judging', runId, from: '2025-03-03', to: '2025-03-04', arm: C.lookArm(r), config: C.setupHash(r), base: C.setupBase(r), ...over });
  const ledgerFile = path.join(tmp(), 'looks.jsonl');
  K.recordLook(ledgerFile, look('r-off', off), { create: true });
  const shown = K.recordLook(ledgerFile, look('r-on', on));
  assert.deepStrictEqual([shown.ok, shown.appended, shown.shared], [true, true, true], 'one evaluation, one look');
  const lines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.match(lines[1].arm, /^without\+risk:[0-9a-f]{16}$/);
  assert.strictEqual(lines[1].base, C.setupBase(on));
  assert.strictEqual('base' in lines[0], false);
  const refused = (l, ledger, why) => { const r = K.checkLook(l, ledger); assert.strictEqual(r.ok, false, JSON.stringify(l)); assert.match(r.refusals.join('; '), why); };
  const riskHash = lines[1].arm.slice(-16);
  refused(look('r-x', on, { base: null }), lines, /names its setup without the display \(base\)/);
  refused(look('r-x', off, { base: 'f'.repeat(64) }), lines, /base is its config/);
  // The index and the display both changed: not a pair.
  refused(look('r-idx', on, { arm: `with:${'a'.repeat(16)}+risk:${riskHash}` }), [lines[0]], /differ only in/);
  // A library display and a risk display at once, against the plain arm: two dimensions.
  refused(look('r-both', on, { arm: `without+library:${'a'.repeat(16)}+risk:${riskHash}`, config: '9'.repeat(64) }), [lines[0]], /differ only in/);
  // A resume is the look it took.
  refused(look('r-off', on), lines, /as another arm/);
});

test('run pins: the record is pinned with its display; a resume can\'t add, drop, or flip it', () => {
  const dir = tmp();
  const file = R.writeRiskIndex(path.join(dir, 'b'), index());
  const h16 = R.readRiskIndex(file).hash.slice(0, 16);
  const run = (home, o = {}) => ({ paths: { runHome: home }, experienceIndex: null, setupLibrary: null, libraryDisplay: false, riskRecord: null, riskRecordDisplay: false, ...o });
  const arm = r => `without${r.riskRecord && r.riskRecordDisplay ? `+risk:${h16}` : ''}`;
  const pin = (r, o) => pinForRun(r, { arm: arm(r), ...o });
  const shownHome = tmp();
  assert.deepStrictEqual(pin(run(shownHome, { riskRecord: file, riskRecordDisplay: true }), { fresh: true }), [`risk record pinned: ${h16}, shown to the model`]);
  assert.strictEqual(R.riskShown(shownHome), true);
  assert.strictEqual(pin(run(shownHome, { riskRecord: file, riskRecordDisplay: true }), { fresh: false }).length, 1, 'a resume with the same');
  // The flag flipped off on a resume.
  assert.throws(() => pinForRun(run(shownHome, { riskRecord: file }), { fresh: false, arm: 'without' }), /pinned its risk record with the display on/);
  // Dropped.
  assert.throws(() => pin(run(shownHome), { fresh: false }), /pinned a risk record at its start/);
  // Pinned hidden, flipped on.
  const hiddenHome = tmp();
  assert.match(pin(run(hiddenHome, { riskRecord: file }), { fresh: true })[0], /not shown to the model \(riskRecordDisplay off\)$/);
  assert.strictEqual(R.riskShown(hiddenHome), false);
  assert.throws(() => pinForRun(run(hiddenHome, { riskRecord: file, riskRecordDisplay: true }), { fresh: false, arm: `without+risk:${h16}` }), /pinned its risk record with the display off/);
  // Added by a resume.
  const none = tmp();
  pin(run(none), { fresh: true });
  assert.throws(() => pin(run(none, { riskRecord: file, riskRecordDisplay: true }), { fresh: false }), /started without a risk record; a resume can't pin one/);
  // The arm names another record than the one pinned, or a record the run doesn't show.
  assert.throws(() => pinForRun(run(tmp(), { riskRecord: file, riskRecordDisplay: true }), { fresh: true, arm: `without+risk:${'0'.repeat(16)}` }), /the risk record pinned .* is not the one its look names/);
  assert.throws(() => pinForRun(run(tmp(), { riskRecord: file }), { fresh: true, arm: `without+risk:${h16}` }), /does not show one/);
});
