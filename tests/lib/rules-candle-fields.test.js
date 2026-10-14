'use strict';

// The rules language's completed-candle fields (htfd_*, scripts/lib/trading/rules.js over candle-facts.js): they
// compile (a relation names its level), read the same values as the briefing's code path, fire on the bar the
// candle completes, never see the candle forming or a later bar, and a new candle is a jump, never a cross.

const test = require('node:test');
const assert = require('node:assert');
const rules = require('../../scripts/lib/trading/rules');
const CF = require('../../scripts/lib/trading/candle-facts');

const MIN = 60000;
const T0 = Date.parse('2026-06-15T13:30:00Z'); // 09:30 ET
const bar = (i, o, h, l, c, v = 100) => ({ t: new Date(T0 + i * 3 * MIN).toISOString(), o, h, l, c, v });

/** 3m bars: a 15m candle 09:30-09:45 with a high of 105, then 09:45-10:00 wicking above it and closing back below. */
function scene() {
  const b = [bar(0, 100, 101, 99, 100.5), bar(1, 100.5, 103, 100, 102), bar(2, 102, 105, 101.5, 104), bar(3, 104, 104.5, 102, 103), bar(4, 103, 103.5, 101, 102)];
  // 09:45-10:00: opens 102, trades to 107 (through 105), closes 103.
  b.push(bar(5, 102, 104, 101.75, 103.5), bar(6, 103.5, 107, 103, 106), bar(7, 106, 106.5, 104, 104.5), bar(8, 104.5, 104.75, 102.5, 103), bar(9, 103, 103.5, 102.25, 103));
  return b;
}

test('compile: a relation names its level; other htfd fields take none; minutes divide a day', () => {
  assert.strictEqual(rules.compileCondition('htfd_rejected(15, previous_high) < 0').left[0].factors[0].key, 'htfd_rejected(15,previous_high)');
  assert.throws(() => rules.compileCondition('htfd_broke(15) > 0'), /name the level/);
  assert.throws(() => rules.compileCondition('htfd_broke(15, close) > 0'), /the level is one of/);
  assert.throws(() => rules.compileCondition('htfd_close(15, prior_high) > 0'), /take a level/);
  assert.throws(() => rules.compileCondition('htfd_doji(7) > 0'), /divide a day/);
  assert.throws(() => rules.compileCondition('ema(20, prior_high) > 0'), /take a level/);
  for (const f of ['htfd_open', 'htfd_close', 'htfd_shooting_star', 'htfd_engulfing', 'htfd_next_swing_high', 'htfd_vol_ratio']) {
    assert.ok(rules.compileCondition(`${f}(60) > 0`), f);
  }
});

test('the completed 15m candle: values on the bar that completes it, the same as candle-facts', () => {
  const b = scene();
  const get = rules.seriesSource(b, {}, { barMinutes: 3 });
  // Bar 8 (09:54-09:57): 09:45-10:00 still forming, the completed one is 09:30-09:45.
  assert.strictEqual(get('htfd_high(15)')[8], 105);
  assert.strictEqual(get('htfd_close(15)')[8], 102);
  // Bar 9 closes 10:00: now the completed candle is 09:45-10:00 (htf_high is still 09:30-09:45 until 10:00 opens).
  assert.strictEqual(get('htfd_high(15)')[9], 107);
  assert.strictEqual(get('htfd_close(15)')[9], 103);
  assert.strictEqual(get('htfd_prev_high(15)')[9], 105);
  assert.strictEqual(get('htf_high(15)')[9], 105, 'htf_ lags until the next candle opens');
  assert.strictEqual(get('htfd_rejected(15,previous_high)')[9], -1, 'wick above 105, close back below');
  assert.ok(Number.isNaN(get('htfd_rejected(15,previous_high)')[8]), 'the completed 09:30 candle has no previous one; the forming one is never read');
  assert.strictEqual(get('htfd_broke(15,previous_high)')[9], 0);
  assert.strictEqual(get('htfd_touched(15,previous_high)')[9], 0);
  const cs = CF.candleSeries(b, 15, 3);
  for (const k of ['htfd_open', 'htfd_high', 'htfd_low', 'htfd_close', 'htfd_volume', 'htfd_body', 'htfd_upper_wick', 'htfd_close_loc', 'htfd_shooting_star']) {
    assert.ok(Object.is(get(`${k}(15)`)[9], cs[k][9]), k);
  }
  // Upper wick 4/5.25 of the range, close in the bottom third: a shooting star.
  assert.strictEqual(get('htfd_shooting_star(15)')[9], 1);
  assert.strictEqual(get('htfd_close_loc(15)')[9], -1);
  // 5m from 3m bars: no value (never approximated).
  assert.ok(get('htfd_close(5)').every(Number.isNaN));
});

test('a rule on the completed candle fires on the completing bar only, and reports a missing value', () => {
  const b = scene();
  const { compiled, errors } = rules.compileRules({ short: ['htfd_rejected(15, previous_high) < 0', 'htfd_shooting_star(15) > 0'] });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(rules.evaluateRules(compiled, b, {}, { index: 9, barMinutes: 3 }).direction, 'short');
  assert.strictEqual(rules.evaluateRules(compiled, b, {}, { index: 8, barMinutes: 3 }).direction, null);
  // Before any completed candle with a previous one: missing, never a value.
  const early = rules.evaluateRules(compiled, b, {}, { index: 2, barMinutes: 3 });
  assert.ok(early.short[0].missing);
});

test('no look-ahead: every htfd series at bar t is the same without the bars after t', () => {
  const b = scene();
  const keys = ['htfd_high(15)', 'htfd_close(3)', 'htfd_rejected(15,previous_high)', 'htfd_broke(3,previous_low)', 'htfd_touched(15,previous_low)', 'htfd_next_swing_high(3)', 'htfd_next_swing_low(3)', 'htfd_engulfing(3)', 'htfd_vol_ratio(3)'];
  const full = rules.seriesSource(b, {}, { barMinutes: 3 });
  for (let t = 0; t < b.length; t += 1) {
    const cut = rules.seriesSource(b.slice(0, t + 1), {}, { barMinutes: 3 });
    for (const k of keys) assert.ok(Object.is(cut(k)[t], full(k)[t]), `${k} at ${t}`);
  }
});

test('a new completed candle is a jump: crosses of an htfd level never count across it', () => {
  const b = scene();
  const get = rules.seriesSource(b, {}, { barMinutes: 3 });
  assert.ok(get.resets('htfd_high(15)', 9), 'a new candle completed at bar 9');
  assert.ok(!get.resets('htfd_high(15)', 8));
  assert.ok(get.resets('htfd_rejected(15,previous_high)', 9));
});

test('the level vocabulary: one fixed list (the rules.js header lists exactly it); a valid name loads, an unknown one is refused at strategy load, a second argument on any other function is refused', () => {
  const fs = require('fs');
  const path = require('path');
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  const { validateStrategy } = require('../../scripts/lib/trading/strategies');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'lib', 'trading', 'rules.js'), 'utf8');
  const header = src.slice(src.indexOf('any other name is refused): '), src.indexOf('(the candle before it)'));
  const listed = new Set([...header.matchAll(/\b([a-z]+_[a-z_]+)\b/g)].map(m => m[1]));
  assert.deepStrictEqual([...listed].sort(), [...rules.LEVEL_ARGS].sort());
  const { data, body } = parseFrontmatter(fs.readFileSync(path.join(__dirname, '..', '..', 'strategies', '_template', 'STRATEGY.md'), 'utf8'));
  const withRules = r => validateStrategy({ ...data, signal: 'rules', rules: { short: r } }, body, 'my_strategy');
  assert.deepStrictEqual(withRules(['htfd_rejected(60, prior_high) < 0']), []);
  assert.ok(withRules(['htfd_rejected(60, prior_hi) < 0']).some(e => /the level is one of/.test(e)), 'an unknown level name is refused at load');
  for (const f of rules.FUNCS) {
    if (rules.HTFD_REL[f]) continue;
    assert.throws(() => rules.compileCondition(`${f}(60, prior_high) > 0`), /take a level/, f);
  }
});

test('a relation reads the level as it stood at the candle\'s close: a level formed later gives none; a moving one its value then', () => {
  const b = scene();
  const cs = CF.completedSeries(b, 15, 3);
  // A level that formed on bar 7, after the 09:30-09:45 candle closed (bar 4): no relation for that candle on bar 8.
  const later = b.map((_, i) => (i >= 7 ? 104 : NaN));
  const rel = CF.relationSeries(b, 15, 3, later, { at: 'close' });
  assert.ok(Number.isNaN(rel.touched[8]) && Number.isNaN(rel.rejected[8]) && Number.isNaN(rel.broke[8]));
  // Read on this bar instead, it would say rejected (104 is inside the candle's 99-105, close 102 back below).
  assert.strictEqual(CF.relationSeries(b, 15, 3, later, { at: 'now' }).rejected[8], -1);
  // A moving level: 100.75 at the candle's close (opened below it at 100, closed above at 102: broke up), 200 now.
  const moving = b.map((_, i) => (i <= cs.candles[0].last ? 100.75 : 200));
  assert.strictEqual(CF.relationSeries(b, 15, 3, moving).broke[8], 1);
  assert.strictEqual(CF.relationSeries(b, 15, 3, moving, { at: 'now' }).broke[8], 0);
  // In the rules language: or_high before the opening range formed has no value at the candle's close.
  const get = rules.seriesSource(b, {}, { barMinutes: 3 });
  assert.ok(Number.isNaN(get('htfd_touched(15,or_high)')[8]));
});

test('a fixed level is read as it stood when the candle opened, a moving one at its close; without the bar size there are no values', () => {
  const b = scene();
  // A level that appears on bar 7, inside the 09:45-10:00 candle (bars 5-9): no level when it opened, so no relation.
  const inside = b.map((_, i) => (i >= 7 ? 106 : NaN));
  assert.ok(Number.isNaN(CF.relationSeries(b, 15, 3, inside, { at: 'open' }).rejected[9]));
  // At its close the same series would say rejected (106 inside 101.75-107, close 103 back below).
  assert.strictEqual(CF.relationSeries(b, 15, 3, inside, { at: 'close' }).rejected[9], -1);
  // In the rules language, the bar size comes from the caller: none, no values.
  assert.ok(rules.seriesSource(b, {})('htfd_high(15)').every(Number.isNaN));
});

test('the evaluator gives the completed-candle series the strategy\'s own timeframe as the bar size', () => {
  const { createEvaluator } = require('../../scripts/lib/trading/evaluator');
  const b = scene();
  const s = { name: 'x', signal: 'rules', timeframe: '3m', params: {}, risk: { stop: 'atr:0.5', min_rr: 2 }, compiledRules: rules.compileRules({ short: ['htfd_shooting_star(15) > 0'] }).compiled };
  const ev = createEvaluator(b);
  assert.strictEqual(ev.at(s, 9).direction, 'short');
  assert.strictEqual(ev.at({ ...s, timeframe: '1m' }, 9).direction, null, 'as 1m bars these are not whole 15m candles on the grid they claim');
});

test('a fixed level counts when complete by the candle\'s open: one set on the candle\'s own first bar never counts (open), nor one a bar after it (first)', () => {
  const b = scene();
  // The 09:45-10:00 candle is bars 5-9 (high 107, low 101.75). A level that first has a value ON its first bar (5):
  const onFirst = b.map((_, i) => (i >= 5 ? 106 : NaN));
  // Read on the bar before it ('open': a series that holds its value on its completing bar): it didn't exist yet.
  assert.ok(Number.isNaN(CF.relationSeries(b, 15, 3, onFirst, { at: 'open' }).rejected[9]));
  // One that already had it on bar 4 (complete when bar 4 closed at 09:45, the candle's open) counts.
  const onFour = b.map((_, i) => (i >= 4 ? 106 : NaN));
  assert.strictEqual(CF.relationSeries(b, 15, 3, onFour, { at: 'open' }).rejected[9], -1);
  // 'first' (a series of earlier bars only, set on the bar after it completes): on the candle's first bar it counts,
  // a bar later it doesn't.
  assert.strictEqual(CF.relationSeries(b, 15, 3, onFirst, { at: 'first' }).rejected[9], -1);
  const onSecond = b.map((_, i) => (i >= 6 ? 106 : NaN));
  assert.ok(Number.isNaN(CF.relationSeries(b, 15, 3, onSecond, { at: 'first' }).rejected[9]));
});

// Each fixed level's read bar in the rules language, pinned on the parity bars (three sessions, a Sunday open, RTH
// days): a 3m candle is its own bar i; the expected bar is i for a series of earlier bars only (prior_*, overnight_*)
// and i - 1 for one that holds its value on its completing bar (or_*, ib_*, swings, rth_open); a session's own level
// read on the session before is stale. Reading one bar earlier or later, or dropping the session rule, fails here.
test('the rules read each fixed level on its own bar: every level matches, and a read one bar off (or without the session rule) would not', () => {
  const path = require('path');
  const { readBarsArg } = require('../../scripts/lib/backtest/data');
  const { normalizeBars, sessionKey } = require('../../scripts/lib/trading/indicators');
  const { PARAMS } = require('../../scripts/lib/trading/market-snapshot');
  const nq = normalizeBars(readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv')));
  const get = rules.seriesSource(nq, { ...PARAMS }, { barMinutes: 3 });
  const s = CF.completedSeries(nq, 3, 3);
  const code = (c, L, pc) => { const r = CF.relation(c, L, pc); return r ? (r.relation === 'rejected' ? (r.dir === 'up' ? 1 : -1) : 0) : NaN; };
  const sess = t => sessionKey(t, 18 * 60);
  const FIRST = ['prior_high', 'prior_low', 'prior_close', 'overnight_high', 'overnight_low'];
  const SESSION = ['or_high', 'or_low', 'ib_high', 'ib_low', 'overnight_high', 'overnight_low', 'rth_open'];
  for (const level of ['or_high', 'or_low', 'ib_high', 'ib_low', 'overnight_high', 'overnight_low', 'prior_high', 'prior_low', 'prior_close', 'swing_high', 'swing_low', 'rth_open']) {
    const L = get(level);
    const got = get(`htfd_rejected(3,${level})`);
    const touched = get(`htfd_touched(3,${level})`);
    const at = (c, k, { session = SESSION.includes(level) } = {}) => (k < 0 || k >= nq.length || (session && sess(nq[k].t) !== sess(c.t)) ? NaN : L[k]);
    const asRead = { earlier: 0, later: 0, noSession: 0 };
    for (let i = 1; i < nq.length; i += 1) {
      const j = s.lastAt[i];
      if (j < 1) continue;
      const c = s.candles[j];
      const pc = s.candles[j - 1].c;
      const k = FIRST.includes(level) ? c.first : c.first - 1;
      const want = code(c, at(c, k), pc);
      assert.ok(Object.is(got[i], want), `${level} at ${nq[i].t}: ${got[i]} vs ${want}`);
      // Some relation (rejected or touched) must read differently one bar off, so a mutant can't pass.
      const sig = kk => { const r = CF.relation(c, at(c, kk), pc); return r ? r.relation + r.dir : 'none'; };
      const here = sig(k);
      if (sig(k - 1) !== here) asRead.earlier += 1;
      if (sig(k + 1) !== here) asRead.later += 1;
      if (SESSION.includes(level)) { const r = CF.relation(c, at(c, k, { session: false }), pc); if ((r ? r.relation + r.dir : 'none') !== here) asRead.noSession += 1; }
      assert.ok(Number.isNaN(touched[i]) === Number.isNaN(got[i]));
    }
    assert.ok(asRead.earlier > 0 && asRead.later > 0, `${level}: a read one bar off changes something (${JSON.stringify(asRead)})`);
  }
});

test('at a new session\'s first candle (18:00 ET, Sunday too): the last session\'s opening range, IB and overnight give no relation; the prior RTH day is the one that just closed', () => {
  const path = require('path');
  const { readBarsArg } = require('../../scripts/lib/backtest/data');
  const { normalizeBars } = require('../../scripts/lib/trading/indicators');
  const { PARAMS } = require('../../scripts/lib/trading/market-snapshot');
  const nq = normalizeBars(readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv')));
  const get = rules.seriesSource(nq, { ...PARAMS }, { barMinutes: 3 });
  const etHm = t => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
  const opens = nq.map((b, i) => [i, etHm(b.t)]).filter(([, e]) => /18:00$/.test(e));
  assert.ok(opens.some(([, e]) => /^Sun/.test(e)), 'a Sunday open is in the bars');
  for (const [i] of opens) {
    for (const level of ['or_high', 'or_low', 'ib_high', 'ib_low', 'overnight_high', 'overnight_low', 'rth_open']) {
      assert.ok(Number.isNaN(get(`htfd_touched(3,${level})`)[i]), `${nq[i].t} ${level}`);
    }
    // The prior day it reads is the RTH day that closed at 16:00 (its value on the 18:00 bar), not the day before it
    // (the 15:57 bar's).
    const pd = get('prior_high');
    const last = nq.findLastIndex((b, k) => k < i && /15:57$/.test(etHm(b.t)));
    if (last >= 0 && Number.isFinite(pd[last])) assert.notStrictEqual(pd[i], pd[last], `${nq[i].t}: a new prior day at the open`);
    assert.ok(!Number.isNaN(get('htfd_touched(3,prior_high)')[i]));
  }
});

test('the session rule, pinned: an 18:00 candle trading through the last session\'s opening range, IB and RTH open gives no relation; the same candle mid-session does', () => {
  const { PARAMS } = require('../../scripts/lib/trading/market-snapshot');
  const t0 = Date.parse('2026-06-14T22:00:00Z'); // Sunday 18:00 ET (EDT)
  const etMin = ms => { const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)); return Number(p[0].value) * 60 + Number(p[2].value); };
  const b = [];
  for (let ms = t0; ms < t0 + 25 * 3600000; ms += 180000) {
    const m = etMin(ms);
    if (m >= 960 && m < 1080) continue; // the daily break
    // The opening range and IB high 105 (the 09:33 bar), otherwise 99-101; a probe at 14:00: through 105, back to 100.
    const hi = m === 573 ? 105 : m === 840 ? 106 : 101;
    b.push({ t: new Date(ms).toISOString(), o: 100, h: hi, l: 99, c: 100, v: 100 });
  }
  const open = b.findIndex(x => etMin(Date.parse(x.t)) === 1080 && Date.parse(x.t) > t0);
  assert.ok(open > 0, 'Monday 18:00 is in the bars');
  b[open] = { ...b[open], h: 106 };
  const probe = b.findIndex(x => etMin(Date.parse(x.t)) === 840);
  const get = rules.seriesSource(b, { ...PARAMS }, { barMinutes: 3 });
  for (const level of ['or_high', 'ib_high']) {
    assert.strictEqual(get(`htfd_rejected(3,${level})`)[probe], -1, `${level} mid-session: through 105, closed back below`);
    assert.ok(Number.isNaN(get(`htfd_rejected(3,${level})`)[open]), `${level} at 18:00: the last session's, stale`);
  }
  assert.strictEqual(get('htfd_touched(3,rth_open)')[probe], 1);
  assert.ok(Number.isNaN(get('htfd_touched(3,rth_open)')[open]));
});
