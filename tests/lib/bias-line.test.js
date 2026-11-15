'use strict';

// The briefing's Bias line (scripts/lib/trading/bias-line.js): the side the shipped entry rule (BG) allows, from the
// entry rule's own check, so the line and the gate never disagree.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { RULE, biasSides, biasLine } = require('../../scripts/lib/trading/bias-line');
const { entryRuleOf } = require('../../scripts/lib/trading/entry-rule');
const { TRAIL_RULE } = require('../../scripts/lib/trading/composed-reads');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { briefingOfFacts, shippedAllows } = require('../fixtures/bias-bg/facts-briefing');

const ROOT = path.join(__dirname, '..', '..');
const ROWS = require('../fixtures/bias-bg/census-bars.json').rows;
const SHIPPED = entryRuleOf(loadStrategies(ROOT, {}).strategies.find(s => s.name === 'prop_portfolio').entry);

// A bar with the facts the rule reads: trend signs and, for the declared trend, a close past VWAP, EMA20 and the open.
const DECLARED_UP = { c: 21510, atr: 10, vwap: 21500, ema20: 21505, open: 21490, regime: 'trend-up' };
const bar = (h4, h1, t15, extra = {}) => briefingOfFacts({ h4, h1, t15, ...DECLARED_UP, ...extra });

test('the line\'s rule is the shipped one the trail target reads (BG on the chain\'s bias frames)', () => {
  assert.deepStrictEqual(RULE, TRAIL_RULE);
  assert.ok(RULE.biasNeutral && RULE.biasFrames.join() === '4h,1h');
});

test('Bias: one side when the 4h and 1h trend it, none when they disagree or one is unknown', () => {
  assert.strictEqual(biasLine(bar(-1, -1, -1)), 'Bias: short only (4h down, 1h down; long refused)');
  assert.strictEqual(biasLine(bar(1, 0, -1)), 'Bias: long only (4h up, 1h range; short refused)');
  assert.strictEqual(biasLine(bar(1, -1, 1)), 'Bias: no side (4h up, 1h down) → no entry');
  assert.strictEqual(biasLine(bar(null, 1, 1)), 'Bias: no side (the 4h trend not in the briefing) → no entry');
  assert.deepStrictEqual(biasSides(bar(1, -1, 1)), { long: false, short: false });
});

test('Bias: both ranging, the 15m and the declared trend set it; without the declared trend, no side yet', () => {
  assert.strictEqual(biasLine(bar(0, 0, 1)), 'Bias: neutral → 15m up + declared long → long only');
  assert.strictEqual(biasLine(bar(0, 0, -1)), 'Bias: no side yet (15m down, declared short: no)');
  assert.strictEqual(biasLine(bar(0, 0, 0)), 'Bias: no side yet (15m range)');
  assert.strictEqual(biasLine(bar(0, 0, 1, { regime: 'range' })), 'Bias: no side yet (15m up, declared long: no)');
  const noFacts = bar(0, 0, 1);
  delete noFacts.sections.m3.data.declared;
  assert.strictEqual(biasLine(noFacts), 'Bias: no side yet (15m up, declared long: unknown)');
});

test('the line\'s rule is the rulebook\'s prop_portfolio entry (every key but the lane check); a changed rulebook fails it', () => {
  const strip = ({ entryLane, ...r }) => r; // eslint-disable-line no-unused-vars
  assert.deepStrictEqual(strip(RULE), strip(SHIPPED));
  const entry = loadStrategies(ROOT, {}).strategies.find(s => s.name === 'prop_portfolio').entry;
  for (const changed of [{ bias_agree: 'on' }, { bias_frames: ['4h'] }, { regime_against: 'on' }, { leg_turned: 'on' }, { chain: '1h' }]) {
    assert.notDeepStrictEqual(strip(RULE), strip(entryRuleOf({ ...entry, ...changed })), JSON.stringify(changed));
  }
});

test('Bias: off the chain\'s entry frame (the 3m) the gate refuses every prop entry: no side is said', () => {
  const b = bar(-1, -1, -1);
  b.minutes = 1;
  assert.strictEqual(biasLine(b), 'Bias: no prop entry on this lane (the chain enters on the 3m)');
  for (const side of ['long', 'short']) assert.strictEqual(shippedAllows(SHIPPED, b, side).allowed, false, side);
});

test('Bias: no line on a briefing without the 1h part (a frame\'s own)', () => {
  const b = bar(1, 1, 1);
  delete b.sections.h1;
  assert.strictEqual(biasLine(b), null);
  assert.strictEqual(biasLine(null), null);
});

test('parity: on the BG census fixture the Bias line\'s side is the gate\'s verdict on every bar (0 disagreements)', () => {
  const off = [];
  for (const r of ROWS) {
    const b = briefingOfFacts(r);
    const line = biasLine(b);
    const said = (/^Bias: (?:neutral → .* → )?(long|short) only/.exec(line) || [])[1] || null;
    for (const side of ['long', 'short']) {
      const gate = shippedAllows(SHIPPED, b, side).allowed;
      if (gate !== (said === side)) off.push(`${r.bar} ${side}: gate ${gate}, line "${line}"`);
    }
  }
  assert.deepStrictEqual(off, []);
  assert.ok(ROWS.length === 200);
});
