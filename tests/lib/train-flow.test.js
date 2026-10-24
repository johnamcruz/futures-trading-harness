'use strict';

// Propose-Probe-Compose's flow frame and reporting: the findings placed on the flow step they block (train/flow.js) and
// grouped so in the proposer's prompt; the probe halves written as curated lists of their own (train/probe-halves.js);
// the iteration's record (train/iteration-report.js); the lessons record with a role edit.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const FL = require('../../scripts/lib/train/flow');
const F = require('../../scripts/lib/train/findings');
const H = require('../../scripts/lib/train/probe-halves');
const IR = require('../../scripts/lib/train/iteration-report');
const LS = require('../../scripts/lib/train/lessons');
const SC = require('../../scripts/lib/train/screen');
const proposer = require('../../scripts/lib/train/proposer');
const CL = require('../../scripts/lib/learning/curated-lists');
const { READ_SKILL } = require('../../scripts/lib/learning/curated-moments');

const ROOT = path.resolve(__dirname, '..', '..');

test('the flow: the compose steps in order, then risk and execution; every editable role owns a step', () => {
  assert.deepStrictEqual(FL.FLOW_STEPS, ['bias', 'location', 'setup', 'entry', 'stop', 'target', 'risk', 'execution']);
  assert.deepStrictEqual(FL.FLOW_STEPS.slice(0, 6), Object.keys(READ_SKILL), 'the read steps are the crosswalk\'s own');
  assert.strictEqual(FL.flowLine(), 'bias -> location -> setup -> entry -> stop -> target -> risk -> execution');
  assert.deepStrictEqual(FL.stepsOfSkill('candle-reading'), ['setup', 'entry']);
  assert.deepStrictEqual(FL.stepsOfSkill('invalidation'), ['stop']);
  assert.deepStrictEqual(FL.stepsOfSkill('nope'), []);
});

test('stepOf: its own step first, then its skill\'s first step, then its role\'s; else none', () => {
  assert.strictEqual(FL.stepOf({ step: 'target', skill: 'invalidation' }), 'target');
  assert.strictEqual(FL.stepOf({ step: 'later', skill: 'invalidation' }), 'stop', 'an unknown step is not a step');
  assert.strictEqual(FL.stepOf({ skill: 'candle-reading' }), 'setup', 'the earliest step a skill reads at');
  assert.strictEqual(FL.stepOf({ skill: 'take-profit' }), 'target');
  assert.strictEqual(FL.stepOf({ agent: 'risk-manager' }), 'risk');
  assert.strictEqual(FL.stepOf({ agent: 'trade-executor' }), 'execution');
  assert.strictEqual(FL.stepOf({ agent: 'trade-reviewer' }), null);
  assert.strictEqual(FL.stepOf({ skill: 'not-a-read-skill' }), null);
  assert.strictEqual(FL.stepOf({ skill: null, kind: 'wrong-reason refusal' }), null);
  assert.strictEqual(FL.stepOf(null), null);
});

test('byStep: groups in flow order, the findings\' rank order kept inside a step, no step last', () => {
  const fs_ = [
    { id: 'F1', skill: 'take-profit' }, { id: 'F2', skill: 'multi-timeframe-analysis' }, { id: 'F3', skill: null },
    { id: 'F4', agent: 'risk-manager' }, { id: 'F5', skill: 'trend-vs-range' }, { id: 'F6', skill: 'invalidation' },
  ];
  assert.deepStrictEqual(FL.byStep(fs_).map(g => [g.step, g.findings.map(f => f.id)]), [['bias', ['F2', 'F5']], ['stop', ['F6']], ['target', ['F1']], ['risk', ['F4']], [null, ['F3']]]);
  assert.deepStrictEqual(FL.byStep([]), []);
});

test('findings carry their flow step; the ranking is unchanged by it (most first, a skill\'s kinds together)', () => {
  const skills = [
    { skill: 'take-profit', reads: 10, wrong: 5, missed: 0, relevant: 0, topRefusals: [], topMissed: [] },
    { skill: 'multi-timeframe-analysis', reads: 10, wrong: 2, missed: 1, relevant: 4, topRefusals: [], topMissed: [] },
    { skill: 'invalidation', reads: 10, wrong: 4, missed: 0, relevant: 0, topRefusals: [], topMissed: [] },
  ];
  const found = F.findingsFrom({ skills, refusals: [{ key: 'k', skills: [], falseReasons: [] }], max: 8 });
  assert.deepStrictEqual(found.map(f => [f.id, f.skill, f.kind, f.count, f.step]), [
    ['F1', 'take-profit', 'misread', 5, 'target'], ['F2', 'invalidation', 'misread', 4, 'stop'],
    ['F3', 'multi-timeframe-analysis', 'misread', 2, 'bias'], ['F4', 'multi-timeframe-analysis', 'missed', 1, 'bias'], ['F5', null, 'wrong-reason refusal', 1, null],
  ]);
  // A tie on the total: by name; a skill's own kinds, its larger count first.
  const tie = F.findingsFrom({ skills: [{ skill: 'b-skill', reads: 2, wrong: 1, missed: 2, relevant: 2, topRefusals: [], topMissed: [] }, { skill: 'a-skill', reads: 3, wrong: 3, missed: 0, relevant: 0, topRefusals: [], topMissed: [] }] });
  assert.deepStrictEqual(tie.map(f => [f.skill, f.kind]), [['a-skill', 'misread'], ['b-skill', 'missed'], ['b-skill', 'misread']]);
  assert.match(F.findingLine({ id: 'F9', agent: 'risk-manager', kind: 'wrong-reason refusal', count: 2 }), /^F9\. agent risk-manager: wrong-reason refusal: 2 refusal/);
});

test('the probe prompt frames the findings by the flow: the steps in order, each finding under the step it blocks', () => {
  const t = proposer.readProbeTemplate(ROOT);
  assert.ok(t.includes('{{FLOW}}'));
  assert.match(t, /Fix the earliest step first/);
  assert.match(t, /never makes you take a trade the facts don't support/);
  assert.match(t, /"Load the skills" sentence, its headings, its report formats/);
  const findings = [{ id: 'F1', skill: 'take-profit', kind: 'misread', count: 3, of: 9, detail: '', step: 'target' }, { id: 'F2', skill: 'multi-timeframe-analysis', kind: 'missed', count: 2, of: 4, detail: '', step: 'bias' }, { id: 'F3', skill: null, kind: 'wrong-reason refusal', count: 1, of: null, detail: '' }];
  const prompt = proposer.probePrompt({ template: t, findings, lessons: 'none yet', files: ['skills/take-profit/SKILL.md', 'agents/risk-manager.md'], k: 2 });
  assert.match(prompt, /A trade is built in this order: bias -> location -> setup -> entry -> stop -> target -> risk -> execution\./);
  const at = s => prompt.indexOf(s);
  assert.ok(at('Step bias:') < at('F2. multi-timeframe-analysis') && at('F2.') < at('Step target:') && at('Step target:') < at('F1. take-profit') && at('F1.') < at('No step (no read at the bar):') && at('No step') < at('F3.'), prompt);
  assert.match(prompt, /agents\/risk-manager\.md/);
  assert.doesNotMatch(prompt, /\{\{/);
  // The listed files: skills and the desk roles, never a rulebook, the reviewer or the loop's own skills.
  const files = proposer.editableFiles(ROOT);
  assert.ok(files.includes('agents/risk-manager.md') && files.includes('agents/trade-executor.md'));
  assert.ok(!files.some(f => /RULEBOOK\.md$|trade-reviewer|strategy-researcher|news-calendar|design-self-review/.test(f)), files.join(', '));
  const bad = t.replace('{{FLOW}}', '');
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'skills', 'design-self-review'), { recursive: true });
  fs.writeFileSync(path.join(dir, proposer.SKILL), `### The probe prompt\n\n\`\`\`text\n${bad}\n\`\`\`\n`);
  assert.throws(() => proposer.readProbeTemplate(dir), /the probe prompt has no \{\{FLOW\}\}/);
});

/** A curated lists document readLists accepts: two lists of moments over the given session dates. */
function listsDoc(days) {
  const moment = (day, i, list) => ({ id: `${list}-${day}-${i}`, day, list, window: { from: `${day}T14:00:00.000Z`, to: `${day}T14:30:00.000Z` } });
  const lists = Object.fromEntries(CL.LISTS.map(l => [l, []]));
  days.forEach((d, i) => { lists['trend-up'].push(moment(d, i, 'trend-up')); lists.chop.push(moment(d, i, 'chop')); });
  const doc = { v: 1, kind: 'curated-lists', builtAt: '2026-10-23T00:00:00.000Z', use: 'practice', role: 'practice-train', market: { roots: ['MNQ'], minutes: 3, setupTf: 15 }, seed: 1, options: {}, sources: [], lists, mix: [...lists['trend-up'].map(m => m.id), lists.chop[0].id], coverage: {} };
  return { ...doc, fingerprint: CL.fingerprintOf(doc) };
}

test('probe halves: each half a curated list of its own, its moments only, fingerprinted again and readable', () => {
  const days = ['2022-03-07', '2022-03-08', '2022-03-09', '2022-03-10', '2022-03-11', '2022-03-14', '2022-03-15', '2022-03-16', '2022-03-17', '2022-03-18'];
  const doc = listsDoc(days);
  const dir = tmpDir();
  const src = CL.writeLists(dir, doc);
  const seed = 3;
  const replay = { stage: 1, curatedList: { file: src, list: 'mix' }, practice: { mode: 'setup-focus' } };
  const out = {};
  for (const which of SC.HALVES) out[which] = H.halfReplay({ replay, which, seed, dir: path.join(dir, 'halves') });
  // Every session date in exactly one half, by the seeded hash; the two halves cover the source.
  assert.deepStrictEqual([...out.probe.days, ...out.confirm.days].sort(), days);
  assert.ok(out.probe.days.every(d => SC.halfOf(d, seed) === 'probe') && out.confirm.days.every(d => SC.halfOf(d, seed) === 'confirm'));
  for (const which of SC.HALVES) {
    const h = CL.readLists(out[which].replay.curatedList.file);
    assert.deepStrictEqual(h.half, { of: doc.fingerprint, which, seed, by: 'session date' });
    assert.notStrictEqual(h.fingerprint, doc.fingerprint);
    assert.ok(Object.values(h.lists).flat().every(m => SC.halfOf(m.day, seed) === which), which);
    assert.ok(h.mix.every(id => Object.values(h.lists).flat().some(m => m.id === id)), 'the mix holds only the half\'s moments');
    assert.deepStrictEqual(out[which].replay.practice, replay.practice, 'the rest of the replay config as given');
    // The mix: the trend-up moments of the half's days, and the one chop moment if its day is in the half.
    const chop0 = doc.lists.chop[0];
    assert.strictEqual(out[which].moments, out[which].days.length + (SC.halfOf(chop0.day, seed) === which ? 1 : 0));
  }
  // One list: only its moments count.
  assert.strictEqual(H.halfReplay({ replay: { ...replay, curatedList: { file: src, list: 'chop' } }, which: 'probe', seed, dir }).moments, out.probe.days.length);
  // A half with no moments writes nothing: the round is inconclusive before any run.
  const one = CL.writeLists(tmpDir(), listsDoc([days[0]]));
  const lone = SC.halfOf(days[0], seed) === 'probe' ? 'confirm' : 'probe';
  assert.deepStrictEqual(H.halfReplay({ replay: { ...replay, curatedList: { file: one, list: 'mix' } }, which: lone, seed, dir }), { replay: null, days: [], moments: 0, fingerprint: H.halfDoc(CL.readLists(one), lone, seed).fingerprint });
  assert.throws(() => H.halfReplay({ replay: { stage: 1 }, which: 'probe', seed, dir }), /probe.replay.curatedList/);
  assert.throws(() => H.halfDoc(doc, 'both', seed), /probe or confirm/);
  // A tampered half is refused by the reader, as any curated document.
  const f = out.probe.replay.curatedList.file;
  const t = JSON.parse(fs.readFileSync(f, 'utf8'));
  t.lists.chop.push(doc.lists.chop[0]);
  fs.writeFileSync(f, JSON.stringify(t));
  assert.throws(() => CL.readLists(f), /doesn't match its fingerprint/);
});

test('the iteration\'s record: proposed, screened, composed and kept, the deltas and the cycles, as one status line', () => {
  const probeReport = {
    iteration: 2, split: { seed: 3, probe: ['a', 'b'], confirm: ['c'] },
    findings: [{ id: 'F1', skill: 'take-profit', kind: 'misread', count: 3, step: 'target' }, { id: 'F2', agent: 'risk-manager', kind: 'wrong-reason refusal', count: 1, step: 'risk' }],
    edits: [{ id: 'e1', tag: { skill: 'take-profit', finding: 'F1', kind: 'rule' }, errors: [] }, { id: 'e2', tag: { agent: 'risk-manager', finding: 'F2', kind: 'rewording' }, errors: [] }, { id: null, tag: null, errors: ['not JSON'] }],
    probes: [{ id: 'e1', tag: { skill: 'take-profit' }, verdict: 'helped', harms: [], target: { pairs: 20 } }, { id: 'e2', tag: { agent: 'risk-manager' }, verdict: 'no effect', harms: [], target: { pairs: 14 } }],
    composition: { parts: ['e1'] },
    composed: { id: 'c1', verdict: 'helped', cancelled: [], measures: { reads: { pairs: 12, b: 3, c: 1 }, process: { pairs: 12, b: 2, c: 0 }, target: { pairs: 8, b: 4, c: 0 }, r: { pairs: 12, diff: 0.1, lo: -0.05, hi: 0.2 } } },
    cycles: { champion: { probe: 30, confirm: 20 }, edits: { e1: 30, e2: 30 }, composed: 20 },
  };
  const rec = IR.build({ probeReport, entries: [{ iteration: 2, proposalId: 'c1', verdict: 'rejected', reasons: ['(a) 1 blow'], composition: {} }] });
  assert.deepStrictEqual(rec.proposed.map(p => [p.id, p.target, p.step, p.refused]), [['e1', 'take-profit', 'target', null], ['e2', 'agent risk-manager', 'risk', null], [null, '?', null, ['not JSON']]]);
  assert.deepStrictEqual(rec.screened.map(s => [s.target, s.verdict, s.n]), [['take-profit', 'helped', 20], ['agent risk-manager', 'no effect', 14]]);
  assert.deepStrictEqual(rec.kept, { proposalId: 'c1', verdict: 'rejected', reasons: ['(a) 1 blow'] });
  assert.deepStrictEqual(rec.deltas, { reads: { fixed: 3, broken: 1, pairs: 12 }, process: { fixed: 2, broken: 0, pairs: 12 }, target: { fixed: 4, broken: 0, pairs: 8 }, rPerDecision: { diff: 0.1, lo: -0.05, hi: 0.2, pairs: 12 }, capture: null });
  assert.deepStrictEqual(rec.split, { seed: 3, probe: 2, confirm: 1 });
  assert.strictEqual(IR.line(rec), 'iteration 2: proposed 3 (1 refused), screened helped 1, no effect 1; combined c1 helped; keep rule rejected; confirm deltas: reads +3/-1 of 12, process +2/-0 of 12, R/decision 0.1; cycles: champion 50, edits 60, combined 20');
  // A round that stopped early: nothing composed, the keep rule not run, the reason said.
  const early = IR.build({ probeReport: { iteration: 3, why: 'no edit passed the screen', edits: [], probes: [], cycles: { champion: { probe: 30 }, edits: {} } }, entries: [] });
  assert.strictEqual(IR.line(early), 'iteration 3: proposed 0 (0 refused), screened none; combined none; keep rule not run; cycles: champion 30, edits 0, combined 0; no edit passed the screen');
  assert.strictEqual(IR.build({}).iteration, null);
});

test('the lessons record takes a role edit, grouped by its role', () => {
  const file = path.join(tmpDir(), LS.FILE);
  const windows = [{ from: '2022-03-07', to: '2022-03-19' }];
  LS.appendLesson(file, { proposalId: 'r1', iteration: 1, agent: 'risk-manager', kind: 'rewording', findingKind: 'wrong-reason refusal', windows, verdict: 'helped', n: 12 });
  LS.appendLesson(file, { proposalId: 's1', iteration: 1, skill: 'take-profit', kind: 'rule', findingKind: 'misread', windows, verdict: 'hurt', n: 9 });
  assert.throws(() => LS.appendLesson(file, { proposalId: 'x', iteration: 1, kind: 'rule', windows, verdict: 'helped', n: 1 }), /skill \(or agent\) and kind/);
  const sum = LS.summarize(LS.readLessons(file));
  assert.match(sum, /- agent risk-manager, rewording \(wrong-reason refusal\): helped 1 of 1/);
  assert.match(sum, /- take-profit, rule \(misread\): helped 0 of 1, no effect 0, hurt 1/);
});
