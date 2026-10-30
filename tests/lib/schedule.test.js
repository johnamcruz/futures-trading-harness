'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('../../scripts/lib/schedule');
const C = require('../../scripts/lib/config-files');

const ROOT = path.resolve(__dirname, '..', '..');
const FILE = path.join(ROOT, 'config', 'schedule.json');
const RAW = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const clone = v => JSON.parse(JSON.stringify(v));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fth-schedule-'));

/** A schedule document written to a file and loaded (S.load), after `edit` changes a copy of the committed one. */
function variant(edit = () => {}) {
  const doc = clone(RAW);
  edit(doc);
  const f = path.join(tmp(), 'schedule.json');
  fs.writeFileSync(f, JSON.stringify(doc));
  return { doc, file: f, load: () => S.load(f) };
}

/** A schedule with no recorded looks, so nothing is sealed until a ledger entry is. */
const bare = (edit = () => {}) => variant(d => { d.learning.sealed.recordedLooks = []; d.prop.sealed.recordedLooks = []; edit(d); }).load();
const stamp = (s, e) => ({ ...e, schedule: s.fingerprint });

test('the committed schedule loads, and its first version is the one the code pins as LEGACY', () => {
  const s = S.current();
  assert.strictEqual(s, S.current(), 'loaded once per process');
  assert.deepStrictEqual(S.fingerprint(), s.fingerprint);
  // The sealed parts are locked by the recorded looks, taken under the first schedule: they never differ from LEGACY's.
  assert.deepStrictEqual(s.fingerprint.sealed, S.LEGACY.sealed);
  if (s.version === S.LEGACY.version) assert.strictEqual(s.fingerprint.hash, S.LEGACY.hash, 'v1 is the file LEGACY pins');
  assert.deepStrictEqual(S.sealedRefusals('learning', []), []);
  assert.deepStrictEqual(S.sealedRefusals('prop', []), []);
  // The data start date and the windows as the owner set them.
  assert.strictEqual(s.data.start, '2021-04-01');
  assert.deepStrictEqual(s.learning.lookBudgets, { test: 3, final: 1 });
  assert.strictEqual(s.learning.finalNeedsTestPass, true);
  assert.strictEqual(s.learning.validateRunsPerCandidate, 3);
});

test('the warm-up rule: no session before data.sessionsFrom (the store\'s first bar plus the 4h and 1h reads\' window); validated', () => {
  const s = S.current();
  assert.strictEqual(s.version, 'v2', 'data.sessionsFrom added: a new version');
  assert.strictEqual(s.data.sessionsFrom, '2021-05-24');
  assert.match(S.warmupRefusal('2021-05-03'), /2021-05-03 is before 2021-05-24 \(config\/schedule\.json data\.sessionsFrom: the replay store's first bar plus the 4h and 1h reads' 504-hour history window\): its 4h and 1h would read from short history; start on or after 2021-05-24/);
  assert.match(S.warmupRefusal('2021-05-21'), /2021-05-21 is before 2021-05-24/);
  assert.strictEqual(S.warmupRefusal('2021-05-24'), null);
  assert.strictEqual(S.warmupRefusal('2024-03-04'), null);
  // A time is its session's date: Sunday 18:00 ET opens the Monday session; a minute before is Sunday's.
  assert.strictEqual(S.warmupRefusal('2021-05-23T22:00:00Z'), null);
  assert.match(S.warmupRefusal('2021-05-23T21:59:00Z'), /2021-05-23 is before 2021-05-24/);
  for (const bad of ['', null, 'x', '2021-13-01']) assert.match(S.warmupRefusal(bad), /is not a session date/, String(bad));
  // Another schedule's date is its own.
  assert.strictEqual(S.warmupRefusal('2021-05-03', variant(d => { d.data.sessionsFrom = '2021-05-03'; }).load()), null);
  // Validated: missing, not a date, or before data.start is refused.
  assert.throws(() => variant(d => { delete d.data.sessionsFrom; }).load(), /data\.sessionsFrom: missing/);
  assert.throws(() => variant(d => { d.data.sessionsFrom = '2021-5-24'; }).load(), /data\.sessionsFrom: a date YYYY-MM-DD/);
  assert.throws(() => variant(d => { d.data.sessionsFrom = '2021-03-31'; }).load(), /data\.sessionsFrom: 2021-03-31 is before data\.start 2021-04-01/);
});

test('tighten only: the budgets never rise, the final look keeps needing a test pass, the reserve never shrinks', () => {
  // The loosest value each has ever had. Tightening one is allowed (tighten its pin here too); loosening it fails.
  const PINS = {
    'learning.sealed.lookBudgets.test': 3,
    'learning.sealed.lookBudgets.final': 1,
    'learning.sealed.finalNeedsTestPass': true,
    'learning.sealed.validateRunsPerCandidate': 3,
    'prop.sealed.lookBudget': 3,
    'prop.sealed.reserveMinMonths': 12,
  };
  assert.deepStrictEqual(C.loosened(S.SPEC, PINS, RAW), []);
  const loose = clone(RAW);
  loose.learning.sealed.lookBudgets.test = 4;
  loose.learning.sealed.finalNeedsTestPass = false;
  loose.prop.sealed.reserveMinMonths = 6;
  assert.strictEqual(C.loosened(S.SPEC, PINS, loose).length, 3);
});

test('resolve: a day and a use give the role and the look it requires; outside the schedule, none', () => {
  assert.deepStrictEqual(S.resolve('2022-03-07', 'learning'), { use: 'learning', day: '2022-03-07', role: 'practice-train', look: { purposes: [], budget: null, needsTestPass: false, validateCap: null } });
  assert.deepStrictEqual(S.resolve('2024-09-03', 'learning').look, { purposes: ['validate'], budget: null, needsTestPass: false, validateCap: 3 });
  assert.deepStrictEqual(S.resolve('2025-03-03', 'learning').look, { purposes: ['judging', 'reasoning-fix'], budget: 3, needsTestPass: false, validateCap: null });
  assert.deepStrictEqual(S.resolve('2026-03-03', 'learning').look, { purposes: ['judging', 'reasoning-fix'], budget: 1, needsTestPass: true, validateCap: null });
  assert.deepStrictEqual(S.resolve('2019-12-31', 'learning'), { use: 'learning', day: '2019-12-31', role: null, look: null });
  const oos = S.resolve('2024-08-05', 'prop');
  assert.strictEqual(oos.role, 'oos');
  assert.deepStrictEqual(oos.look, { purposes: ['judging'], budget: 'window', budgetLooks: 3 });
  assert.deepStrictEqual(S.resolve('2026-11-02', 'prop').look, { purposes: ['judging'], budget: 'walk-forward held-out', budgetLooks: 3 });
  assert.deepStrictEqual(S.resolve('2026-01-05', 'prop').look, { purposes: ['reasoning-fix'], budget: null, budgetLooks: null });
  assert.deepStrictEqual(S.resolve('2027-02-01', 'prop').look, { purposes: [], budget: null, budgetLooks: null }, 'reserve: refused');
  assert.strictEqual(S.resolve('2020-06-01', 'prop').role, null);
  // A bar's time is its session's day.
  assert.strictEqual(S.resolve(Date.parse('2024-12-31T23:30:00Z'), 'learning').role, 'test');
  assert.throws(() => S.resolve('2022-03-07', 'trading'), /no schedule use "trading"/);
});

test('fail closed: a schedule with a missing key, an unknown key, a bad date, an empty, overlapping or out-of-order window, or a stray recorded look is refused whole', () => {
  const refused = [
    [d => { delete d.version; }, /version: missing/],
    [d => { d.version = 'has space'; }, /version: a name/],
    [d => { d.extra = 1; }, /schedule.extra: not a schedule key/],
    [d => { d.data.start = '2021-02-30'; }, /data.start: a date/],
    [d => { d.learning.open['practice-train'] = ['2020-01-01']; }, /practice-train: \[from, to\]/],
    [d => { d.learning.open['practice-validate'] = ['2024-07-01', '2024-07-01']; }, /from 2024-07-01 is not before to 2024-07-01/],
    [d => { d.learning.open['practice-validate'][1] = '2025-02-01'; }, /test \[2025-01-01, 2026-01-01\) overlaps or comes before practice-validate/],
    [d => { d.learning.open['practice-train'] = ['2025-03-01', '2025-06-01']; }, /overlaps or comes before/],
    [d => { d.learning.sealed.lookBudgets.test = 0; }, /lookBudgets.test: a whole number/],
    [d => { d.learning.sealed.finalNeedsTestPass = 'yes'; }, /finalNeedsTestPass: true or false/],
    [d => { d.learning.sealed.validateRunsPerCandidate = 2.5; }, /validateRunsPerCandidate/],
    [d => { d.learning.sealed.recordedLooks[0].role = 'test'; }, /recordedLooks\[0\]: 2026-06-01..2026-06-06 is not inside test/],
    [d => { d.learning.sealed.recordedLooks[0].role = 'nowhere'; }, /not a window of the schedule/],
    [d => { d.prop.open.train = ['2021-01-15', '2023-07-01']; }, /prop.open.train: .* on the first of a month/],
    [d => { d.prop.open.select = ['2023-06-01', '2024-07-01']; }, /select .* overlaps or comes before train/],
    [d => { d.prop.sealed.blocks.recent = ['2025-07-01', '2026-04-01']; }, /it ends on the first of January or July/],
    [d => { d.prop.sealed.llmFrom = '2026-06-02'; }, /llmFrom/],
    [d => { d.prop.sealed.lookBudget = -1; }, /lookBudget/],
    [d => { d.prop.sealed.recordedLooks[2].to = '2025-08-01'; }, /recordedLooks\[2\]: .* not inside oos/],
    [d => { d.prop.sealed = []; }, /prop.sealed: an object/],
  ];
  for (const [edit, why] of refused) {
    const v = variant(edit);
    assert.throws(() => v.load(), e => /schedule config .* is refused/.test(e.message) && why.test(e.message), `${why}`);
  }
  // A gap is allowed (its days have no role), never an overlap.
  const gap = variant(d => { d.learning.open['practice-train'][1] = '2024-06-01'; }).load();
  assert.ok(gap.learning.windows['practice-train'][1] === '2024-06-01');
  // Unreadable or not JSON.
  assert.throws(() => S.load(path.join(tmp(), 'none.json')), /can't be read/);
  const bad = path.join(tmp(), 'schedule.json');
  fs.writeFileSync(bad, '{');
  assert.throws(() => S.load(bad), /not JSON/);
});

test('fail closed across the harness: with a refused schedule every role, look and run is refused; hasSession still works', () => {
  const broken = path.join(tmp(), 'schedule.json');
  fs.writeFileSync(broken, JSON.stringify({ ...RAW, learning: { ...RAW.learning, open: { 'practice-train': ['2020-01-01', '2025-02-01'], 'practice-validate': RAW.learning.open['practice-validate'] } } }));
  const script = `
    const out = {};
    const t = (k, f) => { try { out[k] = f(); } catch (e) { out[k] = 'threw: ' + e.message; } };
    t('learningRole', () => require('./scripts/lib/learning/splits').roleOf('2022-03-07'));
    t('propRole', () => require('./scripts/lib/prop/splits').roleOf('2022-03-07').role);
    t('resolve', () => require('./scripts/lib/schedule').resolve('2022-03-07', 'learning'));
    t('propLook', () => require('./scripts/lib/prop/looks').checkLook({ candidate: 'c', purpose: 'tuning', from: '2022-03-07', to: '2022-03-08' }, []));
    t('gate', () => require('./scripts/lib/learning/run-gate').checkLearningRun({ from: '2022-03-07', to: '2022-03-08', runId: 'r', learning: true }));
    t('notLearning', () => require('./scripts/lib/learning/run-gate').checkLearningRun({ from: '2028-03-07', to: '2028-03-08', runId: 'r', learning: false }));
    t('hasSession', () => require('./scripts/lib/prop/splits').hasSession('2022-03-07'));
    process.stdout.write(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--require', path.join(ROOT, 'tests', 'fixtures', 'schedule', 'use-file.js'), '-e', script], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, FTH_TEST_SCHEDULE_SOURCE: broken } });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  for (const k of ['learningRole', 'propRole', 'resolve', 'gate', 'notLearning']) assert.match(String(out[k]), /^threw: .*the schedule config .* is refused: learning: practice-validate .* overlaps/, k);
  assert.strictEqual(out.propLook.ok, false, 'the prop look is refused');
  assert.match(out.propLook.refusals.join(), /the schedule config .* is refused/);
  assert.strictEqual(out.hasSession, true, 'the exchange calendar needs no schedule');
});

test('the sealed rule: once a sealed look is in a ledger, its sealed windows never change; open windows and data dates may', () => {
  const A = bare(d => { d.version = 'a'; });
  // No look yet: the sealed windows may still change (a new version).
  const Bsealed = bare(d => { d.version = 'b'; d.learning.sealed.windows.final[1] = '2026-12-01'; });
  assert.deepStrictEqual(S.sealedRefusals('learning', [], Bsealed), []);
  // Practice looks (validate) don't seal.
  const validate = stamp(A, { kind: 'look', role: 'practice-validate', evaluation: 'e', runId: 'r', purpose: 'validate', from: '2024-07-01', to: '2024-07-10' });
  assert.deepStrictEqual(S.sealedRefusals('learning', [validate], Bsealed), []);
  // A test look under A: B, whose final window differs, is refused; so is a budget change; whatever B's version.
  const testLook = stamp(A, { kind: 'look', role: 'test', evaluation: 'e2', runId: 'r2', purpose: 'judging', from: '2025-03-03', to: '2025-03-08' });
  assert.match(S.sealedRefusals('learning', [validate, testLook], Bsealed).join(), /sealed learning windows .* differ from those of schedule a, under which 1 sealed learning look\(s\) were taken \(the first: 2025-03-03..2025-03-08, test\)/);
  const budget = bare(d => { d.version = 'b'; d.learning.sealed.lookBudgets.test = 2; });
  assert.strictEqual(S.sealedRefusals('learning', [testLook], budget).length, 1, 'a budget is sealed too');
  assert.throws(() => S.assertSealed('learning', [testLook], budget), /the schedule is refused: the schedule's sealed learning windows/);
  // A result line at test (no kind look) counts as sealed as well; an entry with no role, too (fail closed).
  assert.strictEqual(S.sealedRefusals('learning', [stamp(A, { kind: 'result', role: 'test', evaluation: 'e2' })], Bsealed).length, 1);
  assert.strictEqual(S.sealedRefusals('learning', [stamp(A, { kind: 'look' })], Bsealed).length, 1);
  // Extending the open windows and the data dates, the sealed part byte-identical, a new version: allowed.
  const C2 = bare(d => {
    d.version = 'c';
    d.learning.open['practice-train'][0] = '2019-01-01';
    d.learning.open['practice-validate'] = ['2024-06-01', '2025-01-01'];
    d.learning.open['practice-train'][1] = '2024-06-01';
    d.data.start = '2019-01-01';
    d.data.flowCoverage[1] = '2026-06-01';
    d.prop.open.train[0] = '2020-01-01';
  });
  assert.strictEqual(C2.fingerprint.sealed.learning, A.fingerprint.sealed.learning);
  assert.notStrictEqual(C2.fingerprint.hash, A.fingerprint.hash);
  assert.deepStrictEqual(S.sealedRefusals('learning', [validate, testLook], C2), []);
  assert.deepStrictEqual(S.sealedRefusals('prop', [stamp(A, { candidate: 'c', purpose: 'judging', ranges: [{ from: '2024-08-01', to: '2024-08-02' }] })], C2), []);
  // The prop domain: any look seals its sealed part; its open part may change.
  const propLook = stamp(A, { candidate: 'c', purpose: 'tuning', ranges: [{ from: '2022-03-01', to: '2022-03-02' }] });
  const Psealed = bare(d => { d.version = 'p'; d.prop.sealed.blocks.oos[1] = '2025-01-01'; d.prop.sealed.blocks.recent[0] = '2025-01-01'; });
  assert.match(S.sealedRefusals('prop', [propLook], Psealed).join(), /sealed prop windows/);
  assert.deepStrictEqual(S.sealedRefusals('learning', [propLook], Psealed), [], 'the domains are sealed separately');
});

test('the sealed rule on the committed schedule: the recorded looks and every unfingerprinted entry were taken under the first schedule', () => {
  // The recorded final look locks the learning sealed part to LEGACY's, with no ledger at all.
  const moved = variant(d => { d.version = 'v2'; d.learning.sealed.windows.final[1] = '2026-12-01'; }).load();
  assert.match(S.sealedRefusals('learning', [], moved).join(), /schedule v1, under which 1 sealed learning look\(s\) were taken \(the first: 2026-06-01..2026-06-06, final\)/);
  const propMoved = variant(d => { d.version = 'v2'; d.prop.sealed.llmFrom = '2026-05-01'; }).load();
  assert.match(S.sealedRefusals('prop', [], propMoved).join(), /schedule v1, under which 3 sealed prop look\(s\) were taken/);
  // Dropping the recorded looks to free the windows: an old ledger line without a fingerprint still seals them.
  const dropped = variant(d => { d.version = 'v2'; d.learning.sealed.recordedLooks = []; d.learning.sealed.windows.final[1] = '2026-12-01'; }).load();
  assert.deepStrictEqual(S.sealedRefusals('learning', [], dropped), []);
  assert.strictEqual(S.sealedRefusals('learning', [{ kind: 'look', role: 'test', from: '2025-02-03', to: '2025-02-04' }], dropped).length, 1);
  // A practice change under a new version: allowed.
  const practice = variant(d => { d.version = 'v2'; d.learning.open['practice-train'][0] = '2019-07-01'; }).load();
  assert.deepStrictEqual(S.sealedRefusals('learning', [{ kind: 'look', role: 'test', from: '2025-02-03', to: '2025-02-04' }], practice), []);
});

test('a changed schedule carries a new version: a version naming another file than the ledger\'s is refused; versions are reported', () => {
  const A = bare(d => { d.version = 'a'; });
  const A2 = bare(d => { d.version = 'a'; d.learning.open['practice-train'][0] = '2019-07-01'; });
  const entry = stamp(A, { kind: 'look', role: 'practice-validate', from: '2024-07-01', to: '2024-07-02' });
  assert.match(S.sealedRefusals('learning', [entry], A2).join(), /version a \(hash [0-9a-f]{12}\) names another file than the one the ledger's entries of version a were written under/);
  assert.match(S.sealedRefusals('prop', [entry], A2).join(), /version a/, 'either ledger');
  // On the committed schedule: an edit back to v1 (the recorded looks' version) is refused by those looks themselves.
  const keptV1 = variant(d => { d.version = 'v1'; d.learning.open['practice-train'][0] = '2019-07-01'; }).load();
  assert.match(S.sealedRefusals('learning', [], keptV1).join(), /version v1 .* names another file/);
  // The report: each entry's version, the first schedule's for an entry without one.
  const B = bare(d => { d.version = 'b'; d.learning.open['practice-train'][0] = '2019-07-01'; });
  const ledger = [{ kind: 'look', role: 'test' }, entry, stamp(B, { kind: 'look', role: 'test' }), stamp(B, { kind: 'result', role: 'test' })];
  assert.deepStrictEqual(S.versionsOf(ledger).map(v => [v.version, v.entries]), [['v1', 1], ['a', 1], ['b', 2]]);
  assert.deepStrictEqual(ledger.map(S.scheduleVersion), ['v1', 'a', 'b', 'b']);
});

test('every ledger entry records the schedule it was written under, whatever it carried', () => {
  const { appendLook, readLedger } = require('../../scripts/lib/prop/ledger-file');
  const f = path.join(tmp(), 'looks.jsonl');
  appendLook(f, { candidate: 'c', purpose: 'tuning', ranges: [{ from: '2022-03-01', to: '2022-03-02' }], schedule: { version: 'forged', hash: 'x', sealed: {} } });
  const [e] = readLedger(f);
  assert.deepStrictEqual(e.schedule, S.fingerprint());
});

test('the ledgers refuse a look under a schedule whose sealed windows changed after a look (both checkLooks, every learning write)', () => {
  const other = { version: 'v0', hash: 'f'.repeat(64), sealed: { learning: 'e'.repeat(64), prop: 'd'.repeat(64) } };
  const learningLooks = require('../../scripts/lib/learning/looks');
  const sealedTest = { kind: 'look', evaluation: 'old', candidate: 'c', purpose: 'judging', runId: 'old', from: '2025-02-03', to: '2025-02-04', role: 'test', schedule: other };
  const look = { evaluation: 'ev1', candidate: 'c', runId: 'run1', purpose: 'validate', from: '2024-07-08', to: '2024-07-09' };
  assert.ok(learningLooks.checkLook(look, []).ok);
  const r = learningLooks.checkLook(look, [sealedTest]);
  assert.strictEqual(r.ok, false);
  assert.match(r.refusals.join(), /sealed learning windows .* schedule v0/);
  // A validate line under another schedule (open windows only) doesn't seal.
  assert.ok(learningLooks.checkLook(look, [{ ...sealedTest, role: 'practice-validate', purpose: 'validate', evaluation: 'v', runId: 'v', from: '2024-07-01', to: '2024-07-02', schedule: { ...other, sealed: S.fingerprint().sealed } }]).ok);
  // recordResult (no checkLook) refuses it too, writing nothing.
  const f = path.join(tmp(), 'looks.jsonl');
  fs.writeFileSync(f, `${JSON.stringify(sealedTest)}\n`);
  assert.throws(() => learningLooks.recordResult(f, { evaluation: 'old', candidate: 'c', result: 'pass' }), /the schedule is refused/);
  assert.strictEqual(fs.readFileSync(f, 'utf8').trim().split('\n').length, 1);
  // The prop ledger.
  const propLooks = require('../../scripts/lib/prop/looks');
  const plook = { candidate: 'c', purpose: 'tuning', ranges: [{ from: '2022-03-01', to: '2022-03-02' }] };
  assert.ok(propLooks.checkLook(plook, []).ok);
  const pr = propLooks.checkLook(plook, [{ ...plook, schedule: other }]);
  assert.strictEqual(pr.ok, false);
  assert.match(pr.refusals.join(), /sealed prop windows .* schedule v0/);
});

test('one evaluation runs under one schedule: a look in an evaluation started under another schedule is refused', () => {
  const learningLooks = require('../../scripts/lib/learning/looks');
  const prev = { version: 'v0', hash: 'f'.repeat(64), sealed: S.fingerprint().sealed };
  const first = { kind: 'look', evaluation: 'ev', candidate: 'c', purpose: 'validate', runId: 'a', arm: 'without', config: null, from: '2024-07-08', to: '2024-07-09', role: 'practice-validate', schedule: prev };
  const r = learningLooks.checkLook({ evaluation: 'ev', candidate: 'c', runId: 'b', purpose: 'validate', from: '2024-07-08', to: '2024-07-09' }, [first]);
  assert.match(r.refusals.join(), /evaluation ev was taken under schedule v0 .* one evaluation runs under one schedule/);
  assert.ok(learningLooks.checkLook({ evaluation: 'ev', candidate: 'c', runId: 'b', purpose: 'validate', from: '2024-07-08', to: '2024-07-09' }, [{ ...first, schedule: S.fingerprint() }]).ok);
  // The usage report names the version of each look.
  assert.deepStrictEqual(learningLooks.lookUsage([first]), {
    'practice-validate': { looks: 1, runs: 1, evaluations: 0, versions: { v0: 1 } },
    final: { looks: 1, runs: 1, evaluations: 0, versions: { v1: 1 } },
  });
});
