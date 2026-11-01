'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const X = require('../../scripts/lib/learning/experience-index');
const { tmpHome } = require('../fixtures/learning');

const CTX = { regime: 'trend-up', volatility: 'normal', window: 'ny-am', biasSide: 'with', alignment: 'aligned', dayType: 'normal' };
const SKILL = 'bias:bos-vs-choch+entry:candle-reading';
const READ = 'bias:1h-bos-up+entry:3m-close-top';
const ALL = X.cellKey('skill', SKILL);

/** Weekdays from a date. */
function weekdays(from, count) {
  const out = [];
  for (let t = Date.parse(from); out.length < count; t += 86400000) if (![0, 6].includes(new Date(t).getUTCDay())) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** n decisions spread over `days` trading days from March 2022 (practice-train), R from rFor(i); each with its bar. */
function decisions(n, days, rFor, o = {}) {
  const dayList = weekdays(o.from || '2022-03-01T00:00:00Z', days);
  return Array.from({ length: n }, (_, i) => ({
    id: `${o.tag || 'd'}${i}`, runId: 'r1', bar: `${dayList[i % days]}T15:00:00.000Z`, day: dayList[i % days], decision: i % 3 === 0 ? 'entered' : 'passed',
    signatures: { skill: o.skill || SKILL, read: o.read || READ }, context: { ...CTX, ...(o.ctx || {}) },
    outcome: { R: rFor(i) },
  }));
}

test('index: the cells per signature, per context key and the full context; counts, and day-bootstrap intervals for the win rate and the mean R', () => {
  const ds = decisions(30, 12, i => (i % 2 ? 2 : -1));
  const doc = X.buildIndex(ds, { seed: 7, reps: 500, now: new Date('2026-10-14T00:00:00Z') });
  const all = X.cellAt(doc, ALL);
  assert.deepStrictEqual([all.n, all.entries, all.passes, all.days, all.wins, all.enough], [30, 10, 20, 12, 15, true]);
  assert.strictEqual(all.meanR.mean, 0.5);
  assert.ok(all.meanR.lo < 0.5 && all.meanR.hi > 0.5 && all.meanR.by === 'day');
  assert.deepStrictEqual([all.winRate.rate, all.winRate.level, all.winRate.by], [0.5, 0.9, 'day']);
  assert.ok(all.winRate.lo < 0.5 && all.winRate.hi > 0.5);
  assert.strictEqual(all.firstSeen, '2022-03-01');
  for (const k of ['regime=trend-up', 'biasSide=with', 'dayType=normal']) assert.ok(doc.cells[X.cellKey('skill', SKILL, k)], k);
  assert.ok(doc.cells[X.cellKey('read', READ, X.contextKey(CTX))], 'the full context');
  assert.strictEqual(X.contextKey(CTX), 'regime=trend-up;volatility=normal;window=ny-am;biasSide=with;alignment=aligned;dayType=normal');
  assert.deepStrictEqual([doc.minN, doc.minDays, doc.roles, doc.decisions, doc.walkForward, doc.shuffle], [20, 10, ['practice-train'], 30, true, null]);
  // The cell keeps rows, not statistics: [day, R, entered, regime, maeR, mfeR, curated, weight] (no excursion: null, never invented).
  assert.deepStrictEqual(doc.cells[ALL][0], ['2022-03-01', -1, 1, 'trend-up', null, null, 0, 1]);
  // Reproducible: the same decisions and seed, the same hash and the same intervals, whenever built.
  assert.strictEqual(X.buildIndex(ds, { seed: 7, reps: 500, now: new Date('2027-01-01T00:00:00Z') }).hash, doc.hash);
  assert.deepStrictEqual(X.cellAt(X.buildIndex(ds, { seed: 7, reps: 500 }), ALL), all);
  assert.notStrictEqual(X.buildIndex(ds, { seed: 8, reps: 500 }).hash, doc.hash);
});

test('walk-forward: a cell at a day counts only the days strictly before it; a 2022 bar never sees its own day or later', () => {
  const early = decisions(25, 12, () => 1, { tag: 'e' }); // 2022-03-01 .. 2022-03-16
  const later = decisions(25, 12, () => -1, { tag: 'l', from: '2023-06-01T00:00:00Z' });
  const doc = X.buildIndex([...early, ...later], { reps: 200 });
  const on = day => X.cellAt(doc, ALL, day);
  assert.deepStrictEqual([on('2022-03-01').n, on('2022-03-01').note], [0, 'too few samples (n=0, 0 days)'], 'nothing before the first day');
  const mid = on('2022-06-01');
  assert.deepStrictEqual([mid.n, mid.lastSeen, mid.meanR.mean], [25, '2022-03-16', 1], 'only the 2022 rows, none of 2023');
  assert.strictEqual(on('2022-03-16').lastSeen, '2022-03-15', 'not its own day');
  assert.ok(on('2022-03-16').n < 25);
  assert.strictEqual(on(null).n, 50, 'the whole record, for show');
  // The examples too.
  const all = X.examplesBefore(doc, SKILL, null);
  assert.ok(all.some(e => e.day >= '2023-06-01'));
  assert.ok(X.examplesBefore(doc, SKILL, '2022-06-01').every(e => e.day < '2022-06-01'));
  assert.deepStrictEqual(X.examplesBefore(doc, SKILL, '2022-03-01'), []);
});

test('index: under MIN_N decisions or MIN_DAYS days, counts only and "too few samples"', () => {
  const few = X.cellAt(X.buildIndex(decisions(19, 12, () => 1), { reps: 100 }), ALL);
  assert.deepStrictEqual([few.enough, few.n, few.winRate, few.meanR, few.note], [false, 19, null, null, 'too few samples (n=19, 12 days)']);
  const clustered = X.cellAt(X.buildIndex(decisions(40, 9, () => 1), { reps: 100 }), ALL);
  assert.deepStrictEqual([clustered.enough, clustered.note], [false, 'too few samples (n=40, 9 days)']);
  // An unfilled pass (no R) counts as unfilled, never in n.
  const ds = decisions(20, 10, () => 1);
  ds[0].outcome = { R: null };
  const c = X.cellAt(X.buildIndex(ds, { reps: 100 }), ALL);
  assert.deepStrictEqual([c.n, c.unfilled, c.enough], [19, 1, false]);
});

test('index: one day\'s cluster counts once; shifted needs a latest year of its own sample size, and names it', () => {
  // 11 days at -0.2 and one day with 30 winners: the day bootstrap's interval reaches below zero.
  const ds = [...decisions(11, 11, () => -0.2, { tag: 'a' }), ...decisions(30, 1, () => 2, { tag: 'b', from: '2022-06-01T00:00:00Z' })];
  const c = X.cellAt(X.buildIndex(ds, { reps: 1000 }), ALL);
  assert.ok(c.meanR.mean > 1 && c.meanR.lo < 0, JSON.stringify(c.meanR));
  assert.ok(c.winRate.lo < 0.5, 'the win rate by day too');
  // A latest year of 10 decisions over 5 days: too few to call a shift.
  const thin = X.cellAt(X.buildIndex([...decisions(25, 12, () => 1, { tag: 'x' }), ...decisions(10, 5, () => -1, { tag: 'y', from: '2023-03-01T00:00:00Z' })], { reps: 100 }), ALL);
  assert.deepStrictEqual([thin.byYear['2023'].meanR, thin.shifted, thin.latestYear], [-1, false, { year: '2023', n: 10, nEff: 10, days: 5, meanR: -1 }]);
  const shift = X.cellAt(X.buildIndex([...decisions(60, 30, () => 1, { tag: 'x' }), ...decisions(25, 12, () => -1, { tag: 'y', from: '2023-03-01T00:00:00Z' })], { reps: 100 }), ALL);
  assert.deepStrictEqual([shift.shifted, shift.latestYear.n, shift.latestYear.days], [true, 25, 12]);
});

test('shuffled: the rows permuted across cells and the examples across signatures, seeded and hashed', () => {
  const ds = [...decisions(25, 12, () => 1, { tag: 'a' }), ...decisions(25, 12, () => -1, { tag: 'b', skill: 'bias:daily-bias', read: 'bias:above' })];
  const plain = X.buildIndex(ds, { reps: 100 });
  const shuffled = X.buildIndex(ds, { reps: 100, shuffle: 5 });
  assert.deepStrictEqual(Object.keys(shuffled.cells), Object.keys(plain.cells), 'the same cells');
  assert.deepStrictEqual(Object.values(shuffled.cells).flat().length, Object.values(plain.cells).flat().length, 'the same rows');
  assert.ok(Object.keys(plain.cells).some(k => JSON.stringify(plain.cells[k]) !== JSON.stringify(shuffled.cells[k])), 'moved across cells');
  assert.strictEqual(shuffled.shuffle, 5);
  assert.notStrictEqual(shuffled.hash, plain.hash);
  assert.strictEqual(X.buildIndex(ds, { reps: 100, shuffle: 5 }).hash, shuffled.hash, 'seeded');
  assert.throws(() => X.buildIndex(ds, { shuffle: 'yes' }), /whole-number seed/);
});

test('index: leakage refused - a practice-validate, test, final or unscheduled decision, a plain pass included; the day from the bar', () => {
  for (const [day, role] of [['2024-08-01', 'practice-validate'], ['2025-02-03', 'test'], ['2026-06-01', 'final'], ['2019-06-03', 'no role']]) {
    const ds = decisions(25, 12, () => 1);
    ds.push({ id: 'leak', cycleAt: `${day}T15:00:00.000Z`, decision: 'none', signatures: { skill: null, read: null } });
    assert.throws(() => X.buildIndex(ds), new RegExp(`leakage\\): 1 decision\\(s\\) in ${role}`), day);
  }
  // The line's own labels are never trusted: its bar decides.
  const ds = decisions(25, 12, () => 1);
  ds[0] = { ...ds[0], bar: '2025-02-03T15:00:00.000Z', day: '2022-03-01', role: 'practice-train' };
  assert.throws(() => X.buildIndex(ds), /1 decision\(s\) in test/);
  assert.throws(() => X.buildIndex([{ decision: 'passed', signatures: { skill: 'x' }, outcome: { R: 1 } }]), /without its bar or day/);
  // A decision whose outcome was hidden (a reasoning-fix look) never teaches.
  const hidden = decisions(25, 12, () => 1).map(d => ({ ...d, hidden: true }));
  assert.strictEqual(X.buildIndex(hidden, { reps: 50 }).decisions, 0);
});

test('index files: written by hash, read with the hash checked, pinned into a run home and loaded frozen', () => {
  const doc = X.buildIndex(decisions(25, 12, () => 1), { reps: 100, runs: [{ runId: 'r1', file: '/somewhere/decisions.jsonl', sha256: 'ab' }] });
  assert.deepStrictEqual(doc.runs, [{ runId: 'r1', file: 'decisions.jsonl', sha256: 'ab' }], 'no machine path in the index');
  const dir = path.join(tmpHome(), 'experience');
  const file = X.writeIndex(dir, doc);
  assert.strictEqual(path.basename(file), `index-${doc.hash.slice(0, 16)}.json`);
  assert.strictEqual(X.readIndex(file).hash, doc.hash);
  const run = tmpHome();
  assert.strictEqual(X.loadPinned(run), null);
  const pinned = X.pinIndex(run, file);
  assert.strictEqual(path.dirname(pinned.file), path.join(run, 'experience'));
  assert.strictEqual(X.loadPinned(run).hash, doc.hash);
  assert.strictEqual(X.pinIndex(run, file).hash, doc.hash, 'pinned again on resume');
  // A run keeps the index it pinned.
  const other = X.writeIndex(dir, X.buildIndex(decisions(25, 12, () => -1), { reps: 100 }));
  assert.throws(() => X.pinIndex(run, other), /a run keeps its index/);
  // A run declared not learning is never shown a record.
  const off = tmpHome();
  fs.writeFileSync(path.join(off, 'learning-run.json'), JSON.stringify({ learning: false }));
  assert.throws(() => X.pinIndex(off, file), /declared not learning/);
  fs.mkdirSync(path.join(off, 'experience'));
  fs.copyFileSync(path.join(run, 'experience', 'pinned.json'), path.join(off, 'experience', 'pinned.json'));
  assert.strictEqual(X.loadPinned(off), null);
  // A changed index is refused: the file, or the pin; an index of the old version too.
  const tampered = JSON.parse(fs.readFileSync(pinned.file, 'utf8'));
  tampered.cells[ALL][0][1] = 999;
  fs.writeFileSync(pinned.file, JSON.stringify(tampered));
  assert.throws(() => X.loadPinned(run), /doesn't match its hash/);
  fs.writeFileSync(pinned.file, JSON.stringify({ ...tampered, v: 1 }));
  assert.throws(() => X.loadPinned(run), /rebuild it/);
  fs.writeFileSync(path.join(run, 'experience', 'pinned.json'), JSON.stringify({ file: '../x.json', hash: doc.hash }));
  assert.throws(() => X.loadPinned(run), /not an index file/);
});

test('scripts/experience-index.js: build from run homes, refuse leakage, show and pin; the shuffled arm', () => {
  const cli = path.join(__dirname, '..', '..', 'scripts', 'experience-index.js');
  const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  const home = tmpHome();
  const runHome = tmpHome();
  fs.mkdirSync(path.join(runHome, 'experience'));
  fs.writeFileSync(path.join(runHome, 'experience', 'decisions.jsonl'), decisions(25, 12, i => (i % 2 ? 1.5 : -1)).map(d => `${JSON.stringify(d)}\n`).join(''));
  const b = run(['build', runHome, '--seed', '3'], { FTH_HOME: home });
  assert.strictEqual(b.status, 0, b.stderr);
  const file = fs.readdirSync(path.join(home, 'experience')).find(n => n.startsWith('index-'));
  assert.ok(file, b.stdout);
  const s = run(['show', path.join(home, 'experience', file), '--top', '3']);
  assert.match(s.stdout, /0\.20R \[.*\] win 0\.48 n 25 \(12 days\)/);
  const target = tmpHome();
  assert.strictEqual(run(['pin', path.join(home, 'experience', file), target]).status, 0);
  assert.ok(fs.existsSync(path.join(target, 'experience', 'pinned.json')));
  const sh = run(['build', runHome, '--shuffle', '9', '--out', path.join(home, 'shuffled')]);
  assert.strictEqual(sh.status, 0, sh.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'shuffled', fs.readdirSync(path.join(home, 'shuffled'))[0]), 'utf8')).shuffle, 9);
  fs.appendFileSync(path.join(runHome, 'experience', 'decisions.jsonl'), `${JSON.stringify({ id: 'z', day: '2025-03-03', decision: 'none' })}\n`);
  const leak = run(['build', runHome], { FTH_HOME: home });
  assert.strictEqual(leak.status, 1);
  assert.match(leak.stderr, /leakage/);
  assert.match(run(['build']).stderr, /usage/);
  assert.match(run(['build', runHome, '--seed']).stderr, /--seed: give its value/);
});

test('index: examples per skill signature and month, latest first, compact, the why cut to 160 characters', () => {
  const ds = decisions(15, 12, i => i - 7);
  ds[14].reads = [{ step: 'bias', skill: 'bos-vs-choch', read: '1h bos up', why: 'x'.repeat(300), field: 'h1.lastBreak' }];
  const ex = X.buildIndex(ds, { reps: 50 }).examples[SKILL];
  assert.strictEqual(ex.length, 4, 'four of March 2022');
  assert.ok(ex[0].day >= ex[3].day, 'latest first');
  const spread = X.buildIndex([...decisions(8, 8, () => 1), ...decisions(8, 8, () => 1, { tag: 'm', from: '2022-05-02T00:00:00Z' })], { reps: 50 }).examples[SKILL];
  assert.deepStrictEqual([...new Set(spread.map(e => e.day.slice(0, 7)))], ['2022-05', '2022-03']);
  const withReads = ex.find(e => e.reads.length) || X.buildIndex([ds[14]], { reps: 50 }).examples[SKILL][0];
  assert.deepStrictEqual(Object.keys(withReads.reads[0]), ['step', 'skill', 'read', 'why']);
  assert.strictEqual(withReads.reads[0].why.length, 160);
  assert.deepStrictEqual(Object.keys(ex[0]), ['day', 'decision', 'side', 'context', 'reads', 'R', 'maeR', 'mfeR', 'grade', 'curated']);
});

test('a row is dated by the day its outcome came: a trade carried into the next session counts only after it', () => {
  const ds = decisions(25, 12, () => 1);
  // Decided on 2022-03-01, exited on 2022-03-02's session.
  ds[0] = { ...ds[0], outcome: { R: 9, exitTime: '2022-03-02T15:00:00.000Z' } };
  assert.strictEqual(X.knownDay(ds[0]), '2022-03-02');
  const doc = X.buildIndex(ds, { reps: 50 });
  assert.ok(doc.cells[ALL].some(r => r[0] === '2022-03-02' && r[1] === 9));
  // Its example too: dated by the exit, so on 03-02 it is not yet shown.
  const few = decisions(3, 3, () => 1);
  few[0] = { ...few[0], outcome: { R: 9, exitTime: '2022-03-02T15:00:00.000Z' } };
  const small = X.buildIndex(few, { reps: 50 });
  assert.ok(small.examples[SKILL].some(e => e.day === '2022-03-02' && e.R === 9));
  assert.ok(!X.examplesBefore(small, SKILL, '2022-03-02').some(e => e.R === 9));
  assert.ok(X.examplesBefore(small, SKILL, '2022-03-03').some(e => e.R === 9));
  // A run's arm from the index it pins.
  const file = X.writeIndex(path.join(tmpHome(), 'i'), doc);
  assert.strictEqual(X.armOf(file), `with:${doc.hash.slice(0, 16)}`);
  assert.match(X.armOf(X.writeIndex(path.join(tmpHome(), 'j'), X.buildIndex(ds, { reps: 50, shuffle: 3 }))), /^shuffled:[0-9a-f]{16}$/);
  assert.strictEqual(X.armOf(null), 'without');
  assert.strictEqual(X.cellAt(doc, ALL, '2022-03-02').n, 2, 'on 03-02 only the two 03-01 decisions known then, not the carried one');
  // An outcome that came in practice-validate is leakage.
  const late = decisions(25, 12, () => 1, { from: '2024-06-03T00:00:00Z' });
  late[0] = { ...late[0], outcome: { R: 1, exitTime: '2024-07-01T15:00:00.000Z' } };
  assert.throws(() => X.buildIndex(late), /1 decision\(s\) in practice-validate/);
});

test('a decision counts once; the same log given twice is refused', () => {
  const ds = decisions(25, 12, () => 1);
  assert.strictEqual(X.buildIndex([...ds, ...ds], { reps: 50 }).decisions, 25);
  assert.throws(() => X.buildIndex(ds, { runs: [{ runId: 'a', sha256: 'h1' }, { runId: 'b', sha256: 'h1' }] }), /the same experience log given twice/);
});

test('index: decisions scored under two exit plans are refused (a mode or its parameters); the index holds its one plan (untagged lines: none)', () => {
  const E = require('../../scripts/lib/learning/experience-log');
  const A = E.exitRecord({ mode: 'target_then_trail', plan: { afterTarget: { trailBy: 'structure', swingMinutes: 15 } } });
  const B = E.exitRecord({ mode: 'target_then_trail', plan: { afterTarget: { trailBy: 'structure', swingMinutes: 5 } } });
  const C = E.exitRecord(E.BRACKETS);
  const tagged = (list, x) => list.map(d => ({ ...d, exit: x.mode, exitPlan: x.hash }));
  const trail = tagged(decisions(30, 15, i => (i % 2 ? 1 : -1)), A);
  const built = X.buildIndex(trail);
  assert.deepStrictEqual([built.exit, built.exitPlan], ['target_then_trail', A.hash]);
  // The hash is of the plan, whatever order its keys were built in.
  assert.strictEqual(E.exitHash({ plan: { b: 1, a: 2 }, mode: 'm' }), E.exitHash({ mode: 'm', plan: { a: 2, b: 1 } }));
  const none = X.buildIndex(decisions(30, 15, () => 1));
  assert.deepStrictEqual([none.exit, none.exitPlan], [null, null], 'lines written before the record');
  const old = decisions(10, 5, () => 1, { tag: 'o' });
  assert.throws(() => X.buildIndex([...trail, ...old]), new RegExp(`index refused: its decisions were scored under different exit plans \\(target_then_trail ${A.hash.slice(0, 12)}: 30, untagged \\(written before the exit plan was recorded\\): 10\\)`));
  assert.throws(() => X.buildIndex([...trail, ...tagged(old, C)]), new RegExp(`different exit plans \\(target_then_trail ${A.hash.slice(0, 12)}: 30, brackets ${C.hash.slice(0, 12)}: 10\\)`));
  // One mode, other parameters: two plans, refused.
  assert.throws(() => X.buildIndex([...trail, ...tagged(old, B)]), /different exit plans/);
  // A plan's lines that disagree on its mode: edited, refused.
  assert.throws(() => X.buildIndex([...trail, ...tagged(old, { ...A, mode: 'brackets' })]), /one exit plan under two modes/);
});

/** decisions() with each outcome's maeR and mfeR from xFor(i) ([mae, mfe]; undefined leaves the outcome without them). */
const withExcursion = (ds, xFor) => ds.map((d, i) => {
  const x = xFor(i);
  return x ? { ...d, outcome: { ...d.outcome, maeR: x[0], mfeR: x[1] } } : d;
});

test('MAE/MFE: each decision\'s maeR and mfeR recorded in its rows and examples from its outcome; missing or not a number is null', () => {
  const ds = withExcursion(decisions(25, 12, i => (i % 2 ? 2 : -1)), i => (i === 1 ? undefined : i === 2 ? ['x', null] : [-0.25 * (i % 4), 0.5 * (i % 5)]));
  ds[3] = { ...ds[3], outcome: { R: null, maeR: -0.5, mfeR: 1 } }; // unfilled: no R, so no excursion either
  const doc = X.buildIndex(ds, { reps: 50 });
  const row = id => doc.cells[ALL].find(r => r[0] === ds[id].day && r[1] === ds[id].outcome.R && r[4] === (Number.isFinite(ds[id].outcome.maeR) ? ds[id].outcome.maeR : null));
  assert.deepStrictEqual(doc.cells[ALL][0], ['2022-03-01', -1, 1, 'trend-up', -0, 0, 0, 1]);
  assert.deepStrictEqual(row(5).slice(4), [-0.25, 0, 0, 1]);
  assert.ok(doc.cells[ALL].some(r => r[0] === ds[1].day && r[4] === null && r[5] === null), 'no excursion in the outcome: null');
  assert.ok(doc.cells[ALL].some(r => r[0] === ds[2].day && r[4] === null && r[5] === null), 'not a number: null');
  assert.ok(doc.cells[ALL].some(r => r[0] === ds[3].day && r[1] === null && r[4] === null), 'an unfilled pass carries none');
  const ex = Object.values(doc.examples).flat();
  const num = v => (Number.isFinite(v) ? v : null);
  assert.ok(ex.length && ex.every(e => ds.some(x => x.day === e.day && x.outcome.R === e.R && num(x.outcome.maeR) === e.maeR && num(x.outcome.mfeR) === e.mfeR)), 'each example its own decision\'s');
  assert.ok(ex.some(e => Number.isFinite(e.maeR)));
  assert.strictEqual(X.VERSION, 3);
});

test('MAE/MFE: the medians with their counts, each only from at least MIN_N decisions that have one', () => {
  // 25 decisions over 12 days: 12 at MAE -1 and MFE 0.5, 13 at MAE -0.25 and MFE 2.5; the median is the middle one.
  const ds = withExcursion(decisions(25, 12, i => (i % 2 ? 2 : -1)), i => (i < 12 ? [-1, 0.5] : [-0.25, 2.5]));
  const c = X.cellAt(X.buildIndex(ds, { reps: 50 }), ALL);
  assert.deepStrictEqual([c.enough, c.mae.n, c.mae.days, c.mae.median, c.mfe.n, c.mfe.median], [true, 25, 12, -0.25, 25, 2.5]);
  // Enough decisions, but only 19 with an excursion (lines written before they were recorded): the counts, no median.
  const old = withExcursion(decisions(25, 12, () => 1), i => (i < X.MIN_N - 1 ? [-0.5, 1] : undefined));
  const o = X.cellAt(X.buildIndex(old, { reps: 50 }), ALL);
  const none = (n, days) => ({ n, nEff: n, days, median: null, lo: null, hi: null });
  assert.deepStrictEqual([o.enough, o.mae, o.mfe], [true, none(X.MIN_N - 1, 12), none(X.MIN_N - 1, 12)]);
  // Enough with an excursion, but over fewer than MIN_DAYS days: no median either.
  const clumped = withExcursion(decisions(30, 12, () => 1), i => (i % 12 < X.MIN_DAYS - 1 ? [-0.5, 1] : undefined));
  const cl = X.cellAt(X.buildIndex(clumped, { reps: 50 }), ALL);
  assert.deepStrictEqual([cl.enough, cl.mae.n >= X.MIN_N, cl.mae.days, cl.mae.median], [true, true, X.MIN_DAYS - 1, null]);
  // A cell under MIN_N: the counts only.
  const few = X.cellAt(X.buildIndex(withExcursion(decisions(19, 12, () => 1), () => [-0.5, 1]), { reps: 50 }), ALL);
  assert.deepStrictEqual([few.enough, few.mae, few.mfe], [false, none(19, 12), none(19, 12)]);
  // Too few days, enough decisions: no median either.
  const clustered = X.cellAt(X.buildIndex(withExcursion(decisions(40, 9, () => 1), () => [-0.5, 1]), { reps: 50 }), ALL);
  assert.deepStrictEqual([clustered.enough, clustered.mae.median, clustered.mae.n], [false, null, 40]);
});

test('MAE/MFE walk-forward: the medians at a day count only the outcomes known before it', () => {
  const early = withExcursion(decisions(25, 12, () => 1, { tag: 'e' }), () => [-0.1, 3]);
  const later = withExcursion(decisions(25, 12, () => -1, { tag: 'l', from: '2023-06-01T00:00:00Z' }), () => [-1.1, 0.2]);
  const doc = X.buildIndex([...early, ...later], { reps: 50 });
  const mid = X.cellAt(doc, ALL, '2022-06-01');
  assert.deepStrictEqual([mid.mae.n, mid.mae.median, mid.mae.lo, mid.mae.hi, mid.mfe.median], [25, -0.1, -0.1, -0.1, 3], 'none of 2023');
  assert.deepStrictEqual(X.cellAt(doc, ALL, '2022-03-01').mae, { n: 0, nEff: 0, days: 0, median: null, lo: null, hi: null }, 'nothing before the first day');
  assert.strictEqual(X.cellAt(doc, ALL, null).mae.n, 50);
  // A trade carried into the next session counts only after its exit's session.
  const carried = withExcursion(decisions(25, 12, () => 1), () => [-0.2, 1]);
  carried[0] = { ...carried[0], outcome: { R: 1, maeR: -0.9, mfeR: 1, exitTime: '2022-03-02T15:00:00.000Z' } };
  assert.strictEqual(X.cellAt(X.buildIndex(carried, { reps: 50 }), ALL, '2022-03-02').mae.n, 2);
});

test('an index of an older version (rows without MAE/MFE) is refused by read, pin and the pinned load: rebuild it', () => {
  const doc = X.buildIndex(decisions(25, 12, () => 1), { reps: 50 });
  const { hash: _h, ...rest } = doc;
  const v2 = { ...rest, v: 2, cells: Object.fromEntries(Object.entries(doc.cells).map(([k, rows]) => [k, rows.map(r => r.slice(0, 4))])) };
  const old = { ...v2, hash: X.indexHash(v2) };
  const file = X.writeIndex(path.join(tmpHome(), 'old'), old);
  assert.throws(() => X.readIndex(file), /an index of version 2, not 3 \(walk-forward\): rebuild it/);
  assert.throws(() => X.pinIndex(tmpHome(), file), /version 2, not 3/);
  assert.throws(() => X.armOf(file), /version 2, not 3/);
  // A run that pinned it before the change: its load refuses, never misreads it.
  const run = tmpHome();
  fs.mkdirSync(path.join(run, 'experience'));
  const copy = X.writeIndex(path.join(run, 'experience'), old);
  fs.writeFileSync(path.join(run, 'experience', 'pinned.json'), JSON.stringify({ file: path.basename(copy), hash: old.hash, walkForward: true, shuffle: null }));
  assert.throws(() => X.loadPinned(run), /version 2, not 3/);
});

test('MAE/MFE intervals: the day bootstrap the rates use (a day\'s cluster counts once), seeded; the win rate\'s and mean\'s intervals unchanged by them', () => {
  // 11 days of shallow MAE and one day of 30 deep ones: the pooled median is the deep day's, its interval reaches the shallow.
  const ds = [...withExcursion(decisions(11, 11, () => 1, { tag: 'a' }), () => [-0.1, 2]), ...withExcursion(decisions(30, 1, () => 1, { tag: 'b', from: '2022-06-01T00:00:00Z' }), () => [-0.9, 0.3])];
  const c = X.cellAt(X.buildIndex(ds, { reps: 1000 }), ALL);
  assert.deepStrictEqual([c.mae.median, c.mae.level, c.mae.by], [-0.9, 0.9, 'day']);
  assert.ok(c.mae.lo <= c.mae.median && c.mae.hi >= -0.1, JSON.stringify(c.mae));
  assert.ok(c.mfe.lo <= 0.3 && c.mfe.hi >= 2, JSON.stringify(c.mfe));
  assert.deepStrictEqual(X.cellAt(X.buildIndex(ds, { reps: 1000 }), ALL).mae, c.mae, 'seeded');
  // The same decisions without excursions: the same win rate and mean R intervals.
  const bare = X.cellAt(X.buildIndex(ds.map(d => ({ ...d, outcome: { R: d.outcome.R } })), { reps: 1000 }), ALL);
  assert.deepStrictEqual([bare.meanR, bare.winRate], [c.meanR, c.winRate]);
});

test('MAE/MFE look-ahead: an excursion is dated by its exit\'s session (knownDay), never its entry', () => {
  // Every decision entered on its day and exited the next session: on a day, only those exited before it count.
  const ds = withExcursion(decisions(30, 15, () => 1), () => [-0.4, 1.2]).map(d => ({ ...d, outcome: { ...d.outcome, exitTime: `${weekdays(`${d.day}T00:00:00Z`, 2)[1]}T15:00:00.000Z` } }));
  const doc = X.buildIndex(ds, { reps: 50 });
  assert.ok(doc.cells[ALL].every(r => r[0] > '2022-03-01'), 'no row on an entry day');
  const firstExit = doc.cells[ALL][0][0];
  assert.strictEqual(X.cellAt(doc, ALL, firstExit).mae.n, 0, 'not on the day it exited');
  assert.strictEqual(X.cellAt(doc, ALL, weekdays(`${firstExit}T00:00:00Z`, 2)[1]).mae.n, 2, 'the day after: the two that exited');
});

test('curated runs without a weight: counted (rows, cells walk-forward, examples, totals), never in a rate or median', () => {
  const natural = withExcursion(decisions(25, 12, i => (i % 4 ? -1 : 2), { tag: 'n' }), () => [-0.8, 0.5]);
  const curated = withExcursion(decisions(25, 12, () => 2, { tag: 'c', from: '2022-06-01T00:00:00Z' }), () => [-0.1, 3]).map(d => ({ ...d, curated: true }));
  const doc = X.buildIndex([...natural, ...curated], { reps: 50 });
  const all = X.cellAt(doc, ALL);
  assert.deepStrictEqual([all.n, all.curated, all.unweighted, all.nEff, doc.decisions, doc.curated, doc.curatedUnweighted], [50, 25, 25, 25, 50, 25, 25]);
  // The rates and medians are the 25 natural decisions' alone (7 wins of 25: 0.28), as without the curated ones.
  const alone = X.cellAt(X.buildIndex(natural, { reps: 50 }), ALL);
  assert.deepStrictEqual([all.winRate.rate, all.meanR.mean, all.mae.median, all.mfe.median, all.mae.n, all.mae.nEff], [alone.winRate.rate, alone.meanR.mean, -0.8, 0.5, 50, 25]);
  assert.strictEqual(alone.winRate.rate, 0.28);
  assert.deepStrictEqual(doc.cells[ALL][0].slice(-2), [0, 1]);
  assert.deepStrictEqual(doc.cells[ALL].slice(-1)[0].slice(-2), [1, null]);
  assert.strictEqual(X.cellAt(doc, ALL, '2022-06-01').curated, 0, 'only the curated rows known before the day');
  const ex = Object.values(doc.examples).flat();
  assert.ok(ex.some(e => e.curated === true) && ex.every(e => e.curated === (e.day >= '2022-06-01')));
  assert.strictEqual(X.buildIndex(natural, { reps: 50 }).curated, 0);
  // A log is a curated run's when its run home pinned a curated list (a broken pin counts as one).
  const crypto = require('crypto');
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'experience'), { recursive: true });
  const log = path.join(home, 'experience', 'decisions.jsonl');
  assert.strictEqual(X.curatedLog(log), false);
  const pin = { kind: 'curated-pin', fingerprint: 'f', list: 'mix', windows: [] };
  const hash = crypto.createHash('sha256').update(JSON.stringify({ fingerprint: pin.fingerprint, list: pin.list, windows: pin.windows })).digest('hex');
  fs.writeFileSync(path.join(home, 'experience', 'curated-pinned.json'), JSON.stringify({ ...pin, hash }));
  assert.strictEqual(X.curatedLog(log), true);
  fs.writeFileSync(path.join(home, 'experience', 'curated-pinned.json'), JSON.stringify({ ...pin, hash: 'x' }));
  assert.strictEqual(X.curatedLog(log), true, 'a broken pin: a curated run\'s still');
  // The CLI tags every line of such a log, tagged or written before the tag; without its --lists document, no weight.
  fs.writeFileSync(log, natural.map(d => `${JSON.stringify(d)}\n`).join(''));
  const out = path.join(tmpHome(), 'out');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'experience-index.js'), 'build', home, '--out', out], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /25 decision\(s\) from 1 run\(s\).*25 curated-run decision\(s\) weighted to natural rates, 25 without a weight \(counted, never rated: give its --lists document/);
});

// --- The head trader's delivery keys (autotrader.js HEAD_DELIVERY_KEYS): an index never pools key-on with key-off.
test('delivery: no key on, the index exactly as before; on, named and another hash; a mixed pool refused', () => {
  const NOW_ = new Date('2026-10-14T00:00:00Z');
  const ds = decisions(30, 12, i => (i % 2 ? 2 : -1));
  const doc = X.buildIndex(ds, { seed: 7, reps: 500, now: NOW_ });
  // Captured from the base branch's builder for this fixture, before the delivery keys were read.
  assert.strictEqual(doc.hash, 'cdc34570b37389cb7daacacf01a71d732266d8cc0f1c2986c6090c567811c7d7');
  assert.ok(!('delivery' in doc));
  const on = X.buildIndex(ds.map(d => ({ ...d, delivery: 'cycleDataInPrompt' })), { seed: 7, reps: 500, now: NOW_ });
  assert.strictEqual(on.delivery, 'cycleDataInPrompt');
  assert.notStrictEqual(on.hash, doc.hash);
  assert.deepStrictEqual(on.cells, doc.cells, 'the same decisions: only the delivery tells them apart');
  const mixed = ds.map((d, i) => (i % 2 ? { ...d, delivery: 'cycleDataInPrompt' } : d));
  assert.throws(() => X.buildIndex(mixed, { reps: 200 }), /index refused: made under 2 head trader deliveries \(none \| cycleDataInPrompt; the runner config's headSkillsInPrompt, cycleDataInPrompt, roleSkillsInPrompt, deskBriefReports, stableFirstPrompt\)/);
  assert.throws(() => X.buildIndex(ds.map((d, i) => ({ ...d, delivery: i % 2 ? 'cycleDataInPrompt' : 'headSkillsInPrompt,cycleDataInPrompt' })), { reps: 200 }), /2 head trader deliveries/);
});

test('each line\'s delivery comes from its own run (withRunDelivery), never the line\'s word: an old untagged line of a key-on run is tagged; a disagreeing tag refused', () => {
  const runHome = (autotrader, lines) => {
    const h = tmpHome();
    const dir = path.join(h, 'replay', 'r1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ runId: 'r1', finished: true }));
    fs.writeFileSync(path.join(dir, 'autotrader.json'), JSON.stringify({ timeframe: 3, ...autotrader }));
    fs.mkdirSync(path.join(h, 'experience'));
    fs.writeFileSync(path.join(h, 'experience', 'decisions.jsonl'), lines.map(d => `${JSON.stringify(d)}\n`).join(''));
    return h;
  };
  const ds = decisions(25, 12, i => (i % 2 ? 1.5 : -1));
  // Key-off: the lines exactly as given (the same objects), with or without the run dir.
  const off = runHome({}, ds);
  const same = X.withRunDelivery(ds, off);
  assert.ok(same.every((d, i) => d === ds[i]));
  assert.ok(X.withRunDelivery(ds, tmpHome()).every((d, i) => d === ds[i]), 'no run to derive from: as given');
  // An old log of a key-on run (written before the tag): each line its run's delivery.
  const on = runHome({ headSkillsInPrompt: true }, ds);
  assert.ok(X.withRunDelivery(ds, on).every(d => d.delivery === 'headSkillsInPrompt'));
  // A tag that disagrees with the run: refused, either way.
  assert.throws(() => X.withRunDelivery(ds.map(d => ({ ...d, delivery: 'cycleDataInPrompt' })), on), /index refused: run r1's line d0 says delivery "cycleDataInPrompt", its run was made under headSkillsInPrompt/);
  assert.throws(() => X.withRunDelivery(ds.map(d => ({ ...d, delivery: 'cycleDataInPrompt' })), off), /its run was made under none/);
  // The CLI: an old key-on log pooled with a key-off one is refused; each alone builds.
  const cli = path.join(__dirname, '..', '..', 'scripts', 'experience-index.js');
  const out = () => path.join(tmpHome(), 'out');
  const later = decisions(25, 12, i => (i % 2 ? 1.5 : -1), { tag: 'l', from: '2022-06-01T00:00:00Z' });
  const offLater = runHome({}, later);
  const mixed = spawnSync(process.execPath, [cli, 'build', on, offLater, '--out', out()], { encoding: 'utf8' });
  assert.notStrictEqual(mixed.status, 0);
  assert.match(mixed.stderr, /index refused: made under 2 head trader deliveries/);
  const alone = spawnSync(process.execPath, [cli, 'build', on, '--out', out()], { encoding: 'utf8' });
  assert.strictEqual(alone.status, 0, alone.stderr);
});
