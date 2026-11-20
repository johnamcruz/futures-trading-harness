'use strict';

// P1 (feat/p1-mtf-entries): the Part B-style read check of the MTF candidate lines (scripts/lib/eval/mtf-readcheck.js),
// run with the model before any trading replay: the probe asks a field-by-field report; the scorer rebuilds each field
// from the cycle's MTF record (mtf-entry.js candidatesOf, the code that prints the lines), never from the text, and grades
// the report field by field; the bar is >= 95% per field. Covers the measured weak spots (#348): READY (a waiting model
// is not ready), VOID (stop traded: no entry), WAITING, and the below line (the 15m decides).

const test = require('node:test');
const assert = require('node:assert/strict');
const RC = require('../../scripts/lib/eval/mtf-readcheck');
const ME = require('../../scripts/lib/trading/mtf-entry');
const F = require('../fixtures/mtf-entry');

const mode = F.MODE('A');
const rec = F.record();
const exp = RC.expected(rec, mode, { price: 21540.25 });

test('the probe names every field once, in order, "FIELD: value" lines; reason first', () => {
  const p = RC.probe();
  for (const f of RC.FIELDS) assert.equal(p.split('\n').filter(l => l.startsWith(`${f}:`)).length, 1, f);
  assert.match(p, /^Read the MTF lines/);
  assert.match(p, /reason first/i);
});

test('expected: rebuilt from the record (the chosen candidate\'s facts; waiting, void and the below line\'s rule)', () => {
  assert.deepEqual(exp, {
    SIDE: 'long', READY: 'aggressive', STAGE: 'WEAKENING', EARLY: 'no', TRIGGER: '3m CHoCH', TRIGGER_AGE: '0', DRIFT_R: '0',
    TURN: 'none', BOS_SINCE: 'none', IMPULSE_ATR: 'none', DISPLACED: 'none', CLEANNESS: 'none', RANK: '1', DEPTH: 'moderate',
    STOP: '21528.75', PER_CONTRACT: '24.24', WAITING: '3m balanced needs a 3m BOS up', VOID: 'no', PULLBACK_DECIDED_BY: '15m',
  });
  // A void candidate: READY none, VOID yes; a waiting one: its clause.
  const v = RC.expected(F.record({ withheld: 'stop traded' }), mode, { price: 21540.25 });
  assert.deepEqual([v.READY, v.VOID, v.STOP], ['none', 'yes', 'none']);
  const est = F.record({ stage: 'ESTABLISHED' });
  est.levels[0].entry = null;
  const w = RC.expected(est, mode, { price: 21540.25 });
  assert.deepEqual([w.READY, w.WAITING], ['none', '3m aggressive needs a 3m CHoCH or CISD up']);
});

test('grade: a right report passes every field; numbers within their rounding; words case- and markup-free', () => {
  const report = Object.entries(exp).map(([k, v]) => `${k}: ${v}`).join('\n');
  const g = RC.grade(`Reason: the chosen line.\n${report}`, exp);
  assert.deepEqual(Object.values(g.fields).filter(x => !x.ok).map(x => x.field), []);
  // The model's own gloss and a #: "RANK: #1", "SIDE: long (1h structure UP)".
  const glossed = report.replace('RANK: 1', 'RANK: #1').replace('SIDE: long', 'SIDE: long (1h structure UP)');
  assert.equal(Object.values(RC.grade(glossed, exp).fields).every(x => x.ok), true);
  const loose = report.replace('STOP: 21528.75', 'STOP: 21,528.75').replace('READY: aggressive', 'READY: **Aggressive**').replace('PER_CONTRACT: 24.24', 'PER_CONTRACT: $24.24');
  assert.equal(Object.values(RC.grade(loose, exp).fields).every(x => x.ok), true);
});

test('a waiting clause with "or" in it is not a hedge; EARLY with no candidate is none (the probe says so); TURN says older for a CHoCH older than the previous session (the line\'s word), recent otherwise', () => {
  const est = F.record({ stage: 'ESTABLISHED' });
  est.levels[0].entry = null;
  const w = RC.expected(est, mode, { price: 21540.25 });
  assert.equal(w.WAITING, '3m aggressive needs a 3m CHoCH or CISD up');
  const g = RC.grade(Object.entries(w).map(([k, v]) => `${k}: ${v}`).join('\n'), w);
  assert.deepEqual(Object.values(g.fields).filter(x => !x.ok).map(x => x.field), []);
  assert.equal(w.EARLY, 'none');
  assert.match(RC.probe(), /EARLY: <yes or no for the chosen candidate; none without one>/);
  const old = F.record({ extra: {} });
  old.levels[0].parent.turn = { way: 'up', choch: { kind: 'CHoCH', at: '2026-10-01T14:00:00.000Z', et: '10-01 10:00' }, bos: { at: '2026-10-01T15:00:00.000Z', et: '10-01 11:00' }, since: null, bosCount: 1 };
  assert.equal(RC.expected(old, mode, { price: 21540.25, at: '2026-10-07T14:00:00.000Z' }).TURN, 'older');
  assert.equal(RC.expected(old, mode, { price: 21540.25, at: '2026-10-02T14:00:00.000Z' }).TURN, 'recent');
});

test('grade (adversarial): a waiting model read as ready, a void read as live, the 3m line read as deciding, a missing field, a wrong last line, a hedge: each fails its field only', () => {
  const report = o => Object.entries({ ...exp, ...o }).map(([k, v]) => `${k}: ${v}`).join('\n');
  const bad = (o, field) => {
    const g = RC.grade(report(o), exp);
    assert.deepEqual(Object.values(g.fields).filter(x => !x.ok).map(x => x.field), [field], JSON.stringify(o));
  };
  bad({ READY: 'balanced' }, 'READY');
  bad({ VOID: 'yes' }, 'VOID');
  bad({ PULLBACK_DECIDED_BY: '3m' }, 'PULLBACK_DECIDED_BY');
  bad({ STOP: '21529.25' }, 'STOP');
  bad({ RANK: '2' }, 'RANK');
  bad({ READY: 'aggressive or balanced' }, 'READY');
  bad({ READY: 'unclear' }, 'READY');
  bad({ DRIFT_R: '0.5' }, 'DRIFT_R');
  bad({ TRIGGER_AGE: '3' }, 'TRIGGER_AGE');
  bad({ DEPTH: 'deep' }, 'DEPTH');
  const missing = RC.grade(report({}).split('\n').filter(l => !l.startsWith('TRIGGER:')).join('\n'), exp);
  assert.deepEqual(Object.values(missing.fields).filter(x => !x.ok).map(x => x.field), ['TRIGGER']);
  const twice = RC.grade(`${report({})}\nREADY: balanced`, exp);
  assert.deepEqual(Object.values(twice.fields).filter(x => !x.ok).map(x => x.field), ['READY'], 'the last line given is the answer: a wrong last READY fails');
  // A "FIELD: ..." line inside the reasoning, then the report: the report's (last) line is graded.
  const reasoned = RC.grade(`VOID: no, there is no candidate to be void\n${report({})}`, exp);
  assert.deepEqual(Object.values(reasoned.fields).filter(x => !x.ok).map(x => x.field), []);
  // The waiting clause copied with its label.
  const labelled = RC.grade(report({ WAITING: `MTF waiting: ${exp.WAITING}.` }), exp);
  assert.deepEqual(Object.values(labelled.fields).filter(x => !x.ok).map(x => x.field), []);
});

test('summarize: per-field share over answers and the bar (>= 95% per field: each field must clear it)', () => {
  const report = Object.entries(exp).map(([k, v]) => `${k}: ${v}`).join('\n');
  const good = RC.grade(report, exp);
  const badReady = RC.grade(report.replace('READY: aggressive', 'READY: balanced'), exp);
  const s = RC.summarize([...Array(19).fill(good), badReady]);
  assert.equal(s.fields.READY.share, 0.95);
  assert.equal(s.pass, true);
  const s2 = RC.summarize([...Array(18).fill(good), badReady, badReady]);
  assert.equal(s2.fields.READY.share, 0.9);
  assert.equal(s2.pass, false);
  assert.deepEqual(s2.failing, ['READY']);
  assert.equal(RC.BAR, 0.95);
  assert.equal(RC.summarize([]).pass, false, 'no answers: no pass');
});

test('the expected fields come from the code that prints the lines (candidatesOf), never the text: a record and its lines agree', () => {
  const lines = ME.candidateLines(rec, mode, { price: 21540.25, sizing: rec.sizing });
  assert.ok(lines[0].includes(`structural stop ${exp.STOP}`));
  for (const part of [Number(exp.DRIFT_R) < 0 ? `${-Number(exp.DRIFT_R)}R back toward the stop` : `ran ${exp.DRIFT_R}R past the trigger`, `depth 45% (${exp.DEPTH})`, '(new this bar);']) assert.ok(lines[0].includes(part), part);
  assert.ok(lines[0].includes(`$${exp.PER_CONTRACT} a contract all in`));
  assert.ok(lines[0].includes(`${exp.READY} at stage ${exp.STAGE}`));
});

test('the read check grades a number with its own unit ("0R", "0 min"); the candidate fields are scoped to the chosen candidate in the probe (Part B on 1118a6fb5, disclosed post-hoc)', () => {
  const report = Object.entries({ ...exp, DRIFT_R: '0R', TRIGGER_AGE: '0 min' }).map(([k, v]) => `${k}: ${v}`).join('\n');
  assert.deepEqual(Object.values(RC.grade(report, exp).fields).filter(x => !x.ok).map(x => x.field), []);
  for (const f of ['TRIGGER_AGE', 'DRIFT_R', 'DEPTH']) assert.match(RC.probe(), new RegExp(`${f}: <the chosen candidate.*none without a candidate>$`, 'm'), f);
});

test('DEPTH on a candidate whose depth is not printed ("depth not known"): unknown or not known reads as none (a post-hoc normalisation, the coordinator\'s ruling after Part B); with no candidate, or any other field, it stays a miss; no DEPTH line stays a miss', () => {
  const exp = { SIDE: 'long', READY: 'aggressive', DEPTH: 'none' };
  const line = v => `SIDE: long\nREADY: aggressive\nDEPTH: ${v}`;
  for (const v of ['unknown', 'not known', 'Unknown.', '**not known**']) assert.equal(RC.grade(line(v), exp).fields.DEPTH.ok, true, v);
  assert.equal(RC.grade(line('none'), exp).fields.DEPTH.ok, true);
  assert.equal(RC.grade(line('moderate'), exp).fields.DEPTH.ok, false);
  assert.equal(RC.grade(line('unclear'), exp).fields.DEPTH.ok, false);
  assert.equal(RC.grade('SIDE: long\nREADY: aggressive', exp).fields.DEPTH.ok, false, 'no DEPTH line');
  assert.equal(RC.grade(line('unknown'), { ...exp, READY: 'none' }).fields.DEPTH.ok, false, 'no candidate: none is the answer');
  assert.equal(RC.grade('READY: aggressive\nRANK: unknown', { READY: 'aggressive', RANK: 'none' }).fields.RANK.ok, false, 'only DEPTH');
});
