'use strict';

// P1 (feat/p1-mtf-entries): the mtf-entry read checks, run with the model before any trading replay. The items live
// outside the gated quiz (tests/fixtures/quiz/mtf-entry-items.json; config/context-quiz.json stays at 113): reading each
// context fact off a real candidate line, strong-vs-weak pairs, the rules (never against the 1h; a stage word alone is not
// an order; waiting and void lines), and the scenarios (read the context, choose the entry option). Each is a valid
// closed-choice item asked against the head prompt plus mtf-entry (lookup), each anchor in that prompt, each printed line
// the module's own on the goal fixture's and the MTF fixtures' real bars (no drift), and graded strictly (the adversarial cases below).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Q = require('../../scripts/lib/eval/context-quiz');

const ROOT = path.join(__dirname, '..', '..');
const ITEMS = require('../fixtures/quiz/mtf-entry-items.json');
const qs = ITEMS.questions;

test('the mtf-entry items: about 28 (the facts the selection reads and the selection rules), each valid, asked with mtf-entry looked up, each anchor in its prompt, each answer anchored on present skill text', () => {
  assert.ok(qs.length >= 26 && qs.length <= 34, String(qs.length));
  assert.deepEqual(qs.map(q => q.id), qs.map((_, i) => `me${i + 1}`));
  const gated = Q.loadQuiz().value;
  const ids = new Set();
  for (const q of qs) {
    assert.deepEqual(Q.questionErrors(q, { part: 'questions', at: q.id, ids, gate: gated.gate }), [], q.id);
    assert.deepEqual([q.prompt, q.lookup], ['lookup', ['mtf-entry']], q.id);
    assert.match(q.text, /MTF (candidate|structure|waiting)/, `${q.id}: prints real lines`);
  }
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'mtf-entry', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  for (const q of qs) assert.ok(skill.includes(q.anchor.replace(/\s+/g, ' ')), `${q.id}: its anchor is mtf-entry's own text`);
  const quiz = { ...gated, questions: qs, partB: [] };
  assert.deepEqual(Q.anchorsMissing(quiz, Q.buildPrompts(ROOT, quiz)), []);
  // The kinds the owner asked for, each present.
  const kinds = { pairs: qs.filter(q => /^Two real MTF candidate lines/.test(q.text)).length, scenarios: qs.filter(q => /Which (entry )?option fits/.test(q.text)).length };
  // The selection focus (the owner, 2026-11-18): no strong-vs-weak pairs or pullback-quality scenarios; the rules are asked.
  assert.ok(kinds.pairs === 0 && kinds.scenarios >= 2, JSON.stringify(kinds));
  // The owner's decision (2026-11-18): the three entries and the structure; no fib zone, golden zone, draw, premium or
  // discount anywhere; the structural depth class (the spec's) stays; the rank is a fact, never a preference.
  assert.ok(!qs.some(q => /golden zone|0\.382|0\.618|room to the next|premium|discount|break against/i.test(q.text + q.answer + q.rule + q.choices.join(' '))), 'no removed fact in an item');
  for (const re of [/its age/, /in the trigger's R/, /over 0\.5R the candidate is void/, /depth alone is not an entry signal/, /The rank is a fact, not a preference/]) assert.ok(qs.some(q => re.test(q.anchor)), String(re));
  for (const re of [/never against it/, /A stage word alone is not an order/, /not ready, not an entry/, /A void one says so plainly/, /15m line decides the pullback/i, /WAIT keeps an active candidate/, /PASS rejects this opportunity/, /a void candidate stays void/, /eligibility, not an obligation/, /The last such line counts/]) assert.ok(qs.some(q => re.test(q.anchor)), String(re));
});

test('the gated quiz is unchanged in size: 113 items, none of the mtf-entry items in it', () => {
  const gated = Q.loadQuiz().value;
  assert.equal(gated.questions.length, 113);
  assert.ok(!gated.questions.some(q => /^me\d+$/.test(q.id)));
});

test('the items cannot drift: every MTF line an item prints is the REAL briefing\'s at that bar (buildBriefing + renderBriefing on the 514 h window; arm A, minStage potential, prev_high_or_trail)', () => {
  const GF = require('../../scripts/lib/eval/goal-fixture');
  const B = require('../../scripts/lib/trading/briefing');
  const ME = require('../../scripts/lib/trading/mtf-entry');
  const DOC = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'goal', 'bars.json.gz'))));
  const mode = ME.modeOf({ arm: 'A', exitMode: 'prev_high_or_trail', minStage: 'potential' }, {}, { isReplay: () => true });
  const et = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)).replace(',', '');
  const wanted = new Set(qs.flatMap(q => [...q.text.matchAll(/\((?:real, )?(\d{4}-\d\d-\d\d \d\d:\d\d) ET/g)].map(m => m[1])));
  const at = new Map();
  // The goal fixture's blocks and the four real MTF fixtures (the strong-context lines come from 2022-04-18).
  const extra = ['2022-03-07', '2022-04-11', '2022-04-25', '2022-07-12'].map(d => GF.decodeBars(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'mtf-structure', `${d}.json.gz`)))).bars));
  for (const bars of [...DOC.blocks.map(b => GF.decodeBars(b.bars)), ...extra]) {
    bars.forEach((bar, j) => {
      const key = et(Date.parse(bar.t) + 180000);
      if (!wanted.has(key)) return;
      const t = Date.parse(bar.t);
      const now = new Date(t + 180000);
      const w = bars.filter((x, k) => k <= j && Date.parse(x.t) >= t - DOC.historyHours * 3600000);
      const text = B.renderBriefing(B.buildBriefing({ symbol: 'MNQ', bars: w, minutes: 3, now, mtfMode: mode }), { now });
      // A session in more than one block (other history before it) prints from each: every block's lines count.
      at.set(key, [...(at.get(key) || []), ...text.split('\n').filter(l => l.startsWith('- MTF'))]);
    });
  }
  const drift = [];
  for (const q of qs) {
    const one = /^Briefing lines \(real, (\S+ \S+) ET\)/.exec(q.text);
    if (one) for (const l of q.text.split('\n').filter(x => x.startsWith('- MTF'))) if (!(at.get(one[1]) || []).includes(l)) drift.push(`${q.id}: ${l.slice(0, 80)}`);
    for (const m of q.text.matchAll(/^[AB] \((\S+ \S+) ET\): (.+)$/gm)) if (!(at.get(m[1]) || []).includes(`- ${m[2]}`)) drift.push(`${q.id}: ${m[2].slice(0, 80)}`);
  }
  assert.deepEqual(drift, []);
});

test('grading is strict (adversarial): reason first then the choice passes; another choice, two choices, a hedge, the choice in reasoning only, or a wrong last line fails', () => {
  const quiz = { ...Q.loadQuiz().value, questions: qs, partB: [] };
  for (const q of qs) {
    const wrong = q.choices.find(c => c !== q.answer);
    const g = a => Q.gradeAnswer(quiz, q, a);
    assert.equal(g(`Reason: the line says so.\nANSWER: ${q.answer}`).pass, true, `${q.id}: right`);
    assert.equal(g(`Reason: ${q.answer}.\nANSWER: ${wrong}`).pass, false, `${q.id}: the reasoning names the answer, the answer line another`);
    assert.equal(g(`ANSWER: ${q.answer}; ${wrong}`).pass, false, `${q.id}: two choices on one line`);
    assert.equal(g(`ANSWER: ${q.answer}\nANSWER: ${wrong}`).pass, false, `${q.id}: the last answer line decides`);
    assert.equal(g('ANSWER: it depends on the read').pass, false, `${q.id}: a hedge`);
    assert.equal(g(`Reason: ${q.answer}`).pass, false, `${q.id}: no answer line`);
  }
});
