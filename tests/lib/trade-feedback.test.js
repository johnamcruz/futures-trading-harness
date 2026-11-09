'use strict';

// The trade feedback (trading/trade-feedback.js): each reviewed trade tagged with the reads present at its entry and how
// it behaved, shown to the model as one line; the per-read record held behind a sample floor. Information only: its own
// past, never a rule, filter, veto or size cut.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../../scripts/lib/trading/trade-feedback');

const M3 = 180000;
const T0 = '2021-06-04T14:42:00.000Z'; // 10:42 ET
const ms = Date.parse;
const iso = t => new Date(t).toISOString();
const bar = (t, o, h, l, c) => ({ t: iso(t), o, h, l, c, v: 100 });

// A composed record as compose_check appends it (lifecycle-record.js reads it), the run 05/08 shape.
const record = (o = {}) => ({
  id: o.id || 'rec-1', root: 'MNQ', contract: 'MNQ:2021-06', side: o.side || 'long', bar: o.bar || '2021-06-04T14:39:00.000Z', at: o.at || '2021-06-04T14:41:30.000Z',
  expiresAt: '2021-06-04T14:45:00.000Z', ok: true,
  reads: o.reads || [
    { step: 'bias', skill: 'daily-bias', read: '1h up', why: 'x' },
    { step: 'location', skill: 'vwap', read: 'at vwap rth', why: 'x' },
    { step: 'setup', skill: 'level-reaction', read: '15m rejected vwap rth up', why: 'x' },
    { step: 'entry', skill: 'candle-reading', read: '3m pattern hammer', why: 'x' },
    { step: 'stop', skill: 'stops', read: 'below 3m swing low 13650.25', why: 'x' },
    { step: 'target', skill: 'targets', read: 'at prior rth high 13702', why: 'x' },
  ],
  context: { regime: { primary: 'trend-up', volatility: 'normal' }, dayType: 'trend up' },
  plan: { entry: 13660, stop: 13650, target: 13690, size: 3 },
});
const stateRead = (o = {}) => ({
  status: 'read', symbol: 'MNQ', bar: '2021-06-04T14:39:00.000Z', read: { frames: { '4h': 'up', '1h': 'up', '15m': 'range' }, agree: 'no' },
  facts: { daySoFar: 'directional', pullback: 'depth 40%', ...(o.facts || {}) }, ...o,
});
// The runner's review of a closed trade with the trip tags it writes (runner-reviews.js).
const review = (o = {}) => ({
  ts: o.ts || '2021-06-04T15:01:00.000Z', kind: 'review', contractId: 'MNQ', orderId: o.orderId ?? 501,
  text: 'runner: trade_lifecycle long 3 MNQ, order 501: filled 13660, out 13651 at 2021-06-04T14:57:30Z: loss, -0.9R net of fees on the planned 40-tick stop.',
  tags: o.tags || ['by:runner', 'result:loss', 'setup:trade_lifecycle', 'MNQ', 'r:-0.9',
    ...F.tripTags({ side: 'long', size: 3, fill: 13660, exit: 13651, openedAt: T0, closedAt: '2021-06-04T14:57:30.000Z', risk: 10, exitReason: 'trail' })],
});
// 3m bars across the trade: whole bars 14:45..14:54; the best high 13663 (+0.3R) at 14:48; the worst low 13651.
const bars = () => [
  bar(ms('2021-06-04T14:39:00Z'), 13655, 13661, 13654, 13660),
  bar(ms('2021-06-04T14:42:00Z'), 13660, 13662, 13657, 13659),
  bar(ms('2021-06-04T14:45:00Z'), 13659, 13662, 13656, 13660),
  bar(ms('2021-06-04T14:48:00Z'), 13660, 13663, 13655, 13656),
  bar(ms('2021-06-04T14:51:00Z'), 13656, 13658, 13652, 13653),
  bar(ms('2021-06-04T14:54:00Z'), 13653, 13655, 13651, 13652),
  bar(ms('2021-06-04T14:57:00Z'), 13652, 13653, 13640, 13645),
];

test('the read tags: one registry entry per read, the reads present at entry (record, its cycle\'s STATE read and briefing words)', () => {
  assert.deepStrictEqual(F.REGISTRY.map(e => e.key), ['bias', 'location', 'setup', 'entry', 'regime', 'state', 'pullback', 'day']);
  const r = F.readsAt({ record: F.normalizeRecord(record()), stateRead: stateRead() });
  assert.deepStrictEqual(r, {
    bias: '1h up', location: 'at vwap rth', setup: '15m rejected vwap rth up', entry: '3m pattern hammer', regime: 'trend-up',
    state: '4h up/1h up/15m range', pullback: 'depth 40%', day: 'directional',
  });
  // Prices dropped (a read's form), two reads of a step joined.
  const two = F.readsAt({ record: F.normalizeRecord(record({ reads: [{ step: 'bias', skill: 'a', read: '1h up' }, { step: 'bias', skill: 'b', read: '4h up' }, { step: 'location', skill: 'c', read: 'at 1h swing high 13702.5' }] })) });
  assert.deepStrictEqual([two.bias, two.location], ['1h up, 4h up', 'at 1h swing high']);
  // Nothing present: nothing tagged (never a guess); a STATE line the head didn't write is no state read.
  assert.deepStrictEqual(F.readsAt({}), {});
  assert.ok(!('state' in F.readsAt({ stateRead: { status: 'none', read: null, facts: { daySoFar: null, pullback: null } } })));
  // A broken line's partial read (unparsable, conflicting) is no read at entry.
  assert.ok(!('state' in F.readsAt({ stateRead: stateRead({ status: 'unparsable' }) })));
  // A later read is one entry: a registry with one added tags it with no other change.
  const reg = [...F.REGISTRY, { key: 'vwap', of: s => (s.record ? 'above' : null) }];
  assert.strictEqual(F.readsAt({ record: F.normalizeRecord(record()) }, reg).vwap, 'above');
});

test('the behaviour: size, exit, R, MAE and MFE in R from the bars (tripExcursion), bars to MFE, kept share, +1R reached', () => {
  const b = F.behaviourOf({ review: review(), bars: bars(), tfMs: M3 });
  assert.deepStrictEqual(b, { side: 'long', size: 3, exit: 'trail', R: -0.9, maeR: -0.9, mfeR: 0.3, mfeBars: 2, efficiency: -3, reached1R: false, openMs: ms(T0) });
  // No bars covering it: MAE and MFE unknown (null), never 0, and so the rest that hangs on them.
  const none = F.behaviourOf({ review: review(), bars: [], tfMs: M3 });
  assert.deepStrictEqual([none.maeR, none.mfeR, none.mfeBars, none.efficiency, none.reached1R], [null, null, null, null, null]);
  // Reached +1R: MFE at or past 1.
  const win = F.behaviourOf({ review: review({ tags: ['result:win', 'r:1.5', ...F.tripTags({ side: 'long', size: 3, fill: 13660, exit: 13675, openedAt: T0, closedAt: '2021-06-04T14:57:30.000Z', risk: 10, exitReason: 'target' })] }),
    bars: bars().map(x => (x.t === '2021-06-04T14:51:00.000Z' ? { ...x, h: 13672 } : x)), tfMs: M3 });
  assert.deepStrictEqual([win.mfeR, win.reached1R, win.efficiency, win.exit], [1.5, true, 1, 'target']);
  // No trip tags (a model's own review): only what it states (its R), the rest unknown.
  const plain = F.behaviourOf({ review: { kind: 'review', tags: ['result:loss', 'r:-1'] } });
  assert.deepStrictEqual(plain, { side: null, size: null, exit: null, R: -1, maeR: null, mfeR: null, mfeBars: null, efficiency: null, reached1R: null, openMs: null });
});

test('the line: one compact line per reviewed trade, every unknown said as unknown', () => {
  const item = F.feedbackItem({ review: review(), record: F.normalizeRecord(record()), stateRead: stateRead(), bars: bars(), tfMs: M3 });
  assert.strictEqual(F.feedbackLine(item),
    '06-04 10:42 long, setup 15m rejected vwap rth up; reads: 1h up, at vwap rth, 3m pattern hammer, regime trend-up, state 4h up/1h up/15m range, pullback depth 40%, day directional; 3 MNQ; exit trail; loss R -0.9; MAE -0.9, MFE +0.3 at bar 2 (never reached +1R)');
  const unknown = F.feedbackItem({ review: review(), record: null, stateRead: null, bars: [], tfMs: M3 });
  assert.strictEqual(F.feedbackLine(unknown), '06-04 10:42 long; reads: unknown; 3 MNQ; exit trail; loss R -0.9; MAE unknown, MFE unknown');
  assert.ok(!/MAE 0|MFE \+?0\b/.test(F.feedbackLine(unknown)), 'unknown is never 0');
  // The exit unknown; the trade-reviewer's mistakes kept.
  const t = review({ tags: ['result:win', 'r:1.2', 'mistake:late-exit', ...F.tripTags({ side: 'short', size: 2, fill: 100, exit: 97, openedAt: T0, closedAt: '2021-06-04T14:57:30.000Z', risk: 2.5 })] });
  assert.match(F.feedbackLine(F.feedbackItem({ review: t, bars: [], tfMs: M3 })), /^06-04 10:42 short; reads: unknown; 2 MNQ; exit unknown; win R \+1\.2; MAE unknown, MFE unknown \[mistake:late-exit\]$/);
  // Nothing to tag with (no trip tags, no record): no feedback line (the caller keeps the plain one).
  assert.strictEqual(F.feedbackItem({ review: { kind: 'review', tags: ['result:loss'] } }), null);
});

test('the per-read record: held below the sample floor, n beside every figure above it, MFE/MAE labelled bar-granular', () => {
  const it = (bias, R, mae, mfe) => ({ reads: { bias, regime: 'trend-up' }, behaviour: { R, maeR: mae, mfeR: mfe } });
  const items = [it('1h up', -1, -1, 0.3), it('1h up', 2, -0.2, 2.5), it('1h up', -1, -1, null), it('1h down', 0.5, -0.4, 1)];
  // Under the floor: nothing (never stats at n of 1 to 3).
  assert.strictEqual(F.recordText(items, { floor: 5, max: 6 }), null);
  const four = F.recordText(items, { floor: 3, max: 6 });
  assert.strictEqual(four, 'Record per read (your last 4 reviewed trades; groups of 3 or more; MAE/MFE from bar extremes, bar-granular, overstated): regime trend-up: n 4, avg R +0.13, MAE -0.65 (n 4), MFE +1.27 (n 3); bias 1h up: n 3, avg R 0, MAE -0.73 (n 3), MFE +1.4 (n 2)');
  // Every figure has its n beside it.
  for (const g of four.split(': ').slice(1).join(': ').split('; ')) assert.match(g, /n \d+, avg R .*MAE .* \(n \d+\), MFE .* \(n \d+\)$/);
  // The cap keeps the largest groups.
  assert.match(F.recordText(items, { floor: 3, max: 1 }), /: regime trend-up: n 4[^;]*$/);
  // A group whose MFE is all unknown says so.
  const blind = [it('x', 1, null, null), it('x', 1, null, null), it('x', 1, null, null)];
  assert.match(F.recordText(blind, { floor: 3, max: 6 }), /bias x: n 3, avg R \+1, MAE unknown \(n 0\), MFE unknown \(n 0\)/);
});

test('nothing in the feedback text reads as a rule (information only: never a rule, filter, veto or size cut)', () => {
  const item = F.feedbackItem({ review: review(), record: F.normalizeRecord(record()), stateRead: stateRead(), bars: bars(), tfMs: M3 });
  const it = { reads: item.reads, behaviour: item.behaviour };
  const text = [F.feedbackLine(item), F.recordText([it, it, it, it, it], { floor: 5, max: 6 }), F.FRAMING].join(' ');
  assert.doesNotMatch(text, /\b(avoid|never trade|do not|don't|must|should|skip|block|veto|refuse|favour|favor|size down|reduce size|only trade|stop trading)\b/i);
  assert.match(F.FRAMING, /record, not a rule/);
  assert.match(F.FRAMING, /\bn\b/);
});

test('the exit reason from the broker\'s own word on the closing order: target, stop, trail, closed; else unknown', () => {
  const t = { contractId: 'MNQ', fill: 13660, openedAt: T0, closedAt: '2021-06-04T14:57:30.000Z' };
  const fill = (orderId, side = 1) => ({ orderId, contractId: 'MNQ', side, size: 3, price: 13651, creationTimestamp: '2021-06-04T14:57:30.000Z' });
  const entry = { orderId: 501, contractId: 'MNQ', side: 0, size: 3, price: 13660, creationTimestamp: T0 };
  const why = (order, o = {}) => F.exitReasonOf({ t, side: 'long', orderId: '501', fills: [entry, fill(order.id)], history: [order], stopTicks: 40, tick: 0.25, ...o });
  assert.strictEqual(why({ id: 9, type: 1, bracket: { role: 'target' }, limitPrice: 13690 }), 'target');
  assert.strictEqual(why({ id: 9, type: 4, bracket: { role: 'stop' }, stopPrice: 13650 }), 'stop', 'at the planned stop');
  assert.strictEqual(why({ id: 9, type: 4, bracket: { role: 'stop' }, stopPrice: 13655.5 }), 'trail', 'a moved stop');
  assert.strictEqual(why({ id: 9, type: 5 }), 'trail');
  assert.strictEqual(why({ id: 9, type: 2 }), 'closed', 'a market close (the runner\'s or the model\'s)');
  // Unknown, never guessed: the order not listed, the orders unread, the stop unplanned, a type it can't place.
  assert.strictEqual(why({ id: 10, type: 2 }, { history: [{ id: 11, type: 2 }] }), null);
  assert.strictEqual(F.exitReasonOf({ t, side: 'long', orderId: '501', fills: [entry, fill(9)], history: null, stopTicks: 40, tick: 0.25 }), null);
  assert.strictEqual(why({ id: 9, type: 4, stopPrice: 13650 }, { stopTicks: null }), null);
  assert.strictEqual(why({ id: 9, type: 6 }), null);
  // Two closing orders that say different things: mixed.
  const two = F.exitReasonOf({ t, side: 'long', orderId: '501', fills: [entry, fill(9), fill(10)], history: [{ id: 9, type: 2 }, { id: 10, type: 1, bracket: { role: 'target' } }], stopTicks: 40, tick: 0.25 });
  assert.strictEqual(two, 'mixed');
});

test('the trip tags: written once with the review, read back the same; nothing unknown is written', () => {
  const tags = F.tripTags({ side: 'long', size: 3, fill: 13660.25, exit: 13651, openedAt: T0, closedAt: '2021-06-04T14:57:30.000Z', risk: 10, exitReason: 'trail' });
  assert.deepStrictEqual(tags, ['trip-side:long', 'trip-size:3', 'trip-fill:13660.25', 'trip-out:13651', `trip-open:${T0}`, 'trip-close:2021-06-04T14:57:30.000Z', 'trip-risk:10', 'trip-exit:trail']);
  assert.deepStrictEqual(F.tripOf({ tags }), { side: 'long', size: 3, fill: 13660.25, exit: 13651, openMs: ms(T0), closeMs: ms('2021-06-04T14:57:30.000Z'), risk: 10, exitReason: 'trail' });
  const bare = F.tripTags({ side: 'short', size: 1, fill: 1, exit: 2, openedAt: T0, closedAt: T0, risk: null, exitReason: null });
  assert.ok(!bare.some(x => /trip-(risk|exit):/.test(x)));
  // None of them is a tag the gate or the instincts count (result:, r:, setup:, regime:, mistake:, by:, paper).
  for (const x of tags) assert.doesNotMatch(x, /^(result|r|setup|regime|mistake|by):|^paper$/i);
});

test('the prompt\'s trades: the last n reviewed with feedback lines (a plain one when there is none) and the record from local files', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-feedback-'));
  const dataDir = path.join(home, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'MNQ-3m.json'), JSON.stringify({ bars: bars() }));
  fs.writeFileSync(path.join(home, 'entry-orders.json'), JSON.stringify([{ orderId: 501, contractId: 'MNQ', at: '2021-06-04T14:41:40.000Z', composed: { record: 'rec-1' } }]));
  fs.mkdirSync(path.join(home, 'trade-lifecycle', 'MNQ'), { recursive: true });
  require('../../scripts/lib/trading/trade-lifecycle');
  const shard = require('../../scripts/lib/trading/trade-lifecycle').recordFile(home, 'MNQ', '2021-06-04');
  fs.mkdirSync(path.dirname(shard), { recursive: true });
  fs.writeFileSync(shard, `${JSON.stringify(record())}\n`);
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  // The record's own bar's cycle, never a later cycle's read (another bar: a later STATE line).
  const later = stateRead({ bar: '2021-06-04T14:51:00.000Z', read: { frames: { '4h': 'down', '1h': 'down', '15m': 'down' }, agree: 'yes' } });
  fs.writeFileSync(path.join(home, 'logs', 'cycles-2021-06-04.jsonl'), [{ cycleAt: '2021-06-04T14:42:00.000Z', action: 'trade', stateRead: stateRead() }, { cycleAt: '2021-06-04T14:54:00.000Z', action: 'trade', stateRead: later }].map(x => JSON.stringify(x)).join('\n'));
  const plain = { ts: '2021-06-03T15:00:00.000Z', kind: 'review', contractId: 'MNQ', text: 'orb long, R -1.1', tags: ['result:loss', 'setup:orb', 'r:-1.1'] };
  const out = F.tradeFeedback({ entries: [plain, review()], home, dataDir, timeframe: 3, n: 10, window: 30, floor: 5, max: 6 });
  assert.deepStrictEqual(out.lines, ['orb long loss -1.1R', F.feedbackLine(F.feedbackItem({ review: review(), record: F.normalizeRecord(record()), stateRead: stateRead(), bars: bars(), tfMs: M3 }))]);
  assert.strictEqual(out.record, null, 'two trades: under the floor, no record');
  assert.strictEqual(out.tagged, 1, "one line with feedback (the plain one has none)");
  assert.match(out.lines[1], /reads: 1h up, at vwap rth, 3m pattern hammer, regime trend-up, state 4h up\/1h up\/15m range/);
  // Missing files: the line with what is known, never a throw.
  const bare = F.tradeFeedback({ entries: [review()], home: fs.mkdtempSync(path.join(os.tmpdir(), 'fth-feedback-')), dataDir: null, timeframe: 3, n: 10, window: 30, floor: 5, max: 6 });
  assert.match(bare.lines[0], /reads: unknown; 3 MNQ; exit trail; loss R -0\.9; MAE unknown, MFE unknown$/);
  // No reviews: nothing.
  assert.deepStrictEqual(F.tradeFeedback({ entries: [], home, dataDir, timeframe: 3, n: 10, window: 30, floor: 5, max: 6 }), { lines: [], record: null, tagged: 0 });
});

test('an experience log row renders with the same line (the offline measurement on rebuilt runs)', () => {
  const row = {
    root: 'MNQ', side: 'long', decision: 'entered', reads: F.normalizeRecord(record()).reads, context: { regime: 'trend-up' }, stateRead: stateRead(),
    outcome: { source: 'fills', size: 3, R: -0.9, maeR: -0.9, mfeR: 0.3, entryTime: T0, exitReason: 'closed' }, grade: 'loss',
  };
  const item = F.fromExperienceRow(row);
  assert.strictEqual(F.feedbackLine(item), '06-04 10:42 long, setup 15m rejected vwap rth up; reads: 1h up, at vwap rth, 3m pattern hammer, regime trend-up, state 4h up/1h up/15m range, pullback depth 40%, day directional; 3 MNQ; exit unknown; loss R -0.9; MAE -0.9, MFE +0.3 (never reached +1R)');
  assert.strictEqual(F.fromExperienceRow({ ...row, decision: 'passed' }), null);
});

test('one structure for every consumer: the live join and an experience row give the same item shape (the prompt line is one renderer)', () => {
  const live = F.feedbackItem({ review: review(), record: F.normalizeRecord(record()), stateRead: stateRead(), bars: bars(), tfMs: M3 });
  const row = F.fromExperienceRow({ root: 'MNQ', side: 'long', decision: 'entered', reads: F.normalizeRecord(record()).reads, context: { regime: 'trend-up' }, stateRead: stateRead(),
    outcome: { size: 3, R: -0.9, maeR: -0.9, mfeR: 0.3, entryTime: T0, exitReason: 'closed' }, grade: 'loss' });
  assert.deepStrictEqual(Object.keys(row).sort(), Object.keys(live).sort());
  assert.deepStrictEqual(Object.keys(row.behaviour).sort(), Object.keys(live.behaviour).sort());
  assert.deepStrictEqual(row.reads, live.reads);
  assert.deepStrictEqual([row.behaviour.maeR, row.behaviour.mfeR, row.behaviour.reached1R, row.behaviour.efficiency], [live.behaviour.maeR, live.behaviour.mfeR, live.behaviour.reached1R, live.behaviour.efficiency]);
  // The derived fields have one definition.
  assert.deepStrictEqual(F.behaviour({ R: 1, mfeR: 2 }), { side: null, size: null, exit: null, R: 1, maeR: null, mfeR: 2, mfeBars: null, efficiency: 0.5, reached1R: true, openMs: null });
  assert.deepStrictEqual([F.behaviour({ R: 1, mfeR: 0 }).efficiency, F.behaviour({ R: 1 }).reached1R], [null, null]);
});
