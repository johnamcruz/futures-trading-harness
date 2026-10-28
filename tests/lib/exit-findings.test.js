'use strict';

// A probe round's exit findings (train/exit-findings.js): the champion's exits that cut a trend (flip-decided apart) or
// came late, owned by the open trade's read, ranked by the R they cost; the proposer's line shows no price or R.
const test = require('node:test');
const assert = require('node:assert');
const EF = require('../../scripts/lib/train/exit-findings');
const F = require('../../scripts/lib/train/findings');
const IR = require('../../scripts/lib/train/iteration-report');

const FACTS = { extreme: { failed: { level: 21450 } }, pushes: [{}], fading: false, pullback: { depth: 0.7 }, vwap: { distAtr: -0.3 }, ema20: { distAtr: -0.1 }, against: { '3m': { kind: 'CHoCH' }, '15m': null }, displacement: null, compression: {}, bias: { flipAgainst: false } };
const d = x => ({ exitBy: 'model-exit', cls: 'right', leftR: null, savedR: 1, late: false, flip: false, r: 1, peakR: 1.2, facts: FACTS, ...x });
const doc = decisions => ({ exits: { decisions, tightens: [{ stopped: true, cls: 'cut', flip: false }] } });

test('exitFindings: cut-trend, cut-trend-flip and late-exit, by cost; a right exit or a runner\'s cut is no finding', () => {
  const captures = [
    doc([d({ cls: 'cut', leftR: 2.5 }), d({ exitBy: 'model-stop', cls: 'cut', leftR: 1.5 }), d({ cls: 'cut', leftR: 4, flip: true }), d({})]),
    doc([d({ exitBy: 'runner-trail', cls: 'cut', leftR: 9 }), d({ exitBy: 'runner-trail', cls: 'right', late: true, r: 0.5, peakR: 3.5 }), d({ exitBy: 'initial-stop', cls: 'right' })]),
    { legs: [] }, null,
  ];
  const f = EF.exitFindings(captures);
  assert.deepStrictEqual(f.map(x => [x.code, x.count, x.cost, x.of]), [['cut-trend', 2, 4, 7], ['cut-trend-flip', 1, 4, 7], ['late-exit', 1, 2, 7]]);
  for (const x of f) assert.deepStrictEqual([x.kind, x.step, x.skill], [EF.KIND, 'target', EF.OWNER]);
  assert.strictEqual(f[0].detail, 'model-exit (1); model-stop (1)');
  assert.strictEqual(f[2].detail, 'runner-trail (1)');
  // Examples: the facts at the decision as words, the costliest first, no price.
  assert.match(f[0].examples[0], /^model-exit: new extreme failed; 1 push\(es\); pullback 70% of the impulse;/);
  for (const x of f) for (const e of x.examples) assert.doesNotMatch(e, /\d{4,}/);
  // max, and no owner skill in the tree: the finding stays, unowned.
  assert.strictEqual(EF.exitFindings(captures, { max: 1 }).length, 1);
  assert.strictEqual(EF.exitFindings(captures, { exists: () => false })[0].skill, null);
  assert.deepStrictEqual(EF.exitFindings([]), []);
});

test('exitTally: the summed scorecard of the captures; the round report and its status line show it', () => {
  const t = EF.exitTally([doc([d({ cls: 'cut', leftR: 2 }), d({})]), doc([d({ exitBy: 'runner-trail', cls: 'cut', leftR: 3 })])]);
  assert.deepStrictEqual([t.byExit['model-exit'].n, t.byExit['model-exit'].cut, t.byExit['runner-trail'].leftR, t.tightens.n], [2, 1, 3, 2]);
  const rec = IR.build({ probeReport: { iteration: 3, trend: { set: 's', batch: { index: 0, size: 2, trigger: 'x' }, probe: { days: [], legs: [] }, confirm: { days: [], legs: [] }, exits: t } } });
  assert.strictEqual(rec.trend.exits, t);
  assert.match(IR.line(rec), /; probe exits: model-exit 2 \(cut 1 2R left, right 1, late 0\), runner-trail 1 \(cut 1 3R left, right 0, late 0\); flip-decided 0 \(cut 0\); model tightens 2 \(stopped 2: cut 2, right 0\)/);
});

test('findingLine: an exit-decision finding names its class and who exited, never a price or an R', () => {
  const [f] = F.mergeFindings(EF.exitFindings([doc([d({ cls: 'cut', leftR: 2.5, flip: true })])]), []);
  assert.strictEqual(F.FINDING_KINDS.includes('exit-decision'), true);
  const line = F.findingLine(f);
  assert.match(line, /^F1\. pullback-vs-reversal: exit-decision at target: 1 of 1 scored exits were exits that cut a trend: price went on the trade's way after the exit before turning against it \(decided on an HTF bias flip against the trade\)\. By: model-exit \(1\)\n {3}- exit model-exit: /);
  assert.doesNotMatch(line, /\dR\b|\d{4,}/);
  const late = F.findingLine(F.mergeFindings(EF.exitFindings([doc([d({ late: true, r: 0, peakR: 3 })])]), [])[0]);
  assert.match(late, /exits that came late: open profit given back past the threshold before the exit/);
});
