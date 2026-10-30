'use strict';

// Regression tests for the timeframe conflicts seen in the replay runs (feat/bias-bg, the owner: "Make sure to add unit
// tests to catch these issues"), each on small synthetic facts, each named for its conflict. The chain is the shipped
// 4h/15m/3m (chain.js): bias 4h + 1h (BG), levels 1h, setup 15m, entry 3m.

const test = require('node:test');
const assert = require('node:assert');
const C = require('../../scripts/lib/trading/chain');
const { entryRuleOf, entryProblems } = require('../../scripts/lib/trading/entry-rule');
const { checkReads, checkRead, parseRead } = require('../../scripts/lib/trading/composed-reads');
const { classify, expectedDecision, checkReasons } = require('../../scripts/lib/replay/scorecard');
const { composedSetup } = require('../../scripts/lib/trading/reasons');
const S = require('../../scripts/lib/schedule');

const BG = entryRuleOf({ chain: '4h', bias_frames: ['4h', '1h'], bias_agree: 'neutral-15m-declared', regime_against: 'off', leg_turned: 'off' });
const DECLARED = way => ({
  long: { vwapAtr: way === 'long' ? 0.6 : -0.6, ema20Atr: way === 'long' ? 0.3 : -0.3, dayMoveAtr: way === 'long' ? 1 : -1, regime: way === 'long' ? 'with' : 'against' },
  short: { vwapAtr: way === 'short' ? 0.6 : -0.6, ema20Atr: way === 'short' ? 0.3 : -0.3, dayMoveAtr: way === 'short' ? 1 : -1, regime: way === 'short' ? 'with' : 'against' },
});
/** A 3m-lane briefing with only what the entry rule and the trail read. */
function briefing({ t4h = 'up', t1h = 'up', t15 = 'range', declared = null, lastBreak1h = null, swings3m = [] } = {}) {
  return {
    minutes: 3,
    sections: {
      m3: { data: { price: 21500, regime: { primary: 'range' }, swingTargets: { above: swings3m, below: [] }, ...(declared ? { declared } : {}) } },
      m15: { data: { frame: { trend: t15 } } },
      h1: { data: { h4: { trend: t4h }, h1: { trend: t1h }, ...(lastBreak1h ? { lastBreak: { last: lastBreak1h } } : {}) } },
    },
  };
}
const rule = (b, side) => entryProblems({ briefing: b, side, reads: [], rule: BG });

test('1. a 1h CHoCH against while the 4h and 1h both trend the side: the aligned long is not refused, and the scorecard does not call the CHoCH decisive; with the 1h ranging it stays decisive', () => {
  // The entry rule reads the trends, never the 1h's last break: the long stands with a 1h CHoCH down on record.
  const b = briefing({ lastBreak1h: { kind: 'CHoCH', direction: 'down', at: '2026-06-01T13:00:00.000Z' } });
  assert.deepStrictEqual(rule(b, 'long'), []);
  // The scorecard: a pass on a valid composed record stating the 1h CHoCH.
  const rec = { id: 'rec1', side: 'long', bar: '2026-06-01T14:27:00.000Z', ok: true, signature: 'bias:1h-bos-up', skillSignature: 'bias:bos-vs-choch', symbol: 'MNQ', contract: 'MNQ', lane: '3m', context: null,
    entry: 20540.25, tick: 0.25, tickValue: 0.5, size: 1, stop: 20512.5, target: 20598, rr: 2.08, inTheWay: null, reads: [{ step: 'bias', skill: 'bos-vs-choch', read: '1h bos up', check: true, agrees: true }], problems: 0 };
  const window = { name: 'opening drive', until: '11:00', et: '09:57', entriesAllowed: true };
  const facts = htf => ({ t: '2026-06-01T14:30:02.000Z', window, scanned: true, setups: [composedSetup(rec, { window })], trendRule: { prevailing: '4h up', long: true, short: false }, attempt: null, styleOf: () => null, planOf: () => null, htf });
  const label = { decision: 'flat', teacher: { action: 'none', setup: null, size: null, orders: [] }, gate: { decision: 'none', checks: [] }, clone: { ok: true, reasons: [] }, cycleFailed: null };
  const text = 'CYCLE RESULT: no-trade - the 1h CHoCH down turned the trend against the long';
  const run = f => classify(label, f, expectedDecision(f), checkReasons(text, f)).category;
  assert.strictEqual(run(facts({ '4h': 'up', '1h': 'up' })), 'excessive abstention', 'both up: context, the pass is abstention');
  assert.strictEqual(run(facts({ '4h': 'up', '1h': 'range' })), 'unchecked', 'the 1h ranging: decisive stands');
});

test('2. 3m structure against the HTF: under the 4h and 1h up a short built on a 3m BOS or CHoCH down is refused (bias); no 3m read sets the side', () => {
  for (const read of ['3m bos down', '3m choch down']) {
    const r = checkReads({ reads: [{ step: 'bias', skill: 'bos-vs-choch', read }], side: 'short', briefing: briefing(), entryRule: BG });
    assert.ok(r.problems.some(p => /^entry rule: the 4h and 1h trends are up, against the short/.test(p)), `${read}: ${r.problems.join('; ')}`);
  }
  // The bias frames are the chain's (4h, 1h): a 3m frame can't be listed.
  const { entryRuleErrors } = require('../../scripts/lib/trading/entry-rule');
  assert.match(entryRuleErrors({ chain: '4h', bias_frames: ['3m'], bias_agree: 'off', regime_against: 'off', leg_turned: 'off' }, 'p').join(), /bias_frames: \["3m"\] is not off or a list of 4h, 1h/);
});

test('3. 3m levels as targets: with the trail, an aligned plan is never refused for "no named 2R level", whatever 3m swings sit ahead', () => {
  for (const swings3m of [[], [{ frame: '3m', price: 21505 }], [{ frame: '3m', price: 21502 }, { frame: '3m', price: 21508 }]]) {
    const c = checkRead(parseRead('target trail'), briefing({ swings3m }), { side: 'long', tick: 0.25 });
    assert.strictEqual(c.check, true, `${JSON.stringify(swings3m)}: ${c.fact}`);
  }
  // A BG-only side (the 4h up, the 1h ranging) takes it too: the old rule (the 4h and 1h both up) refused it.
  assert.strictEqual(checkRead(parseRead('target trail'), briefing({ t1h: 'range', swings3m: [{ frame: '3m', price: 21505 }] }), { side: 'long', tick: 0.25 }).check, true);
  // A side the rule refuses gets no trail.
  assert.strictEqual(checkRead(parseRead('target trail'), briefing({ t4h: 'down' }), { side: 'long', tick: 0.25 }).check, false);
});

test('3b. no entry-frame level: the runner\'s base bars (the chain\'s entry frame) give no level, room, target or sweep; their candles stay as facts', () => {
  // The owner: "We should never use entry timeframes as levels" (the study: the tiers are neutral, so the principle decides).
  const B = require('../../scripts/lib/trading/briefing');
  const { targetsAhead } = require('../../scripts/lib/trading/composed-reads');
  const D = require('../fixtures/decision-path');
  for (const [minutes, bars, tf] of [[3, D.BARS, '3m'], [1, D.MINUTE_BARS, '1m']]) {
    const b = B.buildBriefing({ symbol: 'MNQ', bars: bars.slice(0, minutes === 3 ? 1300 : 3900), minutes });
    const m3 = b.sections.m3.data;
    const names = [...m3.nearestLiquidity.above, ...m3.nearestLiquidity.below].map(x => x.name);
    const entryName = new RegExp(`(^|\\b)(${tf}|3m) swing|equal (highs|lows)|previous (${tf}|3m) `);
    assert.ok(!names.some(n => entryName.test(n)), `${tf} room: ${names.join(' | ')}`);
    assert.ok(!(m3.swingTargets.above || []).concat(m3.swingTargets.below || []).some(x => x.frame === tf || x.frame === '3m'), `${tf} swing targets`);
    assert.deepStrictEqual([m3.liquidity.equalHighs, m3.liquidity.equalLows, m3.liquidity.openFvgs], [[], [], []], tf);
    assert.ok(!m3.sweeps.some(x => entryName.test(x.name)), `${tf} sweeps`);
    for (const c of Object.values(m3.candles)) for (const r of (c && c.relations) || []) assert.ok(!entryName.test(`${r.name} `), `${tf} relation ${r.name}`);
    for (const side of ['long', 'short']) assert.ok(!targetsAhead(b, side, { tick: 0.25 }).some(t => entryName.test(`${t.read} `)), `${tf} ${side} targets`);
    // The entry frame's candle stays as a candle fact (its close, its shape), and its swings for the stop.
    assert.ok((m3.candles[tf] || m3.candles['3m'] || {}).closeLocation, `${tf} candle`);
    assert.ok(Array.isArray(m3.liquidity.swingLows), 'the swings for the stop');
  }
  // compose's 3m confirming close after the setup stays (its test was inconclusive under its pre-registered rule).
});

test('4. the 15m trend against during a pullback: with the 4h and 1h up, a 15m trend down is allowed (the 15m is the setup frame, never a bias frame)', () => {
  assert.deepStrictEqual(rule(briefing({ t15: 'down' }), 'long'), []);
  assert.deepStrictEqual(rule(briefing({ t4h: 'up', t1h: 'range', t15: 'down' }), 'long'), [], 'a BG-only long too');
});

test('5. short history: no replay, training run or trend set starts before data.sessionsFrom (the warm-up the 4h and 1h reads need)', () => {
  assert.match(S.warmupRefusal('2021-05-04'), /is before 2021-05-24/);
  assert.strictEqual(S.warmupRefusal('2021-05-24'), null);
  const { resolveReplay } = require('../../scripts/lib/replay/config');
  const raw = { runId: 'w', workDir: '/tmp/fth-warmup', broker: 'replaymock', start: '2021-05-04T13:30:00Z', end: '2021-05-04T20:00:00Z', autotrader: { harness: 'custom', command: ['true'], symbols: ['MNQ'], timeframe: 3 } };
  assert.throws(() => resolveReplay(raw, { baseDir: '/tmp', env: {}, home: '/tmp' }), /start: 2021-05-04 is before 2021-05-24/);
});

test('6. a 3m-only setup is refused under the chain; a 15m setup and the S2 fired exemption pass', () => {
  const LC = require('../fixtures/lifecycle');
  // Scenario 1 with the 3m candle also rejecting the prior VAH up, so a 3m and a 15m setup read are both TRUE.
  const b = LC.briefing();
  b.sections.m3.data.candles['3m'].relations = [{ name: 'prior VAH', price: 21530.13, rel: 'rejected', dir: 'up' }];
  const withSetup = read => LC.READS.map(x => (x.step === 'setup' ? { ...x, read } : x));
  const MSG = /^entry rule: the setup must be on the 15m or higher \(a 3m read only times the entry\)/;
  const problems = read => checkReads({ reads: withSetup(read), side: 'long', briefing: b, entryRule: BG }).problems;
  assert.ok(problems('3m rejected prior vah up').some(p => MSG.test(p)), 'a 3m-only setup');
  assert.ok(!problems('15m rejected prior vah up').some(p => MSG.test(p)), 'a 15m setup');
  const s2 = checkReads({ reads: LC.S2_READS, side: 'long', briefing: LC.s2Briefing(), entryRule: BG, cited: ['momentum_continuation'] });
  assert.ok(!s2.problems.some(p => MSG.test(p)), 'the S2 fired read: exempt');
});

test('7. timeframe drift: the chain derives every frame by the 2-level rule; the 1h top derives 1h + 15m, 15m, 5m, 1m', () => {
  const four = C.chainOf('4h');
  assert.deepStrictEqual([[...four.bias], four.levels, four.setup, four.entry], [['4h', '1h'], '1h', '15m', '3m']);
  const one = C.chainOf('1h');
  assert.deepStrictEqual([[...one.bias], one.levels, one.setup, one.entry], [['1h', '15m'], '15m', '5m', '1m']);
  for (const t of C.TOPS) assert.deepStrictEqual(C.twoLevelErrors(C.chainOf(t)), [], t);
});

test('8. HTF neutral (BG): both ranging with the 15m and the declared trend agreeing, allowed; without declared facts, refused; a trending 4h against, refused', () => {
  assert.deepStrictEqual(rule(briefing({ t4h: 'range', t1h: 'range', t15: 'down', declared: DECLARED('short') }), 'short'), [], 'the 2021-05-04 type: 15m down, declared short');
  assert.match(rule(briefing({ t4h: 'range', t1h: 'range', t15: 'down' }), 'short').join(), /Trend declared\? facts are not in the briefing/);
  assert.match(rule(briefing({ t4h: 'up', t1h: 'range', t15: 'down', declared: DECLARED('short') }), 'short').join(), /the 4h trend is up, against the short/);
});
