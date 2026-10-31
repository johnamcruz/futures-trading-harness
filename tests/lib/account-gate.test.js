'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseToolJson, netPosition, pendingNet, pendingState, fillLossState, evaluateAccount: rawEvaluate, evaluateCancel, evaluateModifyAccount, evaluatePartialClose, evaluateAccountChange } = require('../../scripts/lib/trading/account-gate');
const evaluateAccount = o => rawEvaluate({ positions: [], orders: [], trades: [], ...o });
const { loadConfig } = require('../../scripts/lib/trading/config');
const { CONTRACT, NOW, minutesAgo } = require('../helpers');

const config = loadConfig({});
const long1 = [{ contractId: CONTRACT, type: 1, size: 1 }];
const order = (extra = {}) => ({ accountId: 1, contractId: CONTRACT, side: 'buy', type: 'market', size: 1, rationale: 'setup:orb long, stop 1', ...extra });
const checks = v => v.map(x => x.check);
const fill = (min, pnl, extra = {}) => ({ contractId: CONTRACT, creationTimestamp: minutesAgo(min), profitAndLoss: pnl, ...extra });

test('parseToolJson reads JSON text and throws on errors', () => {
  assert.deepStrictEqual(parseToolJson({ content: [{ type: 'text', text: '[1]' }] }, 't'), [1]);
  assert.throws(() => parseToolJson({ isError: true, content: [{ text: 'boom' }] }, 't'), /t failed: boom/);
  assert.throws(() => parseToolJson({ content: [{ text: 'nope' }] }, 't'), /non-JSON/);
  assert.throws(() => parseToolJson(null, 't'), /failed/);
});

test('netPosition sums long and short positions for the contract only', () => {
  assert.strictEqual(netPosition([...long1, { contractId: CONTRACT, type: 2, size: 3 }, { contractId: 'X', type: 1, size: 9 }], CONTRACT), -2);
  assert.strictEqual(netPosition([], CONTRACT), 0);
});

test('[exit]/[protect] must reduce a real position', () => {
  const exitBuy = order({ rationale: '[exit] take profit' });
  assert.deepStrictEqual(checks(evaluateAccount({ input: exitBuy, positions: [], config })), ['exposure']); // flat
  assert.match(evaluateAccount({ input: exitBuy, positions: long1, config })[0].message, /same side/);
  assert.match(evaluateAccount({ input: order({ side: 'sell', size: 2, rationale: '[exit] x' }), positions: long1, config })[0].message, /exceeds/);
  assert.deepStrictEqual(evaluateAccount({ input: order({ side: 'sell', rationale: '[exit] x' }), positions: long1, config }), []);
});

test('[protect] stops and limits may not stack beyond the position (one of each is fine)', () => {
  const stop = order({ side: 'sell', type: 'stop', stopPrice: 1, rationale: '[protect] stop' });
  const restingStop = [{ contractId: CONTRACT, side: 1, type: 4, size: 1 }];
  assert.deepStrictEqual(evaluateAccount({ input: stop, positions: long1, orders: [], config }), []);
  assert.match(evaluateAccount({ input: stop, positions: long1, orders: restingStop, config })[0].message, /already has working stops for 1/);
  // A limit beside the stop, [protect] or [exit], is a stand-alone target: the bracket rule below refuses it.
  const target = order({ side: 'sell', type: 'limit', limitPrice: 2, rationale: '[exit] target' });
  assert.deepStrictEqual(checks(evaluateAccount({ input: target, positions: long1, orders: restingStop, config })), ['bracket-only']);
});

test('the bracket rule: no separate [protect] beside the working stop (modify the bracket); a lost bracket still gets its stop', () => {
  const stopIn = (extra = {}) => order({ side: 'sell', type: 'stop', stopPrice: 1, rationale: '[protect] stop', ...extra });
  const stop1 = { contractId: CONTRACT, side: 1, type: 4, size: 1 };
  const long2 = [{ contractId: CONTRACT, type: 1, size: 2 }];
  const run = (input, positions, orders, cfg = config) => evaluateAccount({ input, positions, orders, config: cfg });
  // A [protect] limit (a stand-alone target), by name or by the broker's numeric type, beside the stop: refused.
  for (const type of ['limit', 'join_ask', 'join_bid', 1, '7']) {
    const v = run(order({ side: 'sell', type, limitPrice: 2, rationale: '[protect] target' }), long1, [stop1]);
    assert.deepStrictEqual(checks(v), ['bracket-only'], String(type));
    assert.match(v[0].message, /modify the bracket's stop\/target with modify_order/);
  }
  // A second [protect] stop when the stops already cover the position: refused, and never skippable.
  const skipAll = { ...config, skipChecks: new Set(['bracket-only', 'exposure']) };
  for (const type of ['stop', 'trailing_stop']) assert.deepStrictEqual(checks(run(stopIn({ type }), long2, [{ ...stop1, size: 2 }])), ['bracket-only'], type);
  assert.deepStrictEqual(checks(run(stopIn({ size: 1 }), long2, [{ ...stop1, size: 2 }], skipAll)), ['bracket-only'], 'hard');
  assert.deepStrictEqual(checks(run(order({ side: 'sell', type: 'limit', limitPrice: 2, rationale: '[protect] t' }), long1, [stop1], skipAll)), ['bracket-only'], 'hard');
  // Risk reduction always goes: a [protect] stop with no working stop (a lost bracket), or for the part no stop covers.
  assert.deepStrictEqual(run(stopIn(), long1, []), [], 'no stop working');
  assert.deepStrictEqual(run(stopIn(), long2, [stop1]), [], 'one of two uncovered');
  // A stop on another month, or on the position's own side (an entry's), covers nothing here.
  assert.deepStrictEqual(run(stopIn(), long1, [{ ...stop1, contractId: 'MNQ:2027-03' }]), [], 'another month');
  assert.deepStrictEqual(run(stopIn(), long1, [{ ...stop1, side: 0 }]), [], 'not protective');
  // An [exit] (market or limit, whole or part), and a market [protect], go beside the stop.
  assert.deepStrictEqual(run(order({ side: 'sell', rationale: '[exit] out' }), long1, [stop1]), []);
  assert.deepStrictEqual(checks(run(order({ side: 'sell', type: 'limit', limitPrice: 2, rationale: '[exit] scale out' }), long2, [{ ...stop1, size: 2 }])), ['bracket-only'], 'a limit [exit]: refused');
  assert.deepStrictEqual(run(order({ side: 'sell', rationale: '[protect] out at market' }), long1, [stop1]), []);
  // A short: its buy-side stop covers it.
  const short1 = [{ contractId: CONTRACT, type: 2, size: 1 }];
  assert.deepStrictEqual(checks(run(order({ side: 'buy', type: 'stop', stopPrice: 9, rationale: '[protect] stop' }), short1, [{ ...stop1, side: 0 }])), ['bracket-only']);
  assert.deepStrictEqual(run(order({ side: 'buy', type: 'stop', stopPrice: 9, rationale: '[protect] stop' }), short1, []), []);
});

test('a refused config file (config.configCritical): every entry is refused with the critical error, never skippable; exits and stops still go', () => {
  assert.strictEqual(config.configCritical, null, 'the committed files: no critical error');
  const critical = { ...config, configCritical: 'CRITICAL config error: the runner config (x) is refused: gate.x: missing', skipChecks: new Set(['config-critical', 'position-open']) };
  const v = evaluateAccount({ input: order(), positions: [], config: critical });
  assert.deepStrictEqual(checks(v), ['config-critical']);
  assert.match(v[0].message, /^CRITICAL config error: the runner config \(x\) is refused: gate\.x: missing Exits, protective stops, cancels and close_position still go\.$/);
  assert.deepStrictEqual(evaluateAccount({ input: order({ side: 'sell', rationale: '[exit] x' }), positions: long1, config: critical }), []);
  assert.deepStrictEqual(evaluateAccount({ input: order({ side: 'sell', type: 'stop', stopPrice: 1, rationale: '[protect] stop' }), positions: long1, config: critical }), []);
  // An [exit] still has to reduce a real position (the built-in values judge it as usual).
  assert.deepStrictEqual(checks(evaluateAccount({ input: order({ rationale: '[exit] x' }), positions: [], config: critical })), ['exposure']);
});

test('modify_order under a refused config file: an entry order is not resized or repriced (never skippable); a protective stop or target, and a stop move, still go', () => {
  const critical = { ...config, configCritical: 'CRITICAL config error: the training config (x) is refused', skipChecks: new Set(['config-critical', 'modify-entry', 'modify-size']) };
  const run = (input, positions, orders) => evaluateModifyAccount({ input, positions, orders, config: critical });
  const entry = { id: 31, contractId: CONTRACT, side: 0, type: 1, size: 2, limitPrice: 21400 };
  for (const input of [{ orderId: 31, limitPrice: 21390 }, { orderId: 31, limitPrice: 21410 }, { orderId: 31, size: 1 }, { orderId: 31, size: 3 }]) {
    const v = run(input, [], [entry]);
    assert.deepStrictEqual(checks(v), ['config-critical'], JSON.stringify(input));
    assert.match(v[0].message, /^CRITICAL config error: the training config \(x\) is refused Order 31 is an entry/);
  }
  const long2 = [{ contractId: CONTRACT, type: 1, size: 2 }];
  const stop = { id: 9, contractId: CONTRACT, side: 1, type: 4, size: 2, stopPrice: 21480 };
  const target = { id: 12, contractId: CONTRACT, side: 1, type: 1, size: 2, limitPrice: 21600 };
  assert.deepStrictEqual(run({ orderId: 9, stopPrice: 21490 }, long2, [stop, target]), [], 'a stop move toward the market');
  assert.deepStrictEqual(run({ orderId: 12, limitPrice: 21580 }, long2, [stop, target]), [], 'a target');
  assert.deepStrictEqual(checks(run({ orderId: 9, stopPrice: 21470 }, long2, [stop, target])), ['modify-protection'], 'a stop loosened is still refused');
  // An entry order beside an open position is still an entry.
  assert.deepStrictEqual(checks(run({ orderId: 31, limitPrice: 21390 }, long2, [stop, entry])), ['config-critical']);
});

test('modify_order under a refused config file: a bracket stop or target of a working entry may only lose risk (a smaller size, a stop toward the entry)', () => {
  const critical = { ...config, configCritical: 'CRITICAL config error: the training config (x) is refused', skipChecks: new Set(['config-critical', 'modify-entry', 'modify-size']) };
  const run = (input, orders) => evaluateModifyAccount({ input, positions: [], orders, config: critical });
  // A long entry (buy limit 21400, 2 lots) with its bracket: a stop 21380 and a target 21440.
  const entry = { id: 31, contractId: CONTRACT, side: 0, type: 1, size: 2, limitPrice: 21400 };
  const stop = { id: 32, contractId: CONTRACT, side: 1, type: 4, size: 2, stopPrice: 21380 };
  const stop2 = { id: 34, contractId: CONTRACT, side: 1, type: 4, size: 1, stopPrice: 21380 };
  const target = { id: 33, contractId: CONTRACT, side: 1, type: 1, size: 2, limitPrice: 21440 };
  const book = [entry, stop, target];
  const ok = input => assert.deepStrictEqual(run(input, book), [], JSON.stringify(input));
  const refused = (input, orders = book) => assert.deepStrictEqual(checks(run(input, orders)), ['config-critical'], JSON.stringify(input));
  ok({ orderId: 32, stopPrice: 21390 }); // tightened toward the entry
  ok({ orderId: 32, stopPrice: 21400 }); // up to the entry price
  ok({ orderId: 33, size: 1 }); // a target cut
  assert.deepStrictEqual(run({ orderId: 32, size: 1 }, [entry, stop, stop2, target]), [], 'a stop cut that the other stops still cover');
  refused({ orderId: 32, stopPrice: 21370 }); // loosened
  refused({ orderId: 32, stopPrice: 21410 }); // past the entry
  refused({ orderId: 32, stopPrice: 21380 }); // not moved
  refused({ orderId: 32, size: 1 }); // leaves 1 of 2 without a stop
  refused({ orderId: 32, size: 3 }); // larger
  refused({ orderId: 33, size: 3 });
  refused({ orderId: 33, limitPrice: 21420 }); // a target is not repriced
  refused({ orderId: 32, size: 1, stopPrice: 21370 }); // a good cut cannot carry a bad move
  refused({ orderId: 32, trailPrice: 21390 });
  refused({ orderId: 32, stopPrice: 21390, limitPrice: 21385 }); // a good stop move cannot carry another price field
  refused({ orderId: 31, limitPrice: 21390 }); // the entry itself
  refused({ orderId: 31, limitPrice: 21410 });
  refused({ orderId: 31, size: 3 });
  refused({ orderId: 31, size: 1 });
  refused({ orderId: 32 }); // nothing to cut
  refused({ orderId: 32, stopPrice: 21390 }, [stop, target]); // no working entry: a leftover
  refused({ orderId: 32, stopPrice: 21390 }, [{ ...entry, limitPrice: undefined, type: 2 }, stop]); // an entry without a price
  refused({ orderId: 32, stopPrice: 21370 }, [entry, { ...stop, stopPrice: 21395 }]); // a stop above... still loosened
  // A short entry mirrors: sell limit 21400 with a buy stop 21420.
  const sEntry = { ...entry, side: 1 };
  const sStop = { id: 35, contractId: CONTRACT, side: 0, type: 4, size: 2, stopPrice: 21420 };
  assert.deepStrictEqual(run({ orderId: 35, stopPrice: 21410 }, [sEntry, sStop]), []);
  assert.deepStrictEqual(checks(run({ orderId: 35, stopPrice: 21430 }, [sEntry, sStop])), ['config-critical']);
  assert.deepStrictEqual(checks(run({ orderId: 35, stopPrice: 21390 }, [sEntry, sStop])), ['config-critical'], 'past the entry');
});

test('entries are refused while a position is open', () => {
  assert.deepStrictEqual(checks(evaluateAccount({ input: order(), positions: long1, config })), ['position-open']);
  assert.deepStrictEqual(evaluateAccount({ input: order(), positions: [], config }), []);
});

test('loss streak and daily losses come from real closing fills', () => {
  const opening = fill(100, null);
  const streak = [opening, fill(90, -20), fill(15, -12.5), fill(14, 0)];
  assert.deepStrictEqual(fillLossState(streak).streak, 2);
  const v = evaluateAccount({ input: order(), trades: streak, now: NOW, config });
  assert.deepStrictEqual(checks(v), ['loss-streak']);
  assert.deepStrictEqual(checks(evaluateAccount({ input: order(), trades: [fill(200, -1), fill(150, 5), fill(120, -1), fill(110, 3), fill(100, -1)], now: NOW, config })), ['daily-loss-count']);
  assert.deepStrictEqual(evaluateAccount({ input: order(), trades: [fill(20, -5, { voided: true })], now: NOW, config }), []);
});

test('the gateway counts the losses an attempt carried into the day (a seeded practice state) on top of the fills; exits never read them', () => {
  const carried = { losses: 2, streak: 1, lastLossMs: Date.parse(minutesAgo(50)) };
  // Two carried and one losing close today: the daily count (3).
  assert.deepStrictEqual(fillLossState([fill(30, null), fill(20, -5)], carried), { streak: 2, losses: 3, lastLossTs: Date.parse(minutesAgo(20)) });
  assert.deepStrictEqual(checks(evaluateAccount({ input: order(), trades: [fill(30, null), fill(20, -5)], now: NOW, config, carried })), ['loss-streak', 'daily-loss-count']);
  // A win today ends the carried streak; the count still holds the carried losses.
  assert.deepStrictEqual(fillLossState([fill(30, 8)], carried), { streak: 0, losses: 2, lastLossTs: carried.lastLossMs });
  assert.deepStrictEqual(evaluateAccount({ input: order(), trades: [fill(30, 8)], now: NOW, config, carried }), []);
  // The carried streak's cooldown runs from its last loss: 2 in a row 10 minutes ago, 20 minutes more.
  const cooling = evaluateAccount({ input: order(), trades: [], now: NOW, config, carried: { losses: 2, streak: 2, lastLossMs: Date.parse(minutesAgo(10)) } });
  assert.deepStrictEqual(checks(cooling), ['loss-streak']);
  assert.match(cooling[0].message, /20 min more/);
  // Three carried: done for the day with no fill at all.
  assert.deepStrictEqual(checks(evaluateAccount({ input: order(), trades: [], now: NOW, config, carried: { losses: 3, streak: 0, lastLossMs: null } })), ['daily-loss-count']);
  // An exit never reads them.
  assert.deepStrictEqual(evaluateAccount({ input: order({ side: 'sell', rationale: '[exit] x' }), positions: long1, now: NOW, config, carried: { losses: 9, streak: 9, lastLossMs: NOW.getTime() } }), []);
  // Malformed carried counts add nothing (never fewer than the fills).
  assert.deepStrictEqual(fillLossState([fill(20, -5)], { losses: -4, streak: 'x', lastLossMs: NaN }), { streak: 1, losses: 1, lastLossTs: Date.parse(minutesAgo(20)) });
});

test('missing account data blocks instead of reading as flat; unknown position types throw', () => {
  assert.throws(() => rawEvaluate({ input: order(), positions: null, orders: [], trades: [], config }), /positions from the server is not a list/);
  assert.throws(() => netPosition([{ contractId: CONTRACT, type: 9, size: 1 }], CONTRACT), /unknown type/);
});

test('a position whose size can\'t be read is never a flat account: entries, exits, the prop rule and cancels all refuse', () => {
  const odd = [{ contractId: CONTRACT, type: 1, quantity: 1 }];
  assert.throws(() => evaluateAccount({ input: order(), positions: odd, config }), /no valid size/);
  assert.throws(() => evaluateAccount({ input: order({ side: 'sell', rationale: '[exit] flatten' }), positions: odd, config }), /no valid size/);
  assert.throws(() => evaluateAccount({ input: order(), positions: [{ contractId: 'MES', type: 1, size: 1.5 }], config, propAttempt: 'topstep_50k' }), /no valid size/);
  const stop = [{ id: 9, contractId: CONTRACT, side: 1, type: 4, size: 1, stopPrice: 21480 }];
  assert.throws(() => evaluateCancel({ input: { orderId: 9 }, positions: odd, orders: stop, config, now: NOW }), /no valid size/);
  // A bad row in another market never keeps an exit or a protective stop from its own position; an entry still refuses.
  const elsewhere = [{ contractId: CONTRACT, type: 1, size: 1 }, { contractId: 'CL', type: 1, size: null }];
  const protect = order({ side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the long' });
  assert.deepStrictEqual(evaluateAccount({ input: protect, positions: elsewhere, config }).map(v => v.check), []);
  assert.throws(() => evaluateAccount({ input: order(), positions: elsewhere, config }), /CL has no valid size/);
});

test('modify_order: a stop can\'t be moved once a close sent moments ago leaves it protecting nothing', () => {
  const stop = [{ id: 9, contractId: CONTRACT, side: 1, type: 4, size: 1, stopPrice: 21480 }];
  const close = [{ contractId: CONTRACT, sign: -1, size: 1, netBefore: 1, at: NOW.getTime(), sentAt: NOW.getTime() }];
  const run = (input, ledger) => checks(evaluateModifyAccount({ input, positions: long1, orders: stop, config, ledger, now: NOW }));
  assert.deepStrictEqual(run({ orderId: 9, stopPrice: 21600 }, []), [], 'no close sent: toward the market is fine');
  assert.deepStrictEqual(run({ orderId: 9, stopPrice: 21600 }, close), ['modify-entry'], 'after the close: it would open a short');
  // A partial close (2 -> 1) sent but not shown yet: the stop is cut to 1 only once the account shows 1
  // (if the close doesn't fill, a 1-lot stop would leave a contract unprotected), as before.
  const long2 = [{ contractId: CONTRACT, type: 1, size: 2 }];
  const stop2 = [{ ...stop[0], size: 2 }];
  const partial = [{ ...close[0], netBefore: 2 }];
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 9, size: 1, reason: '[protect] cut' }, positions: long2, orders: stop2, config, ledger: partial, now: NOW })), ['modify-size']);
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 9, size: 1, reason: '[protect] cut' }, positions: long1, orders: stop2, config, ledger: partial, now: NOW })), [], 'once it shows');
  // Moving the 2-lot stop after the partial close: on this side it exceeds the projected 1 and could flip it.
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 9, stopPrice: 21500 }, positions: long2, orders: stop2, config, ledger: partial, now: NOW })), ['modify-protection']);
});

test('partial_close_position: needs an open position in that month and a size within it, now and once recent orders fill', () => {
  const run = (input, positions = long1, ledger = []) => checks(evaluatePartialClose({ input: { accountId: 1, contractId: CONTRACT, ...input }, positions, orders: [], config, ledger, now: NOW }));
  assert.deepStrictEqual(run({ size: 1 }), []);
  assert.deepStrictEqual(run({ size: 50 }), ['partial-close'], 'over the position: it would reverse it');
  assert.deepStrictEqual(run({ size: 1 }, []), ['partial-close'], 'no position');
  assert.deepStrictEqual(run({ size: 0 }), ['partial-close']);
  assert.deepStrictEqual(run({ size: 1.5 }), ['partial-close']);
  const close = [{ contractId: CONTRACT, sign: -1, size: 1, netBefore: 1, at: NOW.getTime() }];
  assert.deepStrictEqual(run({ size: 1 }, long1, close), ['partial-close'], 'a close sent moments ago leaves nothing to reduce');
  assert.throws(() => run({ size: 1 }, [{ contractId: CONTRACT, type: 1 }]), /no valid size/);
  assert.deepStrictEqual(checks(evaluateAccountChange('partial_close_position', { input: { contractId: CONTRACT, size: 5 }, positions: long1, orders: [], config, now: NOW })), ['partial-close']);
  assert.throws(() => evaluateAccountChange('close_position', { input: {}, positions: [], orders: [], config, now: NOW }), /no account check/);
});

test('positions in another month of the same root count (no entry on H27 while long Z26)', () => {
  const h27 = order({ contractId: 'MNQ:2027-03' });
  assert.deepStrictEqual(checks(evaluateAccount({ input: h27, positions: long1, config })), ['position-open']);
});

test('join_bid/join_ask exits rest by definition: refused (the bracket rule)', () => {
  const restingJoins = [{ contractId: CONTRACT, side: 1, type: 7, size: 1 }];
  const join = order({ side: 'sell', type: 'join_ask', rationale: '[exit] scale out' });
  for (const orders of [restingJoins, []]) assert.deepStrictEqual(checks(evaluateAccount({ input: join, positions: long1, orders, config })), ['bracket-only']);
});

test('the bracket rule: every limit or join [exit] is refused, with or without a working stop, hard; a market [exit] goes', () => {
  const stop1 = [{ contractId: CONTRACT, side: 1, type: 4, size: 1 }];
  const run = (input, orders = stop1, positions = long1) => evaluateAccount({ input, positions, orders, config: { ...config, skipChecks: new Set(['bracket-only', 'exposure']) } });
  for (const type of ['limit', 'join_bid', 'join_ask', 'LIMIT']) {
    const v = run(order({ side: 'sell', type, limitPrice: 21490, rationale: '[exit] take profit' }));
    assert.deepStrictEqual(checks(v), ['bracket-only'], type);
    assert.match(v[0].message, /trailing the bracket stop with modify_order.*market \[exit\]/);
    assert.deepStrictEqual(checks(run(order({ side: 'sell', type, limitPrice: 21490, rationale: '[exit] take profit' }), [])), ['bracket-only'], `${type}, no stop working`);
  }
  const short1 = [{ contractId: CONTRACT, type: 2, size: 1 }];
  assert.deepStrictEqual(checks(run(order({ side: 'buy', type: 'limit', limitPrice: 21510, rationale: '[exit] out' }), [{ ...stop1[0], side: 0 }], short1)), ['bracket-only']);
  assert.deepStrictEqual(run(order({ side: 'sell', rationale: '[exit] now' })), [], 'a market [exit] goes');
  assert.deepStrictEqual(run(order({ side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[exit] stop out' }), []), [], 'a stop [exit] with no working stop: protection');
  // Beside a stop that covers the position: a second stop by another name, refused as a [protect] stop is (hard).
  for (const type of ['stop', 'trailing_stop']) {
    const v = run(order({ side: 'sell', type, stopPrice: 21480, rationale: '[exit] stop out' }));
    assert.deepStrictEqual(checks(v), ['bracket-only'], type);
    assert.match(v[0].message, /a second stop \(\[protect\] or \[exit\]\).*modify_order/);
  }
  const long2 = [{ contractId: CONTRACT, type: 1, size: 2 }];
  assert.deepStrictEqual(run(order({ side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[exit] stop out' }), stop1, long2), [], 'the part no stop covers');
});

test('ledger: an entry sent moments ago blocks a second entry and caps exits until the account reflects it', () => {
  const now = new Date();
  const ledger = [{ contractId: CONTRACT, sign: 1, size: 1, netBefore: 0, at: now.getTime() - 1000 }];
  assert.strictEqual(pendingNet(ledger, CONTRACT, 0, now), 1);
  assert.deepStrictEqual(checks(evaluateAccount({ input: order(), positions: [], ledger, now, config })), ['position-open']);
  // Once positions show the fill (net changed), the ledger entry no longer counts.
  assert.strictEqual(pendingNet(ledger, CONTRACT, 1, now), 0);
  // Stale entries expire.
  assert.strictEqual(pendingNet([{ ...ledger[0], at: now.getTime() - 60000 }], CONTRACT, 0, now), 0);
  // Two quick [exit] sells against long 1: the second sees the first as pending and is refused.
  const exitLedger = [{ contractId: CONTRACT, sign: -1, size: 1, netBefore: 1, at: now.getTime() }];
  assert.match(evaluateAccount({ input: order({ side: 'sell', rationale: '[exit] x' }), positions: long1, ledger: exitLedger, now, config })[0].message, /no open/);
});

// The runner's own gateway (FTH_RUNNER_GATEWAY): its cancels are judged by cancel-protection; a model's never cancels a leg.
const runnerConfig = { ...config, runnerGateway: true };

test('cancel_order (the model): no leg of an open position\'s bracket, stop or target, is cancelled; hard; flat or closed, it may go', () => {
  const stop = { id: 11, contractId: CONTRACT, side: 1, type: 4, size: 1 };
  const target = { id: 12, contractId: CONTRACT, side: 1, type: 1, size: 1 };
  for (const id of [11, 12]) {
    const v = evaluateCancel({ input: { orderId: id }, positions: long1, orders: [stop, target], config: { ...config, skipChecks: new Set(['bracket-leg', 'cancel-protection']) } });
    assert.deepStrictEqual(checks(v), ['bracket-leg'], String(id));
    assert.match(v[0].message, /the runner manages the bracket.*modify_order/);
  }
  // Two stops: neither is the last, still a leg.
  assert.deepStrictEqual(checks(evaluateCancel({ input: { orderId: 11 }, positions: long1, orders: [stop, { ...stop, id: 13 }], config })), ['bracket-leg']);
  // The server's bracket role decides when given: a leg marked target of any type; absent, the type (never "no bracket").
  assert.deepStrictEqual(checks(evaluateCancel({ input: { orderId: 14 }, positions: long1, orders: [stop, { id: 14, contractId: CONTRACT, side: 1, type: 2, size: 1, bracket: { role: 'target' } }], config })), ['bracket-leg']);
  // A short's legs are buys.
  const short1 = [{ contractId: CONTRACT, type: 2, size: 1 }];
  assert.deepStrictEqual(checks(evaluateCancel({ input: { orderId: 11 }, positions: short1, orders: [{ ...stop, side: 0 }], config })), ['bracket-leg']);
  // Flat, an order on the position's own side (an entry), another month, or a close the gateway sent: it may go.
  assert.deepStrictEqual(evaluateCancel({ input: { orderId: 11 }, positions: [], orders: [stop], config }), []);
  assert.deepStrictEqual(evaluateCancel({ input: { orderId: 15 }, positions: long1, orders: [stop, { id: 15, contractId: CONTRACT, side: 0, type: 1, size: 1 }], config }), []);
  assert.deepStrictEqual(evaluateCancel({ input: { orderId: 16 }, positions: long1, orders: [stop, { ...target, id: 16, contractId: 'MNQ:2027-03' }], config }), []);
  const closed = [{ contractId: CONTRACT, root: 'MNQ', sign: -1, size: 1, netBefore: 1, rootNetBefore: 1, at: NOW.getTime() - 1000 }];
  assert.deepStrictEqual(evaluateCancel({ input: { orderId: 12 }, positions: long1, orders: [stop, target], config, ledger: closed, now: NOW }), []);
});

test('cancel_order may not remove the last protective stop of an open position', () => {
  const config = runnerConfig;
  const stop = { id: 11, contractId: CONTRACT, side: 1, type: 4, size: 1 };
  const target = { id: 12, contractId: CONTRACT, side: 1, type: 1, size: 1 };
  assert.match(evaluateCancel({ input: { orderId: 11 }, positions: long1, orders: [stop, target], config })[0].message, /protective stop/);
  assert.deepStrictEqual(evaluateCancel({ input: { orderId: 12 }, positions: long1, orders: [stop, target], config }), []);
  assert.deepStrictEqual(evaluateCancel({ input: { orderId: 11 }, positions: [], orders: [stop], config }), []);
  assert.deepStrictEqual(evaluateCancel({ input: { orderId: 11 }, positions: long1, orders: [stop, { ...stop, id: 13 }], config }), []);
});

test('cancel_order: a close the gateway sent and the server confirmed counts before the account shows it', () => {
  const config = runnerConfig;
  const now = new Date('2026-10-07T14:00:00Z');
  const stop = { id: 11, contractId: 'MNQ', type: 4, side: 1, size: 1, stopPrice: 21480 };
  const long1 = [{ contractId: 'MNQ', type: 1, size: 1 }];
  const closed = [{ contractId: 'MNQ', root: 'MNQ', sign: -1, size: 1, netBefore: 1, rootNetBefore: 1, at: now.getTime() - 1000 }];
  assert.deepStrictEqual(evaluateCancel({ input: { orderId: 11 }, positions: long1, orders: [stop], config, ledger: closed, now }), []);
  // A stale entry, or one on another contract, doesn't count.
  const stale = [{ ...closed[0], at: now.getTime() - 60000 }];
  assert.match(evaluateCancel({ input: { orderId: 11 }, positions: long1, orders: [stop], config, ledger: stale, now })[0].message, /protective stop/);
  const other = [{ ...closed[0], contractId: 'MNQ:2027-03' }];
  assert.match(evaluateCancel({ input: { orderId: 11 }, positions: long1, orders: [stop], config, ledger: other, now })[0].message, /protective stop/);
});

test('cancel_order: a resting [exit] target in the ledger hasn\'t changed the position, so the only stop stays', () => {
  const config = runnerConfig;
  const orders = [{ id: 9, contractId: CONTRACT, side: 1, type: 4, size: 1, stopPrice: 21480 }, { id: 55, contractId: CONTRACT, side: 1, type: 1, size: 1, limitPrice: 21600 }];
  const ledger = [{ contractId: CONTRACT, sign: -1, size: 1, netBefore: 1, at: NOW.getTime(), orderId: '55' }];
  assert.deepStrictEqual(checks(evaluateCancel({ input: { orderId: 9 }, positions: long1, orders, config, ledger, now: NOW })), ['cancel-protection']);
});

test('cancel_order: an entry still working (perhaps filled in part) keeps its bracket stop protecting it', () => {
  // The gateway sent buy 2 (order 77); it still works with 1 left while positions lag: flat on the account.
  const orders = [{ id: 9, contractId: CONTRACT, side: 1, type: 4, size: 2, stopPrice: 21480 }, { id: 77, contractId: CONTRACT, side: 0, type: 1, size: 1, limitPrice: 21500 }];
  const ledger = [{ contractId: CONTRACT, sign: 1, size: 2, netBefore: 0, at: NOW.getTime(), orderId: '77' }];
  assert.deepStrictEqual(checks(evaluateCancel({ input: { orderId: 9 }, positions: [], orders, config, ledger, now: NOW })), ['cancel-protection']);
});

// A fill reported late (2026-10-30, the goal regression's late-fill-long): the entry reads filled in search_orders,
// its fill isn't listed yet, and the position read shows nothing. The bracket stop is the position's only protection.
const lateFill = (side, extra = {}) => {
  const entry = { id: 11, contractId: CONTRACT, side, type: 2, size: 9, status: 2, fillVolume: 9 };
  const stop = { id: 12, contractId: CONTRACT, side: 1 - side, type: 4, size: 9, status: 1, stopPrice: side === 0 ? 21480 : 21520 };
  return { input: { orderId: 12 }, positions: [], orders: [stop], fills: [], history: [entry, stop], now: NOW, ...extra };
};

test('cancel_order: a fill reported late (the position read flat, the entry filled) keeps the bracket stop, long and short, for the runner\'s and a model\'s gateway', () => {
  for (const side of [0, 1]) {
    for (const c of [runnerConfig, config]) {
      const v = evaluateCancel({ ...lateFill(side), config: c });
      assert.deepStrictEqual(checks(v), ['cancel-protection'], `side ${side}`);
      assert.match(v[0].message, /position read doesn't show yet.*(long|short) 9/);
    }
  }
  // Through evaluateAccountChange, as the gateway calls it.
  assert.deepStrictEqual(checks(evaluateAccountChange('cancel_order', { ...lateFill(0), config: runnerConfig })), ['cancel-protection']);
  // The fills listing the entry but not its close count too (fills that don't net to zero).
  const listed = lateFill(0, { fills: [{ orderId: 11, contractId: CONTRACT, side: 0, size: 9 }] });
  assert.deepStrictEqual(checks(evaluateCancel({ ...listed, config: runnerConfig })), ['cancel-protection']);
  // An entry still working that this stop may be the leg of (an earlier buy limit) keeps it too.
  const working = lateFill(0, { orders: [{ id: 11, contractId: CONTRACT, side: 0, type: 1, size: 9, status: 1, limitPrice: 21500 }, lateFill(0).orders[0]], history: [] });
  assert.deepStrictEqual(checks(evaluateCancel({ ...working, config: runnerConfig })), ['cancel-protection']);
  // Unreadable fills or orders: the check fails closed (the gateway refuses on a throw).
  assert.throws(() => evaluateCancel({ ...lateFill(0), fills: null, config: runnerConfig }), /fills from the server is not a list/);
  assert.throws(() => evaluateCancel({ ...lateFill(0), history: 'x', config: runnerConfig }), /history from the server is not a list/);
});

test('cancel_order: a stop goes once the position is confirmed closed (fills net to zero, no entry working); a target or the wrong side\'s stop is not held', () => {
  const closed = lateFill(0, {
    fills: [{ orderId: 11, contractId: CONTRACT, side: 0, size: 9 }, { orderId: 13, contractId: CONTRACT, side: 1, size: 9 }],
    history: [{ id: 11, contractId: CONTRACT, side: 0, type: 2, size: 9, status: 2, fillVolume: 9 }, { id: 13, contractId: CONTRACT, side: 1, type: 1, size: 9, status: 2, fillVolume: 9 }],
  });
  assert.deepStrictEqual(evaluateCancel({ ...closed, config: runnerConfig }), []);
  // A stop on the other side of what the fills show protects nothing of it (a buy stop against a long).
  assert.deepStrictEqual(evaluateCancel({ ...lateFill(0), orders: [{ ...lateFill(0).orders[0], side: 0 }], config: runnerConfig }), []);
  // A target leg is not a stop: cancel-protection never holds it (the model's [bracket-leg] judges a visible position).
  assert.deepStrictEqual(evaluateCancel({ ...lateFill(0), orders: [{ ...lateFill(0).orders[0], type: 1, limitPrice: 21600 }], config: runnerConfig }), []);
  // No fill reads given (an older caller): as before.
  assert.deepStrictEqual(evaluateCancel({ ...lateFill(0), fills: undefined, history: undefined, config: runnerConfig }), []);
});

test('ledger: entries are ordered by when they were sent, so one settled late doesn\'t count on top of a close sent after it', () => {
  const t = NOW.getTime();
  // An entry (buy 1 from flat) sent first but settled late, then a close of the resulting long sent after it.
  const entry = { contractId: CONTRACT, sign: 1, size: 1, netBefore: 0, at: t, sentAt: t - 20000 };
  const close = { contractId: CONTRACT, sign: -1, size: 1, netBefore: 1, at: t - 1000, sentAt: t - 1000 };
  assert.strictEqual(pendingState([close, entry], CONTRACT, 1, NOW, undefined, { exact: true }).projected, 0);
});

test('ledger: exits must hold against the position once every recent order fills', () => {
  const now = new Date();
  const long2 = [{ contractId: CONTRACT, type: 1, size: 2 }];
  const a = { contractId: CONTRACT, sign: -1, size: 1, netBefore: 2, at: now.getTime() - 2000 };
  const b = { contractId: CONTRACT, sign: -1, size: 1, netBefore: 2, at: now.getTime() - 1000 };
  const exit = order({ side: 'sell', rationale: '[exit] x' });
  // A filled (account shows 1), B hasn't: a third exit would flip to short.
  assert.deepStrictEqual(checks(evaluateAccount({ input: exit, positions: long1, ledger: [a, b], now, config })), ['exposure']);
  // Only A sent and filled: the next exit of 1 is fine.
  assert.deepStrictEqual(evaluateAccount({ input: exit, positions: long1, ledger: [a], now, config }), []);
  // Nothing filled yet: the projection still caps the exit.
  assert.deepStrictEqual(checks(evaluateAccount({ input: order({ side: 'sell', size: 2, rationale: '[exit] x' }), positions: long2, ledger: [a], now, config })), ['exposure']);
});

test('entries wait while orders are working in a flat contract', () => {
  const leftover = [{ id: 5, contractId: CONTRACT, side: 1, type: 4, size: 1, stopPrice: 21400 }];
  assert.deepStrictEqual(checks(evaluateAccount({ input: order(), orders: leftover, config })), ['working-orders']);
  assert.deepStrictEqual(checks(evaluateAccount({ input: order(), orders: [{ ...leftover[0], contractId: 'MES' }], config })), []);
});

test('a protective stop may move toward the market only', () => {
  const { evaluateModifyAccount } = require('../../scripts/lib/trading/account-gate');
  const sellStop = { id: 9, contractId: CONTRACT, side: 1, type: 4, size: 1, stopPrice: 21480 };
  const run = (input, positions = long1, orders = [sellStop]) => checks(evaluateModifyAccount({ input, positions, orders, config }));
  assert.deepStrictEqual(run({ orderId: 9, stopPrice: 0.25 }), ['modify-protection']);
  assert.deepStrictEqual(run({ orderId: 9, stopPrice: 21490 }), []);
  assert.deepStrictEqual(run({ orderId: 9, stopPrice: 21400 }, []), ['modify-entry'], 'no position: a leftover is re-placed, not repriced');
  const buyStop = { ...sellStop, side: 0, stopPrice: 21520 };
  assert.deepStrictEqual(run({ orderId: 9, stopPrice: 21560 }, [{ contractId: CONTRACT, type: 2, size: 1 }], [buyStop]), ['modify-protection']);
  assert.deepStrictEqual(run({ orderId: 9, trailPrice: 21470 }, long1, [{ ...sellStop, type: 5, stopPrice: null }]), ['modify-protection'], 'unknown level: refuse');
});

test('the target-then-trail ratchet\'s stop moves (one jump of several R toward the market, no reason) are accepted by the gateway and the hook', () => {
  const { evaluateModify } = require('../../scripts/lib/trading/order-gate');
  // The 2026-10-24 replay's short from 14530.5 (1R 24.5 points): its buy stop at +0.5R (14518.25) to +3.2R (14452).
  const buyStop = { id: 9, contractId: CONTRACT, side: 0, type: 4, size: 1, stopPrice: 14518.25 };
  const short1 = [{ contractId: CONTRACT, type: 2, size: 1 }];
  const move = { orderId: 9, stopPrice: 14452 };
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: move, positions: short1, orders: [buyStop], config })), []);
  assert.deepStrictEqual(evaluateModify({ input: move, config }).violations, []);
  // A long mirrored: its sell stop from +0.5R to +3.5R in one move.
  const sellStop = { id: 9, contractId: CONTRACT, side: 1, type: 4, size: 1, stopPrice: 21512.25 };
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 9, stopPrice: 21585.75 }, positions: long1, orders: [sellStop], config })), []);
  // Back the other way (a loosened ratchet, never sent) is still refused.
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 9, stopPrice: 14518.25 }, positions: short1, orders: [{ ...buyStop, stopPrice: 14452 }], config })), ['modify-protection']);
});

test('contract months: an exit must be in the month that is open, and a long and a short in two months are not flat', () => {
  const Z = CONTRACT;
  const H = 'MNQ:2027-03';
  const longZ = [{ contractId: Z, type: 1, size: 1 }];
  const exitH = order({ contractId: H, side: 'sell', rationale: '[exit] before the roll' });
  assert.match(evaluateAccount({ input: exitH, positions: longZ, config })[0].message, /open MNQ position is in MNQ/);
  const hedged = [{ contractId: Z, type: 1, size: 1 }, { contractId: H, type: 2, size: 1 }];
  assert.deepStrictEqual(checks(evaluateAccount({ input: order(), positions: hedged, config })), ['position-open']);
  const stopZ = { id: 50, contractId: Z, side: 1, type: 4, size: 1, stopPrice: 21400 };
  assert.match(evaluateCancel({ input: { orderId: 50 }, positions: hedged, orders: [stopZ], config: runnerConfig })[0].message, /protective stop/);
  assert.deepStrictEqual(checks(evaluateCancel({ input: { orderId: 50 }, positions: hedged, orders: [stopZ], config })), ['bracket-leg']);
});

test('modify_order: sizes may only shrink; every price field must keep a protective stop tightening', () => {
  const { evaluateModifyAccount } = require('../../scripts/lib/trading/account-gate');
  const long2 = [{ contractId: CONTRACT, type: 1, size: 2 }];
  const stop = { id: 9, contractId: CONTRACT, side: 1, type: 4, size: 2, stopPrice: 21480 };
  const run = input => checks(evaluateModifyAccount({ input, positions: long2, orders: [stop], config }));
  assert.deepStrictEqual(run({ orderId: 9, size: 1 }), ['modify-size'], 'long 2: cutting the stop to 1 would leave 1 unprotected');
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 9, size: 1 }, positions: long1, orders: [stop], config })), [], 'after the partial exit, cut the stop to 1');
  const entry = { id: 31, contractId: CONTRACT, side: 0, type: 1, size: 1, limitPrice: 21400 };
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 31, limitPrice: 21600 }, positions: [], orders: [entry], config })), ['modify-entry'], 'an entry is re-placed, not repriced');
  const leftover = { id: 60, contractId: CONTRACT, side: 1, type: 4, size: 1, stopPrice: 20900 };
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 60, stopPrice: 21050 }, positions: [], orders: [leftover], config })), ['modify-entry']);
  const target = { id: 12, contractId: CONTRACT, side: 1, type: 1, size: 2, limitPrice: 21600 };
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 12, limitPrice: 21580 }, positions: long2, orders: [stop, target], config })), [], 'a target can move');
  assert.deepStrictEqual(run({ orderId: 9, size: 3 }), ['modify-size']);
  assert.deepStrictEqual(run({ orderId: 99, size: 1 }), ['modify-protection'], 'unknown order: the change cannot be checked');
  const trailing = { ...stop, type: 5 };
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 9, stopPrice: 21490, trailPrice: 21000 }, positions: long2, orders: [trailing], config })), ['modify-protection']);
  // After a scale-out, orders still sized for 2 would flip a 1-lot once moved to the market.
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 12, limitPrice: 21510 }, positions: long1, orders: [stop, target], config })), ['modify-protection'], 'oversized target: cut it first');
  assert.deepStrictEqual(checks(evaluateModifyAccount({ input: { orderId: 9, stopPrice: 21495 }, positions: long1, orders: [stop], config })), ['modify-protection'], 'oversized stop: cut it first');
});

test('ledger: entries and exits anchor on the right net (root for entries, contract for exits)', () => {
  const { pendingState } = require('../../scripts/lib/trading/account-gate');
  const now = new Date();
  const ledger = [{ contractId: CONTRACT, sign: -1, size: 1, netBefore: 1, rootNetBefore: 1, at: now.getTime() }];
  assert.strictEqual(pendingState(ledger, CONTRACT, 1, now, 30000, { exact: true }).projected, 0);
  assert.strictEqual(pendingState(ledger, 'MNQ:2027-03', 0, now, 30000, { exact: true }).projected, 0, 'another month has no pending orders');
});

test('ledger: a marketable limit that filled counts until the account shows it; a resting one does not', () => {
  const now = new Date();
  const sent = { contractId: CONTRACT, sign: 1, size: 1, netBefore: 0, rootNetBefore: 0, at: now.getTime(), orderId: '77' };
  const limit = order({ type: 'limit', limitPrice: 21010 });
  // Filled but not shown yet: a second entry would double it.
  assert.deepStrictEqual(checks(evaluateAccount({ input: limit, ledger: [sent], now, config })), ['position-open']);
  // Still resting: working-orders counts it instead.
  const resting = [{ id: 77, contractId: CONTRACT, side: 0, type: 1, size: 1, limitPrice: 21010 }];
  assert.deepStrictEqual(checks(evaluateAccount({ input: limit, orders: resting, ledger: [sent], now, config })), ['working-orders']);
  // An [exit] limit that filled: a second one would flip the long.
  const exitSent = { contractId: CONTRACT, sign: -1, size: 1, netBefore: 1, rootNetBefore: 1, at: now.getTime(), orderId: '78' };
  const exit = order({ side: 'sell', rationale: '[exit] flatten' });
  assert.deepStrictEqual(checks(evaluateAccount({ input: exit, positions: long1, ledger: [exitSent], now, config })), ['exposure']);
});

test('[exit]/[protect] orders may not carry bracket legs', () => {
  const exit = order({ side: 'sell', rationale: '[exit] flatten', stopLossBracket: { ticks: 8, type: 'stop' } });
  assert.deepStrictEqual(checks(evaluateAccount({ input: exit, positions: long1, config })), ['exposure']);
  assert.deepStrictEqual(checks(evaluateAccount({ input: { ...exit, stopLossBracket: undefined }, positions: long1, config })), []);
});

test('micros and minis are one root: an MNQ entry waits while an NQ position is open, and a prop attempt holds one position across the account', () => {
  const nq = [{ contractId: 'NQ', type: 1, size: 1 }];
  assert.ok(checks(evaluateAccount({ input: order(), positions: nq, now: NOW, config })).includes('position-open'));
  const mes = [{ contractId: 'MES', type: 1, size: 2 }];
  assert.ok(!checks(evaluateAccount({ input: order(), positions: mes, now: NOW, config })).includes('prop-one-position'));
  const v = evaluateAccount({ input: order(), positions: mes, now: NOW, config: { ...config, skipChecks: new Set(['prop-one-position']) }, propAttempt: 'topstep_100k' });
  assert.match(v.find(x => x.check === 'prop-one-position').message, /topstep_100k attempt trades one position at a time: MES is open/);
  // An order sent moments ago (not on the account yet) counts too.
  const ledger = [{ contractId: 'MES', sign: 1, size: 1, netBefore: 0, at: NOW.getTime() - 5000 }];
  assert.ok(checks(evaluateAccount({ input: order(), now: NOW, config, ledger, propAttempt: 'topstep_100k' })).includes('prop-one-position'));
  assert.deepStrictEqual(checks(evaluateAccount({ input: order(), now: NOW, config, propAttempt: 'topstep_100k' })), []);
  // A resting entry on another market, the account flat: it could fill next to this one.
  const restingES = [{ id: 9, contractId: 'ES', type: 1, side: 0, size: 1, limitPrice: 5000 }];
  const w = evaluateAccount({ input: order(), orders: restingES, now: NOW, config: { ...config, skipChecks: new Set(['prop-one-position']) }, propAttempt: 'topstep_100k' });
  assert.match(w.find(x => x.check === 'prop-one-position').message, /an order is working on ES and could fill into a second position/);
  assert.ok(!checks(evaluateAccount({ input: order(), orders: restingES, now: NOW, config })).includes('prop-one-position'), 'no attempt: the per-root checks only');
  const unnamed = evaluateAccount({ input: order(), orders: [{ id: 10, type: 1, side: 0, size: 1 }], now: NOW, config, propAttempt: 'topstep_100k' });
  assert.match(unnamed.find(x => x.check === 'prop-one-position').message, /working on an unnamed contract/, 'an order it can\'t name still counts');
});

test('correlated exposure: a second same-direction equity-index position is refused; the other side, or a non-index, is not', () => {
  const mesLong = [{ contractId: 'MES', type: 1, size: 1 }];
  const v = evaluateAccount({ input: order(), positions: mesLong, now: NOW, config });
  assert.deepStrictEqual(checks(v), ['correlated-exposure']);
  assert.match(v[0].message, /MES is already long; equity index futures move together/);
  assert.deepStrictEqual(evaluateAccount({ input: order({ side: 'sell', rationale: 'setup:orb short, stop 1' }), positions: mesLong, now: NOW, config }), []);
  // A larger limit allows it; gold is not an equity index.
  assert.deepStrictEqual(evaluateAccount({ input: order(), positions: mesLong, now: NOW, config: { ...config, maxCorrelatedPositions: 2 } }), []);
  assert.deepStrictEqual(evaluateAccount({ input: order(), positions: [{ contractId: 'MGC', type: 1, size: 1 }], now: NOW, config }), []);
  // Exits are never held by it.
  assert.deepStrictEqual(checks(evaluateAccount({ input: order({ side: 'sell', rationale: '[exit] done' }), positions: [...long1, ...mesLong], now: NOW, config })), []);
});

// accountFacts against a server whose search_trades fails: `trades` rejects (a broker error, a rate limit, the gateway's
// call timeout), hangs (a lost reply, before that timeout), or answers null.
const json = v => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
const tradesFault = (fault, positions = long1) => {
  const asked = [];
  const caller = {
    call(name) {
      asked.push(name);
      if (name === 'list_open_positions') return Promise.resolve(json(positions));
      if (name === 'list_open_orders') return Promise.resolve(json([]));
      if (fault === 'reject') return Promise.reject(new Error('search_trades failed: rate limited'));
      if (fault === 'timeout') return Promise.reject(new Error('search_trades timed out'));
      if (fault === 'hang') return new Promise(() => {});
      return Promise.resolve(json(fault === 'null' ? null : []));
    },
  };
  return { caller, asked };
};
const within = (p, ms = 500) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('accountFacts waited on a read it never uses')), ms))]);

test('accountFacts: an [exit] or [protect] never asks for the fills, so a rejected, timed-out, lost or null search_trades never holds it; an entry still fails closed', async () => {
  const { accountFacts } = require('../../scripts/lib/trading/account-gate');
  const exit = order({ side: 'sell', rationale: '[exit] flatten' });
  const protect = order({ side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the long' });
  for (const fault of ['reject', 'timeout', 'hang', 'null']) {
    for (const input of [exit, protect]) {
      const { caller, asked } = tradesFault(fault);
      const facts = await within(accountFacts({ ...input }, caller));
      assert.ok(!asked.includes('search_trades'), `${fault}: ${input.rationale} asked for the fills`);
      assert.strictEqual(facts.trades, null);
      assert.deepStrictEqual(rawEvaluate({ input, ...facts, config, now: NOW }), [], `${fault}: ${input.rationale} goes`);
      // Said explicitly too (the gateway passes it).
      const again = tradesFault(fault);
      await within(accountFacts({ ...input }, again.caller, false));
      assert.ok(!again.asked.includes('search_trades'));
    }
  }
  // An entry still reads the fills, and a fault there refuses it.
  for (const fault of ['reject', 'timeout']) {
    await assert.rejects(accountFacts(order(), tradesFault(fault, []).caller), /search_trades/, fault);
    await assert.rejects(accountFacts(order(), tradesFault(fault, []).caller, true), /search_trades/, fault);
  }
  const nullFills = await accountFacts(order(), tradesFault('null', []).caller);
  assert.throws(() => rawEvaluate({ input: order(), ...nullFills, config, now: NOW }), /trades from the server is not a list/);
  // An entry's facts never come without the fills: read as an exit's (trades null), they are refused, never read as no losses.
  const exitFacts = await accountFacts(order(), tradesFault('reject', []).caller, false);
  assert.throws(() => rawEvaluate({ input: order(), ...exitFacts, config, now: NOW }), /trades from the server is not a list/);
});

test('evaluateAccount: a risk-reducing order is judged without the fills (null or malformed); positions and orders still must be lists', () => {
  const protect = order({ side: 'sell', type: 'stop', stopPrice: 21480, rationale: '[protect] stop for the long' });
  const exit = order({ side: 'sell', rationale: '[exit] flatten' });
  for (const trades of [null, undefined, 'nope', {}]) {
    assert.deepStrictEqual(rawEvaluate({ input: protect, positions: long1, orders: [], trades, config, now: NOW }), []);
    assert.deepStrictEqual(rawEvaluate({ input: exit, positions: long1, orders: [], trades, config, now: NOW }), []);
    assert.throws(() => rawEvaluate({ input: order(), positions: [], orders: [], trades, config, now: NOW }), /trades from the server is not a list/);
  }
  // Still fail closed on what an exit is judged on.
  assert.throws(() => rawEvaluate({ input: exit, positions: null, orders: [], trades: [], config, now: NOW }), /positions from the server is not a list/);
  assert.throws(() => rawEvaluate({ input: protect, positions: long1, orders: null, trades: [], config, now: NOW }), /orders from the server is not a list/);
});
