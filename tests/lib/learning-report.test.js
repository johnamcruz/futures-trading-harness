'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const M = require('../../scripts/lib/learning/learning-report');
const X = require('../../scripts/lib/learning/experience-index');
const { fromLifecycleRecord } = require('../../scripts/lib/learning/lifecycle-record');
const { appendDecisions, logFile } = require('../../scripts/lib/learning/experience-log');
const { cycleExperienceLookups, writeCycleLog } = require('../../scripts/lib/cycle-log');
const { recordExperienceLookup } = require('../../scripts/lib/learning/experience-lookups');
const { record, tmpHome } = require('../fixtures/learning');

const base = fromLifecycleRecord(record());
const SIG = base.signatures.skill;
const ALT = 'bias:daily-bias+location:vwap-volume-profile+setup:rejection+entry:candle-reading+stop:invalidation+target:top-down-entry';

/** A composed decision (or a plain pass with decision 'none'). */
function d(day, decision, R, o = {}) {
  if (decision === 'none') return { id: `${day}-${o.i || 0}-n`, day, role: 'practice-train', decision, signatures: { skill: null, read: null }, reads: [], outcome: null, grade: null };
  const grade = decision === 'entered' ? (R > 0 ? 'win' : R < 0 ? 'loss' : 'scratch') : R === null ? 'neutral-pass' : R < 0 ? 'good-pass' : 'missed-win';
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
  assert.deepStrictEqual(m.passes, { good: 1, missed: 1, neutral: 1, goodRate: 0.5 });
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

test('following the record: entered above zero or passed below zero follows; the opposite is against; a spanning interval neutral', () => {
  const index = { hash: 'f'.repeat(64), cells: {
    [X.cellKey('skill', SIG)]: { enough: true, meanR: { lo: 0.1, hi: 0.9 } },
    [X.cellKey('skill', ALT, X.contextKey(base.context))]: { enough: true, meanR: { lo: -0.8, hi: -0.2 } },
    [X.cellKey('skill', 'thin')]: { enough: false },
  } };
  assert.strictEqual(M.followOf(d('2022-03-01', 'entered', 1), index), 'followed');
  assert.strictEqual(M.followOf(d('2022-03-01', 'passed', 1), index), 'against');
  assert.strictEqual(M.followOf(d('2022-03-01', 'passed', 1, { sig: ALT }), index), 'followed', 'the context cell first');
  assert.strictEqual(M.followOf(d('2022-03-01', 'entered', 1, { sig: ALT }), index), 'against');
  assert.strictEqual(M.followOf(d('2022-03-01', 'entered', 1, { sig: 'thin' }), index), 'no-evidence');
  assert.strictEqual(M.followOf(d('2022-03-01', 'entered', 1), null), 'no-evidence');
  index.cells[X.cellKey('skill', SIG)].meanR = { lo: -0.1, hi: 0.4 };
  assert.strictEqual(M.followOf(d('2022-03-01', 'entered', 1), index), 'neutral');
  const m = M.learningMeasures({ decisions: [d('2022-03-01', 'passed', 1, { sig: ALT }), d('2022-03-01', 'entered', 1, { sig: ALT, i: 1, bar: 'x' })], lookups: [{ root: 'MNQ', bar: '2022-03-01T14:00:00.000Z' }], index });
  assert.deepStrictEqual([m.record.all.followed, m.record.all.against, m.record.withLookup.followed, m.record.withLookup.against], [1, 1, 1, 0]);
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
