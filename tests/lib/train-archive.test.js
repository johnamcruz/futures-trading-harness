'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const A = require('../../scripts/lib/train/archive');

const proposal = { targets: ['wrong stated reason'], expects: 'fewer wrong reasons', why: 'decisions 1-3', edits: [{ file: 'skills/a/SKILL.md', find: 'old ```x```', replace: 'new' }] };
const tests = effect => ({ pairs: 20, target: { b: 10, c: 0, effect, pBetter: 0.001 }, harm: { 'bad size': { b: 0, c: 0, pWorse: 1 } }, blows: 0 });
const entry = (over = {}) => ({
  iteration: 1, proposalId: 'abc123def456', proposal, files: ['skills/a/SKILL.md', 'workspace/opencode.json'], verdict: 'kept', reasons: ['fixed 10'],
  tests: tests(0.5), windows: [{ from: '2022-03-07', to: '2022-03-12' }], panel: { flagged: 3, control: 2, points: [] }, repeats: 3, seed: 7, baseCommit: 'c0ffee', evaluator: { available: false, why: 'step 9' }, ...over,
});

test('the archive: append-only lines, each with its proposal, verdict and what reproduces it; a bad entry refused', () => {
  const file = path.join(tmpDir(), 'archive.jsonl');
  assert.deepStrictEqual(A.readArchive(file), []);
  A.appendEntry(file, entry());
  A.appendEntry(file, entry({ proposalId: 'zzz', verdict: 'rejected' }));
  const all = A.readArchive(file);
  assert.deepStrictEqual(all.map(e => [e.v, e.proposalId, e.verdict, e.seed, e.repeats, e.baseCommit]), [[1, 'abc123def456', 'kept', 7, 3, 'c0ffee'], [1, 'zzz', 'rejected', 7, 3, 'c0ffee']]);
  assert.throws(() => A.appendEntry(file, { proposalId: 'x' }), /names its proposalId, iteration and verdict/);
  assert.throws(() => A.appendEntry(file, { proposalId: 'x', iteration: 1 }), /names its proposalId, iteration and verdict/);
  assert.strictEqual(A.judgedBefore(all, 'zzz').verdict, 'rejected');
  assert.strictEqual(A.judgedBefore(all, 'nope'), null);
  assert.strictEqual(A.judgedBefore([{ ...all[0], phase: 'held-out' }], 'abc123def456'), null, 'a held-out entry is not a tuning verdict');
  fs.appendFileSync(file, '{torn\n');
  assert.throws(() => A.readArchive(file), /line 3 is unreadable/);
});

test('leaders: the kept change with the largest effect per targeted category', () => {
  const l = A.leaders([entry({ proposalId: 'a', tests: tests(0.2) }), entry({ proposalId: 'b', tests: tests(0.4) }), entry({ proposalId: 'c', verdict: 'rejected', tests: tests(0.9) }),
    entry({ proposalId: 'd', proposal: { ...proposal, targets: ['bad size'] }, tests: tests(0.1) })]);
  assert.deepStrictEqual(l.map(x => [x.category, x.proposalId]), [['wrong stated reason', 'b'], ['bad size', 'd']]);
});

test('prBody: what changed, the paired result, what was not run, and the checks before merging', () => {
  const body = A.prBody(entry(), { loopId: 'l1' });
  assert.match(body, /## Training loop: wrong stated reason \(abc123def456\)/);
  assert.match(body, /judged by code \(the paired re-run\), not by the model that proposed it/);
  assert.match(body, /- `skills\/a\/SKILL\.md`/);
  assert.doesNotMatch(body.split('```text')[1], /```x```/, 'a fence inside the edit is neutralised');
  assert.match(body, /Generated adapters regenerated[^\n]*1 file/);
  assert.match(body, /fixed 10, broke 0, effect 0\.5/);
  assert.match(body, /Evaluator \(step 9\): not run \(step 9\)/);
  assert.match(body, /Held-out judging: not done/);
  assert.match(body, /- \[ \] `npm run verify` passes/);
  assert.match(body, /- \[ \] The owner approves/);
  assert.doesNotMatch(body, /\n{3,}/);
});
