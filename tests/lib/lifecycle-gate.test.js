'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { composedName, composedRefusal, recordUsed } = require('../../scripts/lib/trading/lifecycle-gate');
const { appendVerdict } = require('../../scripts/lib/trading/prop-state');
const { appendRecord, recordFile: recordsFile, readRecords } = require('../../scripts/lib/trading/trade-lifecycle');
const { writeBriefing } = require('../../scripts/lib/trading/briefing');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { tmpDir } = require('../helpers');
const F = require('../fixtures/lifecycle');

const ROOT = path.resolve(__dirname, '..', '..');
const DOC = loadStrategies(ROOT, {}).strategies.find(s => s.name === 'trade_lifecycle');
const SPEC = () => ({ tickSize: 0.25, tickValue: 0.5 });
const NOW = new Date('2026-10-07T14:00:02Z');

function judge(home, o = {}) {
  return composedRefusal({ name: 'trade_lifecycle', strategy: 'strategy' in o ? o.strategy : DOC, home, root: 'MNQ', input: F.order(o.order || {}), now: o.now || NOW, cycleBars: 'cycleBars' in o ? o.cycleBars : { MNQ: F.BAR }, entries: o.entries || [], specOf: o.specOf || SPEC });
}
const world = (o = {}) => { const home = tmpDir(); const rec = F.writeScenario(home, o); return { home, rec }; };

test('composed-reads: scenario 1 stands: the record for this bar and side, every read true now, the order as the record says', () => {
  const { home } = world();
  const r = judge(home);
  assert.strictEqual(r.message, null);
  assert.deepStrictEqual([r.plan.stop.ticks, r.plan.target.ticks, r.check.ok], [111, 231, true]);
  // The phase-2 room: the briefing's first level ahead (prior VAH, 29.75 points) in this plan's R (its 27.75-point stop).
  assert.deepStrictEqual(r.room, { stopPoints: 27.75, needR: 2.08, inTheWay: { name: 'prior VAH', R: 1.07 } });
  // Better than the reference for a long is a lower limit.
  assert.strictEqual(judge(home, { order: { limitPrice: 21539.5 } }).message, null);
});

test('composed-reads: each false, unverifiable or other-side read refuses, named; the record\'s own ok is never trusted', () => {
  const swap = (i, read) => F.READS.map((x, j) => (j === i ? { ...x, read } : x));
  // A false read: the record was ok when written; the briefing on disk now says the 1h trend is down.
  let { home, rec } = world();
  assert.strictEqual(rec.ok, true);
  const down = F.briefing();
  down.sections.h1.data.h1.trend = 'down';
  writeBriefing(home, down);
  let m = judge(home).message;
  assert.match(m, /false by the briefing: "1h up" \(the 1h trend is down\)/);
  // An unverifiable read, even in a record that says ok.
  ({ home } = world({ reads: swap(3, '5m close top') }));
  const tampered = { ...readRecords(home, 'MNQ').at(-1), ok: true, problems: [] };
  appendRecord(home, tampered);
  assert.match(judge(home).message, /unverifiable: "5m close top"/);
  // A true read for the other side.
  const flat = F.briefing({ m3: { trendRule: 'Trend rule: no trend on 1h, 4h' } });
  ({ home } = world({ reads: swap(0, 'trend short allowed'), b: flat }));
  m = judge(home).message;
  assert.match(m, /against the long: "trend short allowed"/);
  // A step left out.
  ({ home } = world({ reads: F.READS.filter(x => x.step !== 'bias') }));
  assert.match(judge(home).message, /steps not stated: bias/);
});

test('composed-reads: the record must be this bar\'s, this side\'s, unexpired and unused', () => {
  let rec;
  let { home } = world();
  assert.match(judge(home, { cycleBars: {} }).message, /no cycle bar for MNQ/);
  assert.match(judge(home, { cycleBars: { MNQ: '2026-10-07T14:00:00.000Z' } }).message, /briefing can't be read .*not the cycle's/);
  assert.match(judge(home, { now: new Date(F.EXPIRES) }).message, /expired at 2026-10-07T14:03:00.000Z/);
  const used = { ts: '2026-10-07T14:00:01Z', kind: 'order_placed', contractId: 'MNQ', text: 'setup:trade_lifecycle long', data: { result: { success: true } } };
  assert.match(judge(home, { entries: [used] }).message, /already placed since this bar opened/);
  // Any long entry since the bar opened counts, whichever record (13:59, before this record's at), and one whose side
  // can't be read; an exit, a failed entry, one before the bar opened, a short or another family doesn't.
  for (const e of [{ ...used, ts: '2026-10-07T13:59:00Z' }, { ...used, data: { result: { success: true }, request: { side: 'buy' } } }]) {
    assert.match(judge(home, { entries: [e] }).message, /already placed/, JSON.stringify(e));
  }
  for (const e of [{ ...used, text: '[exit] flat' }, { ...used, data: { result: { success: false } } }, { ...used, ts: '2026-10-07T13:56:00Z' }, { ...used, contractId: 'MES' }, { ...used, data: { result: { success: true }, request: { side: 'sell' } } }]) {
    assert.strictEqual(judge(home, { entries: [e] }).message, null, JSON.stringify(e));
  }
  assert.strictEqual(recordUsed([], { since: 'not a time' }, 'MNQ'), true, 'no time: treated as used');
  // Only a record for the other side.
  ({ home } = world({ side: 'short' }));
  assert.match(judge(home).message, /for a short, not this long/);
  // No record at all.
  home = tmpDir();
  writeBriefing(home, F.briefing());
  assert.match(judge(home).message, /no compose record for the MNQ bar opened 2026-10-07T13:57:00.000Z/);
  // A record whose plan isn't what its reads give now.
  ({ home, rec } = world());
  appendRecord(home, { ...rec, plan: { ...rec.plan, stop: { ...rec.plan.stop, ticks: 90 } } });
  assert.match(judge(home).message, /record's plan \(90-tick stop.* is not the plan its reads give now \(111-tick stop/);
  // An unreadable record file: no record (fails closed).
  home = tmpDir();
  writeBriefing(home, F.briefing());
  require('fs').mkdirSync(recordsFile(home, 'MNQ'), { recursive: true });
  assert.match(judge(home).message, /no compose record/);
});

test('composed-reads: the order as the record says: a limit at the reference or better, its ticks, its stated size', () => {
  // 2 at $55.50 is $111, under the shipped $300; under a $100 cap the plan refuses it, as compose_check does.
  const big = DOC;
  const { home } = world({ size: 2 });
  assert.match(judge(home, { strategy: { ...DOC, risk: { ...DOC.risk, max_risk_usd: 100 } }, order: { size: 2 } }).message, /size 2 risks \$111, over the strategy's risk.max_risk_usd \$100/);
  const two = { size: 2 };
  assert.strictEqual(judge(home, { strategy: big, order: two }).message, null);
  assert.match(judge(home, { strategy: big, order: { ...two, type: 'market', limitPrice: undefined } }).message, /a market order: a trade-lifecycle entry is a limit/);
  assert.match(judge(home, { strategy: big, order: { ...two, limitPrice: 21541 } }).message, /worse than the record's entry price 21540.25/);
  assert.match(judge(home, { strategy: big, order: { ...two, stopLossBracket: { ticks: 120, type: 'stop' } } }).message, /stopLossBracket.ticks 120 is not the record's 111/);
  assert.match(judge(home, { strategy: big, order: { ...two, takeProfitBracket: undefined } }).message, /takeProfitBracket.ticks undefined is not the record's 231/);
  assert.match(judge(home, { strategy: big, order: { size: 3 } }).message, /size 3 is not the size the record states \(2\)/);
  assert.match(judge(home, { strategy: big, order: { size: 1 } }).message, /size 1 is not the size the record states \(2\)/);
  assert.match(judge(home, { strategy: big, order: { ...two, side: 'hold' } }).message, /not buy or sell/);
  const none = world({ size: 0 });
  assert.match(judge(none.home).message, /states no size/);
});

test('composed-reads: the minimum stop, min_rr and the specs fail closed; a check that throws refuses', () => {
  // D13: a stop at the 3m low 21529 (11.25 + a tick = 46 ticks) is fine; one at 21535.25 (21 ticks) is under 24.
  const near = F.briefing({ m3: { candles: { '15m': { closedAt: '2026-10-07T13:45:00.000Z', l: 21535.25, h: 21545, closeLocation: 'top', relations: [{ name: 'prior VAH', price: 21530.13, rel: 'rejected', dir: 'up' }] }, '3m': { closedAt: F.CLOSE, closeLocation: 'top' } } } });
  const { home } = world({ b: near, reads: F.READS.map(x => (x.step === 'stop' ? { ...x, read: 'stop 15m low 21535.25' } : x)) });
  assert.match(judge(home).message, /21 ticks, under the minimum 24 .* never widened/);
  const ok = world();
  assert.match(judge(ok.home, { strategy: null }).message, /states no risk.max_risk_usd/, 'no strategy document: refused, never planned');
  assert.match(judge(ok.home, { specOf: () => null }).message, /no tick specs/);
  assert.match(judge(ok.home, { specOf: () => { throw new Error('boom'); } }).message, /the check failed \(boom\): no entry \(fails closed\)/);
});

test('composedName: the tag, a composed strategy, or a policy whose latest verdict trades one; nothing else', () => {
  const home = tmpDir();
  const strategies = [{ name: 'trade_lifecycle', signal: 'composed' }, { name: 'mine', signal: 'composed' }, { name: 'orb', signal: 'rules' }];
  const policy = { name: 'prop_portfolio', signal: 'policy' };
  assert.strictEqual(composedName({ setupName: 'trade_lifecycle', home, root: 'MNQ' }), 'trade_lifecycle', 'keyed on the tag, no registry needed');
  assert.strictEqual(composedName({ setupName: 'mine', named: strategies[1], strategies, home, root: 'MNQ' }), 'mine');
  assert.strictEqual(composedName({ setupName: 'orb', named: strategies[2], strategies, home, root: 'MNQ' }), null);
  assert.strictEqual(composedName({ setupName: null, home, root: 'MNQ' }), null);
  assert.strictEqual(composedName({ setupName: 'prop_portfolio', named: policy, strategies, home, root: 'MNQ' }), null, 'no verdict yet');
  appendVerdict(home, { strategy: 'prop_portfolio', contract: 'MNQ', component: 'orb' });
  assert.strictEqual(composedName({ setupName: 'prop_portfolio', named: policy, strategies, home, root: 'MNQ' }), null);
  appendVerdict(home, { strategy: 'prop_portfolio', contract: 'MNQ', component: 'trade_lifecycle' });
  assert.strictEqual(composedName({ setupName: 'prop_portfolio', named: policy, strategies, home, root: 'NQ' }), 'trade_lifecycle', 'the family');
  assert.strictEqual(composedName({ setupName: 'prop_portfolio', named: policy, strategies: null, home, root: 'MNQ' }), 'trade_lifecycle', 'by name with no registry');
});
