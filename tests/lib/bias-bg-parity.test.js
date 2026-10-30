'use strict';

// The data confirmation of the shipped entry rule (bias_agree: neutral-15m-declared, BG): on census decision bars the
// pre-registered alignment study classified (PREREG-C; 200 bars stratified by their 4h/1h/15m/declared cell, from the
// B0 census plans and the S2 momentum candidates), the shipped rule (the RULEBOOK's prop_portfolio entry, on a
// briefing built with the shipped trend-declared.js) allows exactly the bars the study's BG allows. The scratch full
// run of the same check over every one of the study's 5,949 bars found 0 disagreements.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { entryRuleOf } = require('../../scripts/lib/trading/entry-rule');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { briefingOfFacts, shippedAllows } = require('../fixtures/bias-bg/facts-briefing');

const ROOT = path.join(__dirname, '..', '..');
const ROWS = require('../fixtures/bias-bg/census-bars.json').rows;
const SHIPPED = entryRuleOf(loadStrategies(ROOT, {}).strategies.find(s => s.name === 'prop_portfolio').entry);
const ruleOf = v => entryRuleOf({ bias_frames: ['4h', '1h'], bias_agree: v, regime_against: 'off', leg_turned: 'off' });

/** The study's DECLARED and BG (the study's classification), restated on the raw facts: the fixture's labels are checked against it. */
function study(r) {
  const s = r.side === 'long' ? 1 : -1;
  const fin = x => typeof x === 'number' && Number.isFinite(x);
  const d = level => (fin(level) ? (s * (r.c - level)) / r.atr : null);
  const v = d(r.vwap), e = d(r.ema20), o = d(r.open);
  const dec = r.regime === (s > 0 ? 'trend-up' : 'trend-down') && v !== null && e !== null && o !== null && v > 0 && e > 0 && o > 0;
  if (r.h4 !== 0 || r.h1 !== 0) return r.h4 !== -s && r.h1 !== -s && (r.h4 === s || r.h1 === s);
  return r.t15 === s && dec;
}
const allowsAll = rule => ROWS.map(r => shippedAllows(rule, briefingOfFacts(r), r.side).allowed);

test('the fixture: 200 census bars, every label the study\'s BG, both sources and every kind of cell present', () => {
  assert.strictEqual(ROWS.length, 200);
  for (const r of ROWS) assert.strictEqual(r.studyBG, study(r), r.bar);
  assert.ok(ROWS.some(r => r.src === 'census') && ROWS.some(r => r.src === 'mom'));
  const cell = r => (r.h4 === 0 && r.h1 === 0 ? 'neutral' : 'trending');
  for (const k of ['neutral', 'trending']) for (const want of [true, false]) assert.ok(ROWS.some(r => cell(r) === k && r.studyBG === want), `${k} ${want}`);
});

test('parity: the shipped entry rule allows exactly the bars the study\'s BG allows (every one of the 200)', () => {
  assert.ok(SHIPPED && SHIPPED.biasNeutral, 'the shipped rule is neutral-15m-declared');
  const got = allowsAll(SHIPPED);
  const off = ROWS.filter((r, i) => got[i] !== r.studyBG).map(r => `${r.bar} ${r.side} ${r.h4}/${r.h1}/${r.t15}`);
  assert.deepStrictEqual(off, []);
});

test('the fixture tells the rules apart: strict, off, and BG without the declared check each disagree with the study', () => {
  const differs = rule => allowsAll(rule).filter((a, i) => a !== ROWS[i].studyBG).length;
  assert.ok(differs(ruleOf('on')) > 0, 'strict');
  assert.ok(differs(ruleOf('off')) > 0, 'off');
  // BG with every neutral bar's declared facts read as declared (the declared check removed) lets bars the study refuses.
  const noDeclared = ROWS.filter(r => r.h4 === 0 && r.h1 === 0 && r.t15 === (r.side === 'long' ? 1 : -1) && !r.studyBG);
  assert.ok(noDeclared.length > 0, 'neutral bars with the 15m the side\'s way but not declared');
});
