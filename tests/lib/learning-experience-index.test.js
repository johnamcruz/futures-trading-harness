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
  // The cell keeps rows, not statistics: [day, R, entered, regime].
  assert.deepStrictEqual(doc.cells[ALL][0], ['2022-03-01', -1, 1, 'trend-up']);
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
  assert.deepStrictEqual([thin.byYear['2023'].meanR, thin.shifted, thin.latestYear], [-1, false, { year: '2023', n: 10, days: 5, meanR: -1 }]);
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
  assert.deepStrictEqual(Object.keys(ex[0]), ['day', 'decision', 'side', 'context', 'reads', 'R', 'grade']);
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
