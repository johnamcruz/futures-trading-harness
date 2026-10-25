'use strict';

// The compression reads (composed-reads.js): `<tf> compression break up|down` (setup, timed from its expansion candle),
// `<tf> box at <level>` (location) and `stop <tf> box low|high <price>`, verified against m3.compression
// (compression.js); the hints list them only when TRUE (compose-hints.js); the findings credit them to the skill.

const test = require('node:test');
const assert = require('node:assert');
const CR = require('../../scripts/lib/trading/composed-reads');
const H = require('../../scripts/lib/trading/compose-hints');
const { skillOfRead } = require('../../scripts/lib/learning/curated-moments');
const { scenario1 } = require('../fixtures/trade-lifecycle-scenario');

// The scenario's 15m candle closed 14:45 and its 3m candle 15:00 (price 21540.25): a 15m box 21514-21530 under the prior
// VAH, left by a 15m expansion candle that closed 14:45 above it.
const BOX = { high: 21530, low: 21514, width: 16, widthAtr: 1.2, flavor: 'inside', flavors: ['inside'], insideStack: 2, atr: 13.33, pole: null, from: '2026-04-23T13:00:00.000Z', to: '2026-04-23T14:30:00.000Z', levels: [{ name: 'prior VAH', price: 21530.13, edge: 'top' }] };
const BREAK = { dir: 'up', closedAt: '2026-04-23T14:45:00.000Z', close: 21541, rangeAtr: 2.4, beyondAtr: 0.83, volVsBox: 2.1, expansion: true, withPole: false, barsAgo: 0, backInside: false, beyondNow: true, runAtr: 0, late: false };
function briefing(c15 = { state: 'expanding', box: BOX, break: BREAK }, c3 = { state: 'neither', box: null, break: null }) {
  const b = scenario1();
  b.sections.m3.data.atr14 = 13.33;
  b.sections.m3.data.compression = { '3m': c3, '5m': 'unavailable (not whole 3m bars; no 1m bars configured)', '15m': c15, '1h': { state: 'neither', box: null, break: null } };
  return b;
}
const READS = [
  { step: 'bias', skill: 'bos-vs-choch', read: '1h bos up' },
  { step: 'location', skill: 'compression', read: '15m box at prior vah' },
  { step: 'setup', skill: 'compression', read: '15m compression break up' },
  { step: 'entry', skill: 'candle-reading', read: '3m close top' },
  { step: 'stop', skill: 'invalidation', read: 'stop 15m box low 21514' },
  { step: 'target', skill: 'take-profit', read: 'target 1h swing 21598' },
];
const one = (read, b = briefing()) => CR.checkRead(CR.parseRead(read), b);

test('compression reads parse into their forms and steps', () => {
  assert.deepStrictEqual(CR.parseRead('15m compression break up'), { kind: 'compression', tf: '15m', value: 'up', form: '15m compression break up', slug: '15m-compression-break-up' });
  assert.deepStrictEqual(CR.parseRead('60m box at prior VAH').level, 'prior vah');
  assert.strictEqual(CR.parseRead('60m box at prior VAH').kind, 'boxAt');
  assert.deepStrictEqual([CR.parseRead('stop 15m box low 21514').kind, CR.parseRead('stop 15m box low 21514').source], ['stop', '15m box low']);
  assert.deepStrictEqual(CR.STEP_KINDS.compression, ['setup']);
  assert.deepStrictEqual(CR.STEP_KINDS.boxAt, ['location']);
  assert.ok(CR.SETUP_CANDLE.has('compression'));
  assert.strictEqual(CR.parseRead('15m compression break sideways').kind, 'unknown');
});

test('compression break: TRUE only while expanding the read\'s way; compressing, a small candle, a fakeout, late or unknown are not', () => {
  const t = one('15m compression break up');
  assert.deepStrictEqual([t.check, t.dir, t.field], [true, 'long', 'm3.compression.15m']);
  assert.strictEqual(one('15m compression break down').check, false);
  assert.strictEqual(one('15m compression break down').dir, 'short');
  for (const [state, brk, why] of [['compressing', null, /no break out of a box/], ['neither', { ...BREAK, expansion: false }, /no expansion/],
    ['compressing', { ...BREAK, backInside: true }, /closed back inside the box/], ['neither', { ...BREAK, late: true, runAtr: 1.4 }, /late/], ['neither', { ...BREAK, beyondNow: false }, /price is back inside the box/]]) {
    const x = one('15m compression break up', briefing({ state, box: BOX, break: brk }));
    assert.strictEqual(x.check, false, state);
    assert.match(x.fact, why);
  }
  assert.strictEqual(one('5m compression break up').check, 'unchecked');
  const b = scenario1();
  assert.strictEqual(CR.checkRead(CR.parseRead('15m compression break up'), b).check, 'unchecked', 'no compression in the briefing');
});

test('box at: a key level of a live box (compressing or expanding), by name, within one ATR(14) of price; none, another, a far one or a dead box is FALSE', () => {
  assert.deepStrictEqual([one('15m box at prior vah').check, one('15m box at prior vah').dir], [true, null]);
  // The prior VAH 21530.13 is 10.12 from price 21540.25: within one ATR(14) 13.33. With an ATR of 10 it is not.
  const far = briefing();
  far.sections.m3.data.atr14 = 10;
  assert.strictEqual(one('15m box at prior vah', far).check, false);
  assert.match(one('15m box at prior vah', far).fact, /more than one ATR\(14\) 10 from price 21540.25/);
  const noAtr = briefing();
  delete noAtr.sections.m3.data.atr14;
  assert.strictEqual(one('15m box at prior vah', noAtr).check, false);
  assert.strictEqual(one('15m box at prior val').check, false);
  assert.strictEqual(one('15m box at prior vah', briefing({ state: 'neither', box: BOX, break: { ...BREAK, backInside: true } })).check, false);
  assert.strictEqual(one('15m box at prior vah', briefing({ state: 'compressing', box: BOX, break: null })).check, true);
});

test('stop beyond the box: a live box\'s far side, within a tick; a long\'s low, a short\'s high', () => {
  const s = one('stop 15m box low 21514');
  assert.deepStrictEqual([s.check, s.price, s.dir], [true, 21514, 'long']);
  assert.strictEqual(one('stop 15m box low 21513.50').check, false);
  assert.strictEqual(one('stop 15m box high 21530').dir, 'long', 'under price either edge sits on the long side');
  assert.strictEqual(one('stop 15m box low 21514', briefing({ state: 'neither', box: BOX, break: { ...BREAK, expansion: false } })).check, 'unchecked');
  assert.strictEqual(one('stop 5m box low 21514').check, 'unchecked');
});

test('a compression setup with an entry on a candle closed after the expansion candle passes; on the expansion candle itself it is refused', () => {
  const ok = CR.checkReads({ reads: READS, side: 'long', briefing: briefing() });
  assert.deepStrictEqual(ok.problems, []);
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.stop, { source: '15m-box-low', level: 21514 });
  // The 15m candle that closed 14:45 is the expansion candle: its own close is no confirmation.
  const own = CR.checkReads({ reads: READS.map(r => (r.step === 'entry' ? { ...r, read: '15m close top' } : r)), side: 'long', briefing: briefing() });
  assert.strictEqual(own.ok, false);
  assert.ok(own.problems.some(p => /closed after the setup's \(2026-04-23T14:45:00\.000Z\)/.test(p)), own.problems.join('; '));
  // The setup's time is the expansion candle's, not the timeframe's last candle: a 15m break that closed 15:00 (after
  // the 3m entry candle's close) can't be confirmed by it.
  const late = briefing({ state: 'expanding', box: BOX, break: { ...BREAK, closedAt: '2026-04-23T15:00:00.000Z' } });
  assert.strictEqual(CR.checkReads({ reads: READS, side: 'long', briefing: late }).ok, false);
  // The same setup for a short is against the side.
  const short = CR.checkReads({ reads: READS, side: 'short', briefing: briefing() });
  assert.strictEqual(short.ok, false);
  assert.strictEqual(short.reads.find(r => r.step === 'setup').agrees, false);
  // A compression read only in its step.
  const wrongStep = CR.checkReads({ reads: READS.map(r => (r.step === 'location' ? { ...r, read: '15m compression break up' } : r)), side: 'long', briefing: briefing() });
  assert.ok(wrongStep.problems.some(p => /belongs to the setup step/.test(p)));
});

test('hints: the compression setup, its box\'s level and its far side are listed only when TRUE; a base break on the last candle is not', () => {
  const tick = 0.25;
  const c = H.candidatesOf(briefing(), 'long', { tick });
  assert.ok(c.setup.some(x => x.read === '15m compression break up' && x.close === Date.parse(BREAK.closedAt)));
  assert.ok(c.location.some(x => x.read === '15m box at prior vah'));
  assert.ok(c.stop.some(x => x.read === 'stop 15m box low 21514'));
  const short = H.candidatesOf(briefing(), 'short', { tick });
  assert.ok(!short.setup.some(x => /compression/.test(x.read)));
  const dead = H.candidatesOf(briefing({ state: 'compressing', box: BOX, break: null }), 'long', { tick });
  assert.ok(!dead.setup.some(x => /compression/.test(x.read)));
  // A 3m expansion on the base's last candle (closed 15:00): no later candle in the briefing can confirm it.
  const base = { state: 'expanding', box: { ...BOX, levels: [] }, break: { ...BREAK, closedAt: '2026-04-23T15:00:00.000Z' } };
  assert.ok(!H.candidatesOf(briefing(undefined, base), 'long', { tick }).setup.some(x => x.read === '3m compression break up'));
  const before = { ...base, break: { ...base.break, closedAt: '2026-04-23T14:57:00.000Z', barsAgo: 1 } };
  assert.ok(H.candidatesOf(briefing(undefined, before), 'long', { tick }).setup.some(x => x.read === '3m compression break up'));
});

test('findings credit the compression reads to the compression skill', () => {
  assert.strictEqual(skillOfRead('setup', '15m compression break up'), 'compression');
  assert.strictEqual(skillOfRead('location', '15m box at prior vah'), 'compression');
  assert.strictEqual(skillOfRead('stop', 'stop 15m box low 21514'), 'invalidation');
});
