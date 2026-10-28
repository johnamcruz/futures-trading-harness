'use strict';

// A probe round's exit findings (train/exit-findings.js): the champion's exits that cut a trend (flip-decided apart) or
// came late, owned by the open trade's read, ranked by the R they cost; the proposer's line shows no price or R.
const test = require('node:test');
const assert = require('node:assert');
const EF = require('../../scripts/lib/train/exit-findings');
const F = require('../../scripts/lib/train/findings');
const IR = require('../../scripts/lib/train/iteration-report');

const FACTS = { extreme: { best: 21455 }, failed: { level: 21450, swing: 21440 }, pushes: [{}], fading: false, pullback: { depth: 0.7 }, vwap: { distAtr: -0.3 }, ema20: { distAtr: -0.1 }, against: { '3m': { kind: 'CHoCH' }, '15m': null }, displacement: null, compression: {}, bias: { flipAgainst: false } };
const d = x => ({ exitBy: 'model-exit', cls: 'right', leftR: null, savedR: 1, late: false, flip: false, r: 1, peakR: 1.2, facts: FACTS, ...x });
const doc = decisions => ({ exits: { decisions, tightens: [{ stopped: true, cls: 'cut', flip: false }] } });

test('exitFindings: only what the model decided: cut-trend, cut-trend-flip and late-exit, by cost; the runner\'s trail and the target never', () => {
  const captures = [
    doc([d({ cls: 'cut', leftR: 2.5 }), d({ exitBy: 'model-stop', cls: 'cut', leftR: 1.5 }), d({ cls: 'cut', leftR: 4, flip: true }), d({})]),
    // The runner's trail (its cut and its late give-back), the target and the runner's close are the report's rows only.
    doc([d({ exitBy: 'runner-trail', cls: 'cut', leftR: 9 }), d({ exitBy: 'runner-trail', cls: 'right', late: true, lateR: 5, r: 0.5, peakR: 3.5 }), d({ exitBy: 'target', cls: 'cut', leftR: 6 }),
      d({ exitBy: 'runner-exit', cls: 'right', late: true, lateR: 3 }),
      // An initial stop that then ran the trade's way is the stop's placement, never a finding; a hold that gave back past
      // the threshold to the initial stop (the runner's trail never armed) is the model's late exit.
      d({ exitBy: 'initial-stop', cls: 'cut', leftR: 7 }), d({ exitBy: 'initial-stop', cls: 'right', late: true, lateR: 2, r: -1, peakR: 2.5 })]),
    { legs: [] }, null,
  ];
  const f = EF.exitFindings(captures);
  assert.deepStrictEqual(f.map(x => [x.code, x.count, x.cost, x.of]), [['cut-trend', 2, 4, 6], ['cut-trend-flip', 1, 4, 6], ['late-exit', 1, 2, 6]]);
  assert.deepStrictEqual(EF.MODEL_DECIDED, new Set(['model-exit', 'model-stop', 'initial-stop']));
  for (const x of f) assert.deepStrictEqual([x.kind, x.step, x.skill], [EF.KIND, 'target', EF.OWNER]);
  // Owned by the skills that decide the class: a cut trend by the read and the action, a late exit by the profit-taking too.
  assert.deepStrictEqual(f.map(x => x.skills), [['pullback-vs-reversal', 'manage-position'], ['pullback-vs-reversal', 'manage-position'], ['pullback-vs-reversal', 'manage-position', 'take-profit']]);
  assert.deepStrictEqual(EF.exitFindings(captures, { exists: s => s !== 'pullback-vs-reversal' }).map(x => [x.skill, x.skills.length]), [['manage-position', 1], ['manage-position', 1], ['manage-position', 2]], 'a skill not in the tree is no owner');
  assert.strictEqual(f[0].detail, 'model-exit (1); model-stop (1)');
  assert.strictEqual(f[2].detail, 'initial-stop (1)');
  // Examples: the facts at the decision as words, the costliest first, no price.
  assert.match(f[0].examples[0], /^model-exit: the last push failed \(a lower high or higher low\); 1 push\(es\); pullback 70% of the impulse;/);
  for (const x of f) for (const e of x.examples) assert.doesNotMatch(e, /\d{4,}/);
  // max, and no owner skill in the tree: the finding stays, unowned.
  assert.strictEqual(EF.exitFindings(captures, { max: 1 }).length, 1);
  assert.deepStrictEqual([EF.exitFindings(captures, { exists: () => false })[0].skill, EF.exitFindings(captures, { exists: () => false })[0].skills], [null, []]);
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
  assert.match(line, /^F1\. pullback-vs-reversal or manage-position: exit-decision at target: 1 of 1 scored exits were exits that cut a trend: price went on the trade's way after the exit before turning against it \(decided on an HTF bias flip against the trade\)\. By: model-exit \(1\)\n {3}- exit model-exit: /);
  assert.doesNotMatch(line, /\dR\b|\d{4,}/);
  const late = F.findingLine(F.mergeFindings(EF.exitFindings([doc([d({ late: true, lateR: 1.5, r: 0, peakR: 3 })])]), [])[0]);
  assert.match(late, /^F1\. pullback-vs-reversal or manage-position or take-profit: exit-decision at target: .*exits that came late: open profit given back past the threshold before the exit/);
});

test('tagErrors: an exit finding takes an edit to any skill it lists, never another; read findings keep their one owner', () => {
  const PE = require('../../scripts/lib/train/probe-edit');
  const findings = F.mergeFindings(EF.exitFindings([doc([d({ cls: 'cut', leftR: 2.5 }), d({ late: true, lateR: 1.5, r: 0, peakR: 3 })])]), [
    { kind: 'missed', skill: 'rejection', count: 2, of: 5 }, { kind: 'misread', skill: 'manage-position', skills: ['take-profit'], count: 1, of: 1 },
  ]);
  const byCode = c => findings.find(f => f.code === c).id;
  const tag = (skill, finding) => ({ skill, finding, kind: 'rule' });
  const prop = skill => ({ edits: [{ file: `skills/${skill}/SKILL.md`, find: 'a', replace: 'b' }] });
  const errs = (skill, finding) => PE.tagErrors(tag(skill, finding), prop(skill), { findings });
  for (const s of EF.OWNERS['late-exit']) assert.deepStrictEqual(errs(s, byCode('late-exit')), [], s);
  for (const s of EF.OWNERS['cut-trend']) assert.deepStrictEqual(errs(s, byCode('cut-trend')), [], s);
  assert.match(errs('take-profit', byCode('cut-trend')).join(';'), /is about pullback-vs-reversal or manage-position, not take-profit/, 'an unlisted skill refused');
  assert.match(errs('rejection', byCode('late-exit')).join(';'), /is about pullback-vs-reversal or manage-position or take-profit, not rejection/);
  assert.match(PE.tagErrors({ agent: 'risk-manager', finding: byCode('late-exit'), kind: 'rule' }, { edits: [{ file: 'agents/risk-manager.md', find: 'a', replace: 'b' }] }, { findings }).join(';'), /is about pullback-vs-reversal or manage-position or take-profit, not agent risk-manager/, 'never a role');
  // One file per edit still.
  assert.match(PE.tagErrors(tag('manage-position', byCode('late-exit')), { edits: [...prop('manage-position').edits, ...prop('take-profit').edits] }, { findings }).join(';'), /one document only/);
  // A read finding: its one skill only (a list on a read finding is ignored).
  const read = findings.find(f => f.kind === 'missed').id;
  assert.deepStrictEqual(errs('rejection', read), []);
  assert.match(errs('manage-position', read).join(';'), /is about rejection, not manage-position/);
  assert.match(errs('take-profit', findings.find(f => f.kind === 'misread').id).join(';'), /is about manage-position, not take-profit/);
});

test('tagErrors: an exit finding with no owner skill in the tree takes no edit, of any skill or role', () => {
  const PE = require('../../scripts/lib/train/probe-edit');
  const findings = F.mergeFindings(EF.exitFindings([doc([d({ cls: 'cut', leftR: 2.5 })])], { exists: () => false }), []);
  assert.deepStrictEqual([findings[0].skill, findings[0].skills], [null, []]);
  for (const s of ['a', 'manage-position', 'pullback-vs-reversal']) {
    assert.match(PE.tagErrors({ skill: s, finding: 'F1', kind: 'rule' }, { edits: [{ file: `skills/${s}/SKILL.md`, find: 'a', replace: 'b' }] }, { findings }).join(';'), /names no owner skill in the tree/, s);
  }
  assert.match(PE.tagErrors({ agent: 'risk-manager', finding: 'F1', kind: 'rule' }, { edits: [{ file: 'agents/risk-manager.md', find: 'a', replace: 'b' }] }, { findings }).join(';'), /names no owner skill in the tree/);
});

test('manage-position still never owns a read finding', () => {
  assert.ok(F.NOT_PROBED.has('manage-position'));
  const row = skill => ({ skill, wrong: 9, reads: 9, topRefusals: [], missed: 9, relevant: 9, topMissed: [] });
  const usage = [row('manage-position'), row('rejection')];
  const found = F.findingsFrom({ skills: usage, refusals: [{ skills: ['manage-position'], falseReasons: ['x'] }], max: 8, exists: () => true });
  assert.ok(found.some(f => f.skill === 'rejection'), 'the read skill is found');
  assert.ok(found.every(f => f.skill !== 'manage-position' && !(f.skills || []).includes('manage-position')), JSON.stringify(found));
});
