'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const A = require('../../scripts/lib/learning/available-reads');
const { checkReads, parseRead } = require('../../scripts/lib/trading/composed-reads');
const { briefingFrom } = require('../../scripts/lib/learning/skill-usage');
const { BARS, ROOT } = require('../fixtures/decision-path');

// The parity bars (tests/fixtures/parity/NQ-3m.csv): the 14:00 UTC bar of 2026-04-23 (the 15m trend up, the 3m bar
// closed at its top after a 3m CHoCH up) and the 18:06 bar (a 1h CHoCH down).
const at = briefingFrom(BARS, { root: 'MNQ', minutes: 3, count: 1400 });
const A_BAR = '2026-04-23T14:00:00.000Z';
const R_BAR = '2026-04-23T18:06:00.000Z';
const clone = x => JSON.parse(JSON.stringify(x));

test('available reads: every read kept is TRUE by the checker, once each, with its crosswalk skill; the false ones are left out', () => {
  const b = at('MNQ', A_BAR);
  const reads = A.trueReads(b, 'long');
  assert.ok(reads.length > 20, reads.length);
  assert.strictEqual(new Set(reads.map(r => r.form)).size, reads.length, 'once each');
  for (const r of reads) {
    const c = checkReads({ reads: [{ step: r.step, skill: 'x', read: r.read }], side: 'long', briefing: b }).reads[0];
    assert.strictEqual(c.check, true, `${r.step}: ${r.read} (${c.fact})`);
    assert.strictEqual(r.skill, A.skillOfRead(r.step, r.read));
  }
  const forms = reads.map(r => r.form);
  for (const f of ['15m up', '3m choch up', 'vwap below', 'at vwap rth', '4h broke 15m fvg high up', '3m close top', '3m momentum up', 'stop 3m low 26970', 'target 3m swing 27102.75']) assert.ok(forms.includes(f), f);
  // A candidate the briefing states but the checker finds FALSE is not kept (the 3m bar closed at its top, not its bottom).
  assert.ok(A.candidateReads(b, 'long').entry.includes('3m momentum up') && A.candidateReads(b, 'short').entry.includes('3m momentum down'));
  assert.ok(!A.trueReads(b, 'short').some(r => r.form === '3m momentum down'));
  assert.ok(!forms.includes('15m down') && !forms.includes('3m close bottom'));
});

test('available reads: agreement as the checker settles it: a read pointing the other way is true but not agreeing; a stop and target by their side', () => {
  const b = at('MNQ', A_BAR);
  const short = A.trueReads(b, 'short');
  const of = (list, form) => list.find(r => r.form === form);
  assert.deepStrictEqual([of(short, '15m up').agrees, of(short, '3m choch up').agrees, of(short, 'vwap below').agrees], [false, false, true]);
  assert.strictEqual(of(A.trueReads(b, 'long'), '15m up').agrees, true);
  // A stop under a long's price agrees with the long; the same level as a short's target agrees too (below price).
  assert.strictEqual(of(A.trueReads(b, 'long'), 'stop 3m low 26970').agrees, true);
  assert.ok(A.trueReads(b, 'long').filter(r => r.step === 'target').every(r => (r.agrees ? r.dir === 'long' : r.dir !== 'long')));
});

test('available reads: D2: a trend read against the side agrees when a 1h CHoCH the side\'s way holds its tier, and not without it', () => {
  const b = clone(at('MNQ', R_BAR));
  assert.ok(A.trueReads(b, 'short').some(r => r.form === '1h choch down' && r.agrees));
  b.sections.h1.data.h1.trend = 'up';
  assert.strictEqual(A.trueReads(b, 'short').find(r => r.form === '1h up').agrees, true, 'the 1h tier: a 1h CHoCH');
  b.sections.h1.data.lastBreak.last.kind = 'BOS';
  assert.strictEqual(A.trueReads(b, 'short').find(r => r.form === '1h up').agrees, false, 'no CHoCH: against');
});

test('available reads: availableSkills groups the true reads by skill, and pullback-vs-reversal from the shape', () => {
  const r = A.availableSkills(at('MNQ', R_BAR), 'short');
  assert.ok(r.get(A.SHAPE_SKILL).agreeing.some(x => x.read === 'reversal'));
  assert.ok(r.get('bos-vs-choch').agreeing.some(x => x.form === '1h choch down'));
  // The 14:00 bar's only CHoCH is a 3m one: a shift on the trigger frame, no reversal.
  const a = A.availableSkills(at('MNQ', A_BAR), 'long');
  assert.ok(a.get('bos-vs-choch').agreeing.some(x => x.form === '3m choch up'));
  assert.strictEqual(a.get(A.SHAPE_SKILL), undefined);
});

test('available reads: shapeOf: a 15m or 1h CHoCH the side\'s way is a reversal; trend, pullback read and rejection a pullback; else none', () => {
  const r = (step, read, o = {}) => ({ step, read, check: true, agrees: true, ...o });
  assert.strictEqual(A.shapeOf([r('bias', '1h choch down')], 'short'), 'reversal');
  assert.strictEqual(A.shapeOf([r('bias', '15m choch up')], 'long'), 'reversal');
  assert.strictEqual(A.shapeOf([r('bias', '3m choch up')], 'long'), null);
  assert.strictEqual(A.shapeOf([r('bias', '1h choch up')], 'short'), null);
  assert.strictEqual(A.shapeOf([r('bias', '1h choch down', { check: false })], 'short'), null);
  const pb = [r('bias', '1h up'), r('bias', 'read long pullback'), r('setup', '15m rejected prior vah up')];
  assert.strictEqual(A.shapeOf(pb, 'long'), 'pullback');
  for (let i = 0; i < pb.length; i += 1) assert.strictEqual(A.shapeOf(pb.filter((_, j) => j !== i), 'long'), null, `without ${pb[i].read}`);
  assert.strictEqual(A.shapeOf([...pb.slice(0, 2), r('setup', '15m broke prior vah up')], 'long'), null);
});

test('available reads: READ_SKILL is the trade-lifecycle crosswalk: each skill in its step\'s row; the no-read skills its size and management rows', () => {
  const text = fs.readFileSync(path.join(ROOT, 'skills', 'trade-lifecycle', 'SKILL.md'), 'utf8');
  const rows = Object.fromEntries(text.split('\n').filter(l => /^\s*\| [a-z]+ \|/.test(l)).map(l => {
    const c = l.split('|').map(x => x.trim());
    return [c[1], [...c[3].matchAll(/`([a-z0-9-]+)`/g)].map(m => m[1])];
  }));
  for (const [step, kinds] of Object.entries(A.READ_SKILL)) for (const s of Object.values(kinds)) assert.ok(rows[step].includes(s), `${step}: ${s}`);
  assert.deepStrictEqual(A.NO_READ_SKILLS, { size: rows.size, management: rows.management });
  // Every skill of the read rows is reached by a read kind or the shape.
  const reached = new Set([...Object.values(A.READ_SKILL).flatMap(k => Object.values(k)), A.SHAPE_SKILL]);
  assert.deepStrictEqual(['bias', 'location', 'setup', 'entry', 'stop', 'target'].flatMap(s => rows[s]).filter(s => !reached.has(s)), []);
  // skillOfRead: a gap's edge and zone are fair-value-gaps; touched has no skill of its own; a kind out of its step none.
  assert.deepStrictEqual(['15m rejected 15m fvg low up', 'at 15m fvg', '15m touched prior vah', 'vwap below'].map((x, i) => A.skillOfRead(['setup', 'location', 'setup', 'setup'][i], x)), ['fair-value-gaps', 'fair-value-gaps', null, null]);
  assert.strictEqual(parseRead('swept equal highs').kind, 'swept');
  assert.strictEqual(A.skillOfRead('setup', 'swept equal highs'), 'breakout-vs-fakeout');
});
