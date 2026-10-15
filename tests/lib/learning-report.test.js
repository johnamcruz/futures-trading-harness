'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const M = require('../../scripts/lib/learning/learning-report');
const X = require('../../scripts/lib/learning/experience-index');
const { fromLifecycleRecord } = require('../../scripts/lib/learning/lifecycle-record');
const { appendDecisions, logFile, gradeOf } = require('../../scripts/lib/learning/experience-log');
const { cycleExperienceLookups, writeCycleLog } = require('../../scripts/lib/cycle-log');
const { recordExperienceLookup } = require('../../scripts/lib/learning/experience-lookups');
const { record, tmpHome } = require('../fixtures/learning');

const base = fromLifecycleRecord(record());
const SIG = base.signatures.skill;
const ALT = 'bias:daily-bias+location:vwap-volume-profile+setup:rejection+entry:candle-reading+stop:invalidation+target:top-down-entry';

/** A composed decision (or a plain pass with decision 'none'). */
function d(day, decision, R, o = {}) {
  if (decision === 'none') return { id: `${day}-${o.i || 0}-n`, day, role: 'practice-train', decision, signatures: { skill: null, read: null }, reads: [], outcome: null, grade: null };
  const grade = gradeOf(decision, { R });
  return {
    id: `${day}-${o.i || 0}-${decision}`, day, role: 'practice-train', root: 'MNQ', bar: o.bar || `${day}T14:00:00.000Z`, decision, side: 'long',
    signatures: { skill: o.sig || SIG, read: base.signatures.read }, context: base.context, reads: o.reads || base.reads,
    outcome: { R }, grade,
  };
}

test('measures: decisions, steps, skills per trade, verified reads, diversity, passes', () => {
  const decisions = [
    d('2022-03-01', 'entered', 2), d('2022-03-01', 'passed', -1, { i: 1 }), d('2022-03-01', 'none', null),
    d('2022-03-02', 'entered', -1, { sig: ALT, reads: base.reads.slice(0, 3) }), d('2022-03-02', 'passed', 1.5, { i: 1 }), d('2022-03-02', 'refused', null, { i: 2 }),
  ];
  const records = [record(), record({ ok: false })].map(fromLifecycleRecord);
  records[1].reads[0].check = 'false';
  const m = M.learningMeasures({ decisions, records, lookups: [] });
  assert.deepStrictEqual(m.decisions, { total: 6, composed: 5, entered: 2, passed: 2, refused: 1, none: 1 });
  assert.deepStrictEqual(m.steps, { mean: 5.4, allSix: 4 });
  assert.strictEqual(m.skillsPerTrade, 4.5, 'six skills, then three');
  assert.deepStrictEqual(m.reads, { reads: 12, verified: 11, rate: 0.9167, records: 2, recordsOk: 1 });
  assert.deepStrictEqual([m.diversity.signatures, m.diversity.top, m.diversity.topShare, m.diversity.collapsed], [2, SIG, 0.8, false]);
  assert.ok(m.diversity.entropy > 0.7 && m.diversity.entropy < 0.73);
  assert.deepStrictEqual(m.passes, { good: 1, missed: 1, neutral: 0, goodRate: 0.5 }, 'the refusal is not a pass');
  assert.deepStrictEqual(m.refusals, { wouldLose: 0, wouldWin: 0, neutral: 1 });
  // Collapse: ten or more composed decisions, 80% or more on one combination.
  const many = Array.from({ length: 10 }, (_, i) => d('2022-03-03', 'passed', -1, { i }));
  assert.deepStrictEqual([M.learningMeasures({ decisions: many }).diversity.collapsed, M.learningMeasures({ decisions: many }).diversity.entropy], [true, 0]);
});

test('measures: the per-day curve with its rolling window, pass quality and lookups', () => {
  const days = ['2022-03-01', '2022-03-02', '2022-03-03', '2022-03-04', '2022-03-07', '2022-03-08'];
  const decisions = days.flatMap((day, k) => [d(day, 'entered', k < 3 ? -1 : 2), d(day, 'passed', k % 2 ? -1 : 1, { i: 1 })]);
  const lookups = [{ root: 'MNQ', bar: '2022-03-08T14:00:00.000Z' }];
  const m = M.learningMeasures({ decisions, lookups });
  assert.strictEqual(m.curve.length, 6);
  assert.deepStrictEqual(m.curve.map(c => c.meanR), [-1, -1, -1, 2, 2, 2]);
  assert.deepStrictEqual(m.curve.map(c => c.rollingMeanR), [-1, -1, -1, -0.25, 0.2, 0.8], 'the last five days pooled');
  assert.deepStrictEqual(m.curve.map(c => c.passQuality), [0, 1, 0, 1, 0, 1]);
  assert.deepStrictEqual(m.curve.map(c => c.lookups), [0, 0, 0, 0, 0, 1]);
  assert.deepStrictEqual(m.lookups, { calls: 1, decisions: 2, rate: 0.1667 });
});

/** n past decisions over 12 February 2022 days, R each, in a context. */
function past(n, sig, R, ctx = base.context, tag = sig) {
  const days = ['01', '02', '03', '04', '07', '08', '09', '10', '11', '14', '15', '16'].map(x => `2022-02-${x}`);
  return Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}`, bar: `${days[i % 12]}T15:00:00.000Z`, decision: 'passed', signatures: { skill: sig, read: 'r' }, context: ctx, outcome: { R } }));
}

test('following the record: both the context cell and the any-context cell, before the decision\'s day, must agree', () => {
  const other = { ...base.context, regime: 'range' };
  const MIXED = 'bias:mixed';
  const index = X.buildIndex([...past(25, SIG, 1), ...past(25, ALT, -1), ...past(25, MIXED, -1, base.context, 'm1'), ...past(25, MIXED, 3, other, 'm2'), ...past(5, 'thin', 1)], { reps: 300 });
  assert.strictEqual(M.followOf(d('2022-03-01', 'entered', 1), index), 'followed');
  assert.strictEqual(M.followOf(d('2022-03-01', 'passed', 1), index), 'against');
  assert.strictEqual(M.followOf(d('2022-03-01', 'passed', 1, { sig: ALT }), index), 'followed');
  assert.strictEqual(M.followOf(d('2022-03-01', 'entered', 1, { sig: ALT }), index), 'against');
  assert.strictEqual(M.followOf(d('2022-03-01', 'entered', 1, { sig: MIXED }), index), 'neutral', 'this context below zero, any context above');
  assert.strictEqual(M.followOf(d('2022-03-01', 'entered', 1, { sig: 'thin' }), index), 'no-evidence');
  assert.strictEqual(M.followOf(d('2022-03-01', 'entered', 1), null), 'no-evidence');
  assert.strictEqual(M.followOf(d('2022-02-01', 'entered', 1), index), 'no-evidence', 'walk-forward: nothing before its day');
  const m = M.learningMeasures({ decisions: [d('2022-03-01', 'passed', 1, { sig: ALT }), d('2022-03-01', 'entered', 1, { sig: ALT, i: 1, bar: 'x' })], lookups: [{ root: 'MNQ', bar: '2022-03-01T14:00:00.000Z' }], index });
  assert.deepStrictEqual([m.record.all.followed, m.record.all.against, m.record.withLookup.followed, m.record.withLookup.against], [1, 1, 1, 0]);
});

test('frame: the owner\'s default frame against the others, overall and by context, in the report', () => {
  const other = { ...base.context, regime: 'range' };
  const oth = base.reads.map(r => (r.step === 'bias' ? { ...r, read: '4h up' } : r));
  const decisions = [
    d('2022-03-01', 'entered', 2), d('2022-03-01', 'passed', -1, { i: 1 }),
    { ...d('2022-03-01', 'entered', -1, { i: 2, reads: oth }), context: other },
    { ...d('2022-03-01', 'passed', 1, { i: 3, reads: oth }), frame: 'other' },
    d('2022-03-01', 'none', null),
  ];
  const m = M.learningMeasures({ decisions });
  const all = m.frames.find(r => r.context === 'all');
  assert.deepStrictEqual(all.default, { decisions: 2, meanR: 0.5, taken: 1, takenMeanR: 2, takenWinRate: 1 });
  assert.deepStrictEqual(all.other, { decisions: 2, meanR: 0, taken: 1, takenMeanR: -1, takenWinRate: 0 });
  const range = m.frames.find(r => r.context === 'regime=range');
  assert.deepStrictEqual([range.default.decisions, range.other.decisions, range.other.takenMeanR], [0, 1, -1]);
  assert.ok(m.frames.some(r => r.context === 'biasSide=with'));
  assert.match(M.learningMarkdown(m), /\| all \| 2, 0\.50, 1, 2\.00, 1\.00 \| 2, 0\.00, 1, -1\.00, 0\.00 \|/);
});

test('the gate\'s refusals are counted apart from the model\'s passes', () => {
  const m = M.learningMeasures({ decisions: [d('2022-03-01', 'passed', -1), d('2022-03-01', 'refused', -1, { i: 1 }), d('2022-03-01', 'refused', 2, { i: 2 }), d('2022-03-01', 'refused', null, { i: 3 })] });
  assert.deepStrictEqual(m.passes, { good: 1, missed: 0, neutral: 0, goodRate: 1 });
  assert.deepStrictEqual(m.refusals, { wouldLose: 1, wouldWin: 1, neutral: 1 });
  assert.strictEqual(m.curve[0].passQuality, 1, 'pass quality is the model\'s own');
  assert.match(M.learningMarkdown(m), /the gate's refusals apart: 1 would have lost, 1 would have won, 1 neutral/);
  assert.match(M.learningMarkdown(M.learningMeasures({ decisions: [], indexError: 'the pinned index is not an index file' })), /index unreadable: the pinned index is not an index file/);
});


test('readLearning and the report text: from a run home; none without an experience log; the cycle log keeps the lookups', () => {
  const home = tmpHome();
  assert.strictEqual(M.readLearning(home), null);
  appendDecisions(logFile(home), [d('2022-03-01', 'entered', 2), d('2022-03-01', 'none', null)]);
  fs.mkdirSync(path.join(home, 'logs'));
  const transcript = path.join(home, 'logs', 'cycle-transcript-1.jsonl');
  recordExperienceLookup({ FTH_CYCLE_TRANSCRIPT: transcript }, { role: null, root: 'MNQ', bar: '2022-03-01T14:00:00.000Z', side: 'long' }, 5);
  // The cycle log keeps them on its line (writeCycleLog), and removes their file.
  const logged = writeCycleLog(home, { at: new Date('2022-03-01T15:00:00Z'), action: 'trade', harness: 'x', prompt: 'p', transcript });
  assert.deepStrictEqual(logged.summary.experienceLookups.map(l => [l.at, l.root]), [[5, 'MNQ']]);
  assert.ok(!fs.existsSync(`${transcript}.experience.jsonl`), 'its file goes with the cycle');
  assert.deepStrictEqual(cycleExperienceLookups(transcript), [], 'read once');
  fs.appendFileSync(path.join(home, 'logs', 'cycles-2022-03-01.jsonl'), '{torn\n');
  // A cycle without a lookup carries no key.
  assert.strictEqual(writeCycleLog(home, { at: new Date('2022-03-01T15:03:00Z'), action: 'trade', harness: 'x', prompt: 'p', transcript }).summary.experienceLookups, undefined);
  const r = M.readLearning(home);
  assert.deepStrictEqual([r.decisions.length, r.lookups.length, r.index, r.indexError], [2, 1, null, null]);
  const m = M.learningMeasures(r);
  assert.match(M.learningText(m), /^learning: 1 composed \(1 entered, 0 passed, 0 refused\), 1 plain passes; .*lookups 1 \(1\.00 of composed\)/);
  const md = M.learningMarkdown(m);
  assert.match(md, /^## Learning\n/);
  assert.match(md, /\| 2022-03-01 \| practice-train \| 2 \| 1 \| 2\.00 \| 1\.00 \| 2\.00 \| 1\.00 \| - \| 1 \| 0 \/ 0 \|/);
  assert.match(md, /index none pinned/);
});

test('scripts/replay.js: experience writes the log, and report adds the learning measures', () => {
  const { spawnSync } = require('child_process');
  const { runDir } = require('../fixtures/learning');
  const t0 = '2023-03-15T14:00:00.000Z';
  const { home, dir } = runDir({ times: [t0], records: [record({ at: t0 })], barRows: [[100.5, 100.75, 99.75, 100.25], [100.25, 104.5, 100, 104.25]] });
  const cli = path.join(__dirname, '..', '..', 'scripts', 'replay.js');
  const env = { ...process.env, FTH_HOME: tmpHome(), FTH_ENV_FILE: path.join(home, 'none.env') };
  const ex = spawnSync(process.execPath, [cli, 'experience', dir], { encoding: 'utf8', env });
  assert.strictEqual(ex.status, 0, ex.stderr);
  assert.match(ex.stdout, /experience: 1 decision\(s\) added, 0 already logged \(practice-train\)/);
  const rep = spawnSync(process.execPath, [cli, 'report', dir], { encoding: 'utf8', env });
  assert.strictEqual(rep.status, 0, rep.stderr);
  assert.match(rep.stdout, /learning: 1 composed \(0 entered, 1 passed, 0 refused\)/);
  assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /## Learning\n/);
});
