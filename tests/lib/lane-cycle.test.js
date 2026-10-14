'use strict';

// lane-cycle.js: one cycle over several timeframe lanes (its budget, policy collisions, the prompt's lanes line), and
// the lane pieces of the replay schedule and the session record.
const test = require('node:test');
const assert = require('node:assert');
const LC = require('../../scripts/lib/lane-cycle');
const { validateConfig, prompts } = require('../../scripts/lib/autotrader');
const { decisionPoints, laneCloses } = require('../../scripts/lib/replay/schedule');
const { pointOf, tradeBars, closedLanes } = require('../../scripts/lib/session/live');
const { decisionRecord, passTap } = require('../../scripts/lib/session/record');

const BASE = { harness: 'qwen', premarketAt: '', account: '7' };
const lane = (timeframe, trigger = 'bar') => ({ timeframe, trigger, strategies: null, policies: null });

test('laneBudgetMin / cycleTimeoutMin: the first lane keeps cycleTimeoutMinutes; another lane its own default, never over it; a cycle takes the fastest', () => {
  const cfg = validateConfig({ ...BASE, lanes: [{ timeframe: 3 }, { timeframe: 1, trigger: 'signal' }, { timeframe: 15 }] });
  assert.strictEqual(cfg.cycleTimeoutMinutes, 6);
  assert.deepStrictEqual(cfg.lanes.map(l => LC.laneBudgetMin(cfg, l)), [6, 3, 6], 'the 15m lane: its 30, capped at 6');
  assert.strictEqual(LC.cycleTimeoutMin(cfg, [cfg.lanes[0], cfg.lanes[1]]), 3);
  assert.strictEqual(LC.cycleTimeoutMin(cfg, [cfg.lanes[0], cfg.lanes[2]]), 6);
  assert.strictEqual(LC.cycleTimeoutMin(cfg, [cfg.lanes[1]]), 3);
  assert.strictEqual(LC.cycleTimeoutMin(cfg, []), 6, 'no lane: the runner\'s');
  // A 1m first lane: its default is 3; a 3m lane beside it can't exceed it.
  const fast = validateConfig({ ...BASE, lanes: [{ timeframe: 1 }, { timeframe: 3 }] });
  assert.deepStrictEqual(fast.lanes.map(l => LC.laneBudgetMin(fast, l)), [3, 3]);
  // An explicit cycleTimeoutMinutes: the first lane has it whole (as with one lane), the others under it.
  const set = validateConfig({ ...BASE, cycleTimeoutMinutes: 10, lanes: [{ timeframe: 3 }, { timeframe: 1 }] });
  assert.deepStrictEqual(set.lanes.map(l => LC.laneBudgetMin(set, l)), [10, 3]);
  // The legacy one-lane config: cycleTimeoutMinutes, unchanged.
  const one = validateConfig({ ...BASE, timeframe: 5, cycleTimeoutMinutes: 4 });
  assert.strictEqual(LC.cycleTimeoutMin(one, [lane(5)]), 4);
});

test('policyRank: priorities when both are set and differ (1 first); otherwise 3m and slower first, then the slower, then the name', () => {
  const p = (name, timeframe, priority) => ({ name, timeframe, ...(priority === undefined ? {} : { priority }) });
  const order = list => [...list].sort(LC.policyRank).map(x => x.name);
  assert.deepStrictEqual(order([p('a', '3m', 2), p('b', '1m', 1)]), ['b', 'a']);
  assert.deepStrictEqual(order([p('a', '1m', 2), p('b', '3m', 1)]), ['b', 'a']);
  // Equal or missing: the 3m-and-slower policy first.
  assert.deepStrictEqual(order([p('b', '1m', 4), p('a', '3m', 4)]), ['a', 'b']);
  assert.deepStrictEqual(order([p('b', '1m'), p('a', '3m')]), ['a', 'b']);
  assert.deepStrictEqual(order([p('b', '1m', 1), p('a', '3m')]), ['a', 'b'], 'one priority alone decides nothing');
  assert.deepStrictEqual(order([p('a', '3m'), p('b', '15m')]), ['b', 'a'], 'both slow: the slower first');
  assert.deepStrictEqual(order([p('a', '2m'), p('b', '1m')]), ['a', 'b'], 'both fast: the slower first');
  assert.deepStrictEqual(order([p('b', '3m'), p('a', '3m')]), ['a', 'b'], 'then the name');
  // An unknown timeframe counts as the fastest: it never wins a tie by default.
  assert.deepStrictEqual(order([p('a', 'x'), p('b', '1m')]), ['b', 'a']);
  assert.deepStrictEqual(order([{ name: 'a' }, p('b', '3m')]), ['b', 'a']);
});

test('settleCollisions: one policy\'s entry verdicts stand; every other policy\'s are skipped; skips never collide', () => {
  const v = (strategy, action = 'full') => ({ strategy, component: `${strategy}-c`, action, direction: 'long', maxSize: 1 });
  const reg = { pol3: { timeframe: '3m' }, pol1: { timeframe: '1m' }, polp: { timeframe: '1m', priority: 1 }, pol15: { timeframe: '15m', priority: 2 } };
  const of = n => reg[n] || null;
  assert.deepStrictEqual(LC.settleCollisions([], of), { winner: null, skipped: [] });
  assert.deepStrictEqual(LC.settleCollisions([v('pol3')], of), { winner: 'pol3', skipped: [] });
  assert.deepStrictEqual(LC.settleCollisions([v('pol3'), v('pol3')], of).skipped, [], 'one policy on two symbols: no collision');
  const two = [v('pol1'), v('pol3')];
  const r = LC.settleCollisions(two, of);
  assert.strictEqual(r.winner, 'pol3');
  assert.deepStrictEqual(r.skipped, [{ verdict: two[0], by: 'pol3' }]);
  // A skip verdict is no entry: nothing collides with it.
  assert.deepStrictEqual(LC.settleCollisions([v('pol1', 'skip'), v('pol3')], of).skipped, []);
  // Priorities: 1 over 2 over 3, whatever the timeframes; every loser listed.
  const reg3 = { ...reg, pol3: { timeframe: '3m', priority: 3 } };
  const s = LC.settleCollisions([v('pol15'), v('polp'), v('pol3')], n => reg3[n]);
  assert.strictEqual(s.winner, 'polp');
  assert.deepStrictEqual(s.skipped.map(x => x.verdict.strategy), ['pol15', 'pol3']);
  // Priorities on some only can go round in a circle (polp before pol15 by priority, pol3 before polp and pol15
  // before pol3 by timeframe): the timeframe rule alone decides, the slowest first. The same whatever the order.
  for (const order of [['pol15', 'polp', 'pol3'], ['pol3', 'polp', 'pol15'], ['polp', 'pol3', 'pol15']]) {
    const c = LC.settleCollisions(order.map(n => v(n)), of);
    assert.strictEqual(c.winner, 'pol15', order.join(','));
    assert.deepStrictEqual(c.skipped.map(x => x.verdict.strategy).sort(), ['pol3', 'polp']);
  }
  // A policy the registry doesn't know: never the default winner.
  assert.strictEqual(LC.settleCollisions([v('ghost'), v('pol1')], of).winner, 'pol1');
  assert.strictEqual(LC.settleCollisions(null).winner, null);
});

test('skippedVerdict: the same setup and bar, skipped at size 0 and multiplier 0, saying why and by which policy', () => {
  const v = { at: 'x', strategy: 'pol1', component: 'a1', bar: '2026-10-07T14:00:00Z', action: 'full', multiplier: 1, maxSize: 3, contract: 'MNQ', stopTicks: 40, direction: 'long' };
  const s = LC.skippedVerdict(v, 'pol3', new Date('2026-10-07T14:03:02Z'));
  assert.deepStrictEqual(s, { ...v, at: '2026-10-07T14:03:02.000Z', action: 'skip', multiplier: 0, maxSize: 0, reason: 'skipped: lower priority (pol3 goes first when both have a setup in one cycle)', skippedBy: 'pol3' });
  assert.strictEqual(v.action, 'full', 'the original is untouched');
});

test('lanesLine: the lanes that closed, with each trigger; nothing for none', () => {
  assert.strictEqual(LC.lanesLine([]), '');
  assert.strictEqual(LC.lanesLine(null), '');
  assert.strictEqual(LC.lanesLine([lane(3), lane(1, 'signal')]), ' Lanes closed this cycle: 3m (every bar), 1m (on a signal: a strategy fired or a position is open); one cycle covers them all (decide once for every lane\'s setups).');
});

test('the trade prompt: each lane\'s bar file and minutes; a symbol\'s further lane repeats no trend, plan or day line; one lane unchanged', () => {
  const cfg = validateConfig({ ...BASE, lanes: [{ timeframe: 3 }, { timeframe: 1 }] });
  const now = new Date('2026-10-07T14:03:02Z');
  const bar = (t, file) => ({ t, c: 1, file, contractId: 'MNQ', trend: 'trend rule: 4h up', day: 'Day so far: up', plan: 'Plan: buy dips', recent: [] });
  const items = [
    { symbol: 'MNQ', minutes: 3, repeat: false, scan: [], bar: bar('2026-10-07T14:00:00Z', '/b/MNQ-3m.json') },
    { symbol: 'MNQ', minutes: 1, repeat: true, scan: [{ name: 'quick', signal: 'rules', candidate: true, direction: 'long', mtf: { style: 'reversal' } }], bar: bar('2026-10-07T14:02:00Z', '/b/MNQ-1m.json') },
  ];
  const text = prompts(cfg, now).trade(items, { lanes: LC.lanesLine(cfg.lanes) });
  assert.match(text, /Lanes closed this cycle: 3m \(every bar\), 1m \(every bar\)/);
  assert.match(text, /MNQ: a 3-minute bar just closed .* in \/b\/MNQ-3m\.json .* for the 3-minute timeframe/);
  assert.match(text, /MNQ: a 1-minute bar just closed .* in \/b\/MNQ-1m\.json .* for the 1-minute timeframe/);
  assert.strictEqual(text.split('trend rule: 4h up').length - 1, 1, 'the trend line once');
  assert.strictEqual(text.split('Plan: buy dips').length - 1, 1, 'the plan once');
  assert.match(text, /MNQ 1m fired on this bar .*quick long \(trend rule: reversal\)/, 'another lane\'s setup with its trend rule (the roles\' lookups read it)');
  // The first lane's setups don't repeat it: the bar briefing gives their trend rule.
  const first = prompts(cfg, now).trade([{ ...items[0], scan: [{ name: 'orb', signal: 'rules', candidate: true, direction: 'long', mtf: { style: 'trend', longAllowed: true } }] }]);
  assert.match(first, /orb long/);
  assert.doesNotMatch(first, /trend rule: allows/);
  assert.match(text, /run the trade-session skill for MNQ on account 7\./, 'the symbol once, no "one symbol at a time"');
  // One lane: no lanes line, and the same text with or without the minutes key.
  const one = validateConfig({ ...BASE, timeframe: 3 });
  const plain = [{ symbol: 'MNQ', scan: [], bar: bar('2026-10-07T14:00:00Z', '/b/MNQ-3m.json') }];
  assert.strictEqual(prompts(one, now).trade(plain), prompts(one, now).trade([{ ...plain[0], minutes: 3 }]));
  assert.doesNotMatch(prompts(one, now).trade(plain), /Lanes closed/);
});

test('replay schedule: the union of the lanes\' closes, one point per time, listing its lanes; one lane has no lanes key', () => {
  const at = (h, m) => Date.UTC(2026, 9, 7, h + 4, m);
  assert.deepStrictEqual(laneCloses([lane(3), lane(1)], at(10, 0), at(10, 6)).map(([t, tfs]) => [new Date(t).toISOString().slice(11, 16), tfs]),
    [['14:01', [1]], ['14:02', [1]], ['14:03', [3, 1]], ['14:04', [1]], ['14:05', [1]], ['14:06', [3, 1]]]);
  assert.deepStrictEqual(laneCloses([lane(1), lane(5)], at(10, 0), at(10, 5)).at(-1)[1], [1, 5], 'in the config\'s lane order');
  const cfg = validateConfig({ ...BASE, barDelaySeconds: 2, lanes: [{ timeframe: 3 }, { timeframe: 1, trigger: 'signal' }] });
  const pts = decisionPoints(cfg, { start: new Date(at(10, 0)), end: new Date(at(10, 10)) }).filter(p => p.kind === 'trade');
  assert.strictEqual(pts.length, 10);
  assert.deepStrictEqual(pts.slice(0, 3).map(p => [p.t.toISOString(), p.lanes]), [['2026-10-07T14:00:02.000Z', [3, 1]], ['2026-10-07T14:01:02.000Z', [1]], ['2026-10-07T14:02:02.000Z', [1]]]);
  // The same days, the same end of day, the same everyNth rule (over the coalesced points).
  assert.strictEqual(decisionPoints(cfg, { start: new Date(at(10, 0)), end: new Date(at(10, 10)), everyNth: 2 }).filter(p => p.kind === 'trade').length, 5);
  // Lanes a 3m runner's closes are a subset of: a 3m one-lane config's points are the 3m points of the two-lane one.
  const three = validateConfig({ ...BASE, barDelaySeconds: 2, timeframe: 3 });
  const t3 = decisionPoints(three, { start: new Date(at(9, 0)), end: new Date(at(16, 30)) });
  const both = decisionPoints(cfg, { start: new Date(at(9, 0)), end: new Date(at(16, 30)) });
  assert.deepStrictEqual(both.filter(p => p.kind !== 'trade' || p.lanes.includes(3)).map(p => [p.t.getTime(), p.kind]), t3.map(p => [p.t.getTime(), p.kind]));
  assert.ok(t3.every(p => !('lanes' in p)));
});

test('the session record: a lane\'s bar decided at its own close; the lanes on the line only with several lanes', () => {
  const cfg = validateConfig({ ...BASE, barDelaySeconds: 2, lanes: [{ timeframe: 3 }, { timeframe: 1 }] });
  assert.strictEqual(pointOf(cfg, '2026-10-07T14:02:00Z', 1).toISOString(), '2026-10-07T14:03:02.000Z');
  assert.strictEqual(pointOf(cfg, '2026-10-07T14:00:00Z').toISOString(), '2026-10-07T14:03:02.000Z', 'none: the runner\'s timeframe');
  // The record keeps a 1m bar closing inside the window that a 3m reading would put past it (10:29 close, not 10:31).
  const win = validateConfig({ ...BASE, barDelaySeconds: 2, sessions: ['10:00-10:30@America/New_York'], lanes: [{ timeframe: 3 }, { timeframe: 1 }] });
  const late1m = { symbol: 'MNQ', bar: '2026-10-07T14:28:00Z', stale: false, action: 'trade', minutes: 1 };
  assert.deepStrictEqual(tradeBars(win, [late1m]), [late1m]);
  assert.deepStrictEqual(tradeBars(win, [{ ...late1m, minutes: undefined }]), [], 'read as a 3m bar it closes at 10:31');
  // The record's lanes in the config's lane order, whatever order the bars were published in (as replay lists them).
  assert.deepStrictEqual(closedLanes(cfg, [{ minutes: 1 }, { minutes: 3 }, { minutes: 1 }]), [3, 1]);
  assert.deepStrictEqual(closedLanes(validateConfig({ ...BASE, lanes: [{ timeframe: 1 }, { timeframe: 3 }] }), [{ minutes: 3 }, { minutes: 1 }]), [1, 3]);
  assert.strictEqual(closedLanes(cfg, [{ symbol: 'MNQ' }]), null, 'one lane: no lanes');
  const tap = passTap();
  tap.begin();
  tap.bar('MNQ', { bar: 'b1', stale: false, action: 'trade' });
  tap.bar('MNQ', { bar: 'b2', stale: false, action: 'trade', minutes: 1 });
  assert.deepStrictEqual(tap.summary([]).closed, [{ symbol: 'MNQ', bar: 'b1', stale: false, action: 'trade' }, { symbol: 'MNQ', bar: 'b2', stale: false, action: 'trade', minutes: 1 }]);
  // A scan's field values join the bar of their own lane (minutes); one lane (no minutes) joins the symbol's bar as before.
  tap.bar('MNQ', { bar: 'b1', contractId: 'MNQ', values: { s3: { a: 1 } } });
  tap.bar('MNQ', { bar: 'b2', contractId: 'MNQ', values: { s1: { a: 2 } }, minutes: 1 });
  const joined = tap.summary([]).closed;
  assert.strictEqual(joined.length, 2);
  assert.deepStrictEqual(joined.map(c => [c.bar, c.minutes || null, Object.keys(c.values)]), [['b1', null, ['s3']], ['b2', 1, ['s1']]]);
  assert.deepStrictEqual(tap.summary([]).values.map(v => [v.barT, Object.keys(v.strategies)]), [['b1', ['s3']], ['b2', ['s1']]]);
  const one = passTap();
  one.begin();
  one.bar('MNQ', { bar: 'b1', stale: false, action: 'trade' });
  one.bar('MNQ', { bar: 'b1', contractId: 'MNQ', values: { s3: { a: 1 } } });
  assert.deepStrictEqual(one.summary([]).closed, [{ symbol: 'MNQ', bar: 'b1', stale: false, action: 'trade', contractId: 'MNQ', values: { s3: { a: 1 } } }]);
  const base = { t: 'x', day: 'd', kind: 'trade', pass: { asked: 'trade' }, step: {}, cycles: [], refusals: [], trades: null, since: null };
  assert.ok(!('lanes' in decisionRecord(base)));
  assert.ok(!('lanes' in decisionRecord({ ...base, lanes: [] })));
  assert.deepStrictEqual(decisionRecord({ ...base, lanes: [3, 1] }).lanes, [3, 1]);
});

test('runner wiring: a replay pass (FTH_REPLAY_NOW) holds no cycle for a late lane; the live loop keeps the default hold', () => {
  const { passHold } = require('../../scripts/lib/runner-wiring');
  assert.deepStrictEqual(passHold({ FTH_REPLAY_NOW: '2026-10-07T14:03:02Z' }), { coalesceHoldMs: 0 });
  assert.deepStrictEqual(passHold({}), {});
  assert.deepStrictEqual(passHold({ FTH_REPLAY_NOW: '' }), {});
});

test('boundHistory / laneHistory: 10 decisions kept per lane; a cycle shows each closed lane\'s last 10, the first lane\'s and an open trade lane\'s last 3', () => {
  const h = (n, lanes) => ({ at: `t${String(n).padStart(3, '0')}`, symbols: ['MNQ'], result: `r${n}`, ...(lanes ? { lanes } : {}) });
  // 5 15m decisions, then 40 1m ones: the 15m ones are never evicted.
  const hist = [...Array.from({ length: 5 }, (_, k) => h(k, ['15m'])), ...Array.from({ length: 40 }, (_, k) => h(100 + k, ['1m']))];
  const kept = LC.boundHistory(hist, '15m');
  assert.deepStrictEqual(kept.filter(x => x.lanes[0] === '15m').map(x => x.result), ['r0', 'r1', 'r2', 'r3', 'r4']);
  assert.deepStrictEqual(kept.filter(x => x.lanes[0] === '1m').map(x => x.result), Array.from({ length: 10 }, (_, k) => `r${130 + k}`));
  // A shared close counts for both lanes; an untagged (older) entry is the first lane's.
  const mixed = LC.boundHistory([h(1), ...Array.from({ length: 12 }, (_, k) => h(10 + k, ['15m', '1m']))], '15m');
  assert.strictEqual(mixed.length, 10, 'both lanes full at 10');
  assert.strictEqual(LC.boundHistory([h(1)], '15m').length, 1);
  // A 1m-only cycle: the 1m lane's last 10 and the first lane's last 3, oldest first.
  const many = [...Array.from({ length: 6 }, (_, k) => h(k, ['15m'])), ...Array.from({ length: 14 }, (_, k) => h(100 + k, ['1m']))];
  const oneMin = LC.laneHistory(many, { closed: ['1m'], first: '15m' });
  assert.deepStrictEqual(oneMin.map(x => x.result), ['r3', 'r4', 'r5', ...Array.from({ length: 10 }, (_, k) => `r${104 + k}`)]);
  // A 15m close (also a 1m close): each lane's own last 10.
  const both = LC.laneHistory(many, { closed: ['15m', '1m'], first: '15m' });
  assert.deepStrictEqual(both.filter(x => x.lanes[0] === '15m').map(x => x.result), ['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
  assert.strictEqual(both.filter(x => x.lanes[0] === '1m').length, 10);
  // An open trade entered on a 5m lane: its last 3 too, in a 1m-only cycle.
  const withFive = [...many, h(200, ['5m']), h(201, ['5m']), h(202, ['5m']), h(203, ['5m'])];
  const open = LC.laneHistory(withFive, { closed: ['1m'], first: '15m', open: ['5m'] });
  assert.deepStrictEqual(open.filter(x => x.lanes[0] === '5m').map(x => x.result), ['r201', 'r202', 'r203']);
  assert.ok(!LC.laneHistory(withFive, { closed: ['1m'], first: '15m' }).some(x => x.lanes[0] === '5m'), 'no open trade: not shown');
  assert.deepStrictEqual(LC.laneHistory([], { closed: ['1m'], first: '3m' }), []);
});

test('laneBarsOf: the other lanes\' bars that closed this cycle, by family root and minutes; the first lane\'s are its briefing', () => {
  const items = [
    { symbol: 'MNQ', lane: 0, minutes: 3, bar: { t: '2026-10-07T13:57:00.000Z' } },
    { symbol: 'MNQ', lane: 1, minutes: 1, bar: { t: '2026-10-07T13:59:00.000Z' } },
    { symbol: 'MES', lane: 2, minutes: 5, bar: { t: '2026-10-07T13:55:00.000Z' } },
    { symbol: 'MES', lane: 1, minutes: 1, bar: {} },
  ];
  assert.deepStrictEqual(LC.laneBarsOf(items), { MNQ: { 1: '2026-10-07T13:59:00.000Z' }, MES: { 5: '2026-10-07T13:55:00.000Z' } });
  assert.deepStrictEqual(LC.laneBarsOf([]), {});
  assert.deepStrictEqual(LC.laneBarsOf(null), {});
});
