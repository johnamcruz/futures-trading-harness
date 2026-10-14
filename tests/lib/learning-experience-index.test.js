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

/** n decisions spread over `days` trading days of March-April 2022 (practice-train), R from rFor(i). */
function decisions(n, days, rFor, o = {}) {
  const start = Date.parse(o.from || '2022-03-01T00:00:00Z');
  const dayList = [];
  for (let t = start; dayList.length < days; t += 86400000) if (![0, 6].includes(new Date(t).getUTCDay())) dayList.push(new Date(t).toISOString().slice(0, 10));
  return Array.from({ length: n }, (_, i) => ({
    id: `${o.tag || 'd'}${i}`, runId: 'r1', day: dayList[i % days], decision: i % 3 === 0 ? 'entered' : 'passed',
    signatures: { skill: o.skill || SKILL, read: o.read || READ }, context: { ...CTX, ...(o.ctx || {}) },
    outcome: { R: rFor(i) },
  }));
}

test('index: the cells per signature, per context key and the full context; counts, Wilson and day-bootstrap intervals', () => {
  const ds = decisions(30, 12, i => (i % 2 ? 2 : -1));
  const doc = X.buildIndex(ds, { seed: 7, reps: 500, now: new Date('2026-10-14T00:00:00Z') });
  const all = doc.cells[X.cellKey('skill', SKILL)];
  assert.deepStrictEqual([all.n, all.entries, all.passes, all.days, all.wins, all.enough], [30, 10, 20, 12, 15, true]);
  assert.strictEqual(all.meanR.mean, 0.5);
  assert.ok(all.meanR.lo < 0.5 && all.meanR.hi > 0.5 && all.meanR.by === 'day');
  assert.deepStrictEqual([all.winRate.rate, all.winRate.level], [0.5, 0.9]);
  assert.ok(all.winRate.lo > 0.3 && all.winRate.hi < 0.7);
  assert.strictEqual(all.firstSeen, '2022-03-01');
  for (const k of ['regime=trend-up', 'biasSide=with', 'dayType=normal']) assert.ok(doc.cells[X.cellKey('skill', SKILL, k)], k);
  assert.ok(doc.cells[X.cellKey('read', READ, X.contextKey(CTX))], 'the full context');
  assert.strictEqual(X.contextKey(CTX), 'regime=trend-up;volatility=normal;window=ny-am;biasSide=with;alignment=aligned;dayType=normal');
  assert.deepStrictEqual([doc.minN, doc.minDays, doc.roles, doc.decisions], [20, 10, ['practice-train'], 30]);
  // Reproducible: the same decisions and seed, the same hash, whenever built.
  assert.strictEqual(X.buildIndex(ds, { seed: 7, reps: 500, now: new Date('2027-01-01T00:00:00Z') }).hash, doc.hash);
  assert.notStrictEqual(X.buildIndex(ds, { seed: 8, reps: 500 }).hash, doc.hash);
});

test('index: under MIN_N decisions or MIN_DAYS days, counts only and "too few samples"', () => {
  const few = X.buildIndex(decisions(19, 12, () => 1), { reps: 100 }).cells[X.cellKey('skill', SKILL)];
  assert.deepStrictEqual([few.enough, few.n, few.winRate, few.meanR, few.note], [false, 19, null, null, 'too few samples (n=19, 12 days)']);
  const clustered = X.buildIndex(decisions(40, 9, () => 1), { reps: 100 }).cells[X.cellKey('skill', SKILL)];
  assert.deepStrictEqual([clustered.enough, clustered.note], [false, 'too few samples (n=40, 9 days)']);
  // An unfilled pass (no R) counts as unfilled, never in n.
  const ds = decisions(20, 10, () => 1);
  ds[0].outcome = { R: null };
  const c = X.buildIndex(ds, { reps: 100 }).cells[X.cellKey('skill', SKILL)];
  assert.deepStrictEqual([c.n, c.unfilled, c.enough], [19, 1, false]);
});

test('index: one day\'s cluster counts once in the mean R interval; a sign change in the latest year is shifted', () => {
  // 11 days at -0.2 and one day with 30 winners: the day bootstrap's interval reaches below zero.
  const ds = [...decisions(11, 11, () => -0.2, { tag: 'a' }), ...decisions(30, 1, () => 2, { tag: 'b', from: '2022-06-01T00:00:00Z' })];
  const c = X.buildIndex(ds, { reps: 1000 }).cells[X.cellKey('skill', SKILL)];
  assert.ok(c.meanR.mean > 1 && c.meanR.lo < 0, JSON.stringify(c.meanR));
  const shift = X.buildIndex([...decisions(25, 12, () => 1, { tag: 'x' }), ...decisions(10, 5, () => -1, { tag: 'y', from: '2023-03-01T00:00:00Z' })], { reps: 100 }).cells[X.cellKey('skill', SKILL)];
  assert.deepStrictEqual([shift.byYear['2023'].meanR, shift.shifted], [-1, true]);
});

test('index: leakage refused - a practice-validate, test, final or unscheduled decision, a plain pass included', () => {
  for (const [day, role] of [['2024-08-01', 'practice-validate'], ['2025-02-03', 'test'], ['2026-06-01', 'final'], ['2019-06-03', 'no role']]) {
    const ds = decisions(25, 12, () => 1);
    ds.push({ id: 'leak', day, decision: 'none', signatures: { skill: null, read: null } });
    assert.throws(() => X.buildIndex(ds), new RegExp(`leakage\\): 1 decision\\(s\\) in ${role}`), day);
  }
  // The line's own role label is never trusted: the day decides.
  const ds = decisions(25, 12, () => 1);
  ds[0] = { ...ds[0], day: '2025-02-03', role: 'practice-train' };
  assert.throws(() => X.buildIndex(ds), /leakage/);
  assert.throws(() => X.buildIndex([{ decision: 'passed', signatures: { skill: 'x' }, outcome: { R: 1 } }]), /without its day/);
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
  // A changed index is refused: the file, or the pin.
  const tampered = JSON.parse(fs.readFileSync(pinned.file, 'utf8'));
  tampered.cells[X.cellKey('skill', SKILL)].n = 999;
  fs.writeFileSync(pinned.file, JSON.stringify(tampered));
  assert.throws(() => X.loadPinned(run), /doesn't match its hash/);
  fs.writeFileSync(path.join(run, 'experience', 'pinned.json'), JSON.stringify({ file: '../x.json', hash: doc.hash }));
  assert.throws(() => X.loadPinned(run), /not an index file/);
});

test('scripts/experience-index.js: build from run homes, refuse leakage, show and pin', () => {
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
  fs.appendFileSync(path.join(runHome, 'experience', 'decisions.jsonl'), `${JSON.stringify({ id: 'z', day: '2025-03-03', decision: 'none' })}\n`);
  const leak = run(['build', runHome], { FTH_HOME: home });
  assert.strictEqual(leak.status, 1);
  assert.match(leak.stderr, /leakage/);
  assert.match(run(['build']).stderr, /usage/);
  assert.match(run(['build', runHome, '--seed']).stderr, /--seed: give its value/);
});

test('index: the latest decisions per skill signature as examples, compact, the why cut to 160 characters', () => {
  const ds = decisions(15, 12, i => i - 7);
  ds[14].reads = [{ step: 'bias', skill: 'bos-vs-choch', read: '1h bos up', why: 'x'.repeat(300), field: 'h1.lastBreak' }];
  const ex = X.buildIndex(ds, { reps: 50 }).examples[SKILL];
  assert.strictEqual(ex.length, 12);
  assert.ok(ex[0].day >= ex[11].day, 'latest first');
  const withReads = ex.find(e => e.reads.length);
  assert.deepStrictEqual(Object.keys(withReads.reads[0]), ['step', 'skill', 'read', 'why']);
  assert.strictEqual(withReads.reads[0].why.length, 160);
  assert.deepStrictEqual(Object.keys(ex[0]), ['day', 'decision', 'side', 'context', 'reads', 'R', 'grade']);
});
