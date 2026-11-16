'use strict';

// The trigger stop forms (composed-reads.js, the entry/exit PR, DESIGN-REVIEW M4): the stop at the invalidation of the
// read that triggered the entry, whatever its timeframe: `stop <tf> bos <price>` (the BOS's protected swing) and
// `stop <tf> cisd <price>` (the CISD's leg origin), each TRUE only for a trigger on the decision bar (freshness), its way,
// still standing. No `stop <tf> choch` form (a CHoCH alone is not an entry). Not required: no entry gate.

const test = require('node:test');
const assert = require('node:assert');
const CR = require('../../scripts/lib/trading/composed-reads');
const { scenario1 } = require('../fixtures/trade-lifecycle-scenario');

// The scenario's decision bar: the 3m candle 14:57-15:00 (price 21540.25).
const CLOSE = '2026-04-23T15:00:00.000Z';
function briefing({ m3 = null, m15 = null, cisd = null } = {}) {
  const b = scenario1();
  if (m3) b.sections.m3.data.lastBreak = { last: m3, previous: null };
  if (m15) b.sections.m15.data.lastBreak = { last: m15, previous: null };
  if (cisd) b.sections.m3.data.cisd = { ...b.sections.m3.data.cisd, ...cisd };
  return b;
}
const BOS3 = (over = {}) => ({ kind: 'BOS', direction: 'up', level: 21535, swingAt: '2026-04-23T14:30:00.000Z', at: '2026-04-23T14:57:00.000Z', barsAgo: 0, protected: { side: 'low', level: 21529.75, at: '2026-04-23T14:45:00.000Z', brokenAt: null }, ...over });
const BOS15 = (over = {}) => ({ kind: 'BOS', direction: 'up', level: 21530, swingAt: '2026-04-23T13:45:00.000Z', at: '2026-04-23T14:45:00.000Z', knownAt: CLOSE, barsAgo: 0, protected: { side: 'low', level: 21514, at: '2026-04-23T14:15:00.000Z', brokenAt: null }, ...over });
const CISD = (over = {}) => ({ dir: 'bullish', level: 21530.5, confirmedClose: CLOSE, leg: { origin: 21522.25, extreme: 21541 }, status: 'waiting', priceInOte: false, ...over });
const one = (read, b) => CR.checkRead(CR.parseRead(read), b);

test('stop <tf> bos: the BOS\'s protected swing, TRUE for a break on the decision bar the side\'s way, unbroken; within a tick', () => {
  const s = one('stop 3m bos 21529.75', briefing({ m3: BOS3() }));
  assert.deepStrictEqual([s.check, s.price, s.dir, s.field], [true, 21529.75, 'long', 'm3.lastBreak.last.protected']);
  assert.strictEqual(one('stop 3m bos 21529.50', briefing({ m3: BOS3() })).check, true, 'within one tick');
  assert.strictEqual(one('stop 3m bos 21529', briefing({ m3: BOS3() })).check, false, 'more than a tick off');
  // Stale: a break bars ago is no trigger of this bar.
  const stale = one('stop 3m bos 21529.75', briefing({ m3: BOS3({ barsAgo: 1 }) }));
  assert.deepStrictEqual([stale.check, /closed 1 bar\(s\) before the decision bar/.test(stale.fact)], [false, true], stale.fact);
  // Broken by a close, a CHoCH, the other way: FALSE, each saying why.
  assert.match(one('stop 3m bos 21529.75', briefing({ m3: BOS3({ protected: { side: 'low', level: 21529.75, brokenAt: CLOSE } }) })).fact, /broken by a close/);
  const choch = one('stop 3m bos 21529.75', briefing({ m3: BOS3({ kind: 'CHoCH' }) }));
  assert.deepStrictEqual([choch.check, /is a CHoCH up, not a BOS/.test(choch.fact)], [false, true]);
  const other = one('stop 3m bos 21529.75', briefing({ m3: BOS3({ direction: 'down', protected: { side: 'high', level: 21529.75, brokenAt: null } }) }));
  assert.deepStrictEqual([other.check, /a BOS down: its protected swing is a short's stop/.test(other.fact)], [false, true], other.fact);
  // A short's: a BOS down, its protected high over the price.
  const short = one('stop 3m bos 21550', briefing({ m3: BOS3({ direction: 'down', protected: { side: 'high', level: 21550, brokenAt: null } }) }));
  assert.deepStrictEqual([short.check, short.dir], [true, 'short']);
  // No protected swing in the briefing: unchecked (never TRUE without it).
  assert.strictEqual(one('stop 3m bos 21529.75', briefing({ m3: BOS3({ protected: null }) })).check, 'unchecked');
  assert.strictEqual(one('stop 3m bos 21529.75', briefing({ m3: null })).check, 'unchecked', 'the scenario\'s break carries no protected swing');
});

test('stop 15m bos: the 15m break known at the decision bar\'s close (its candle closed with it), its protected swing', () => {
  const s = one('stop 15m bos 21514', briefing({ m15: BOS15() }));
  assert.deepStrictEqual([s.check, s.price, s.dir], [true, 21514, 'long']);
  const old = one('stop 15m bos 21514', briefing({ m15: BOS15({ knownAt: '2026-04-23T14:45:00.000Z', barsAgo: 1 }) }));
  assert.deepStrictEqual([old.check, /not on the decision bar/.test(old.fact)], [false, true], old.fact);
  assert.strictEqual(one('stop 1h bos 21500', briefing()).check, 'unchecked', 'no 1h protected swing in the briefing');
});

test('stop <tf> cisd: the CISD\'s leg origin, TRUE for a live one confirmed on the decision bar the side\'s way', () => {
  const s = one('stop 3m cisd 21522.25', briefing({ cisd: { '3m': CISD() } }));
  assert.deepStrictEqual([s.check, s.price, s.dir, s.field], [true, 21522.25, 'long', 'm3.cisd.3m.leg.origin']);
  for (const [over, why] of [[{ status: 'weak' }, /weak/], [{ status: 'void' }, /void/], [{ confirmedClose: '2026-04-23T14:57:00.000Z' }, /not on the decision bar/], [{ dir: 'bearish' }, /bearish/]]) {
    const x = one('stop 3m cisd 21522.25', briefing({ cisd: { '3m': CISD(over) } }));
    assert.strictEqual(x.check, false, JSON.stringify(over));
    assert.match(x.fact, why);
  }
  assert.strictEqual(one('stop 3m cisd 21522.25', briefing()).check, false, 'none in these bars');
});

test('no `stop <tf> choch` form: a CHoCH alone is not an entry, so its swing is no trigger stop; the other stop forms still stand (no entry gate)', () => {
  const x = one('stop 3m choch 21529.75', briefing({ m3: BOS3({ kind: 'CHoCH' }) }));
  assert.deepStrictEqual([x.check, /a CHoCH alone is not an entry/.test(x.fact)], [false, true], x.fact);
  assert.strictEqual(one('stop 3m low 21529.75', briefing()).check, true, 'a candle\'s low stays a stop read');
});
