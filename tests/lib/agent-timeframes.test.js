'use strict';

// Per-agent timeframes (step 4 of the timeframe lanes): an analyst on its own timeframe gets a bar briefing on it
// (trading/briefing.js buildFrameBriefing, sharing the runner's m15/h1/day parts), the bar_briefing tool serves it,
// the runner builds it (runner-wiring.js briefingRecorder) and the report cache keys the analyst's report on it,
// valid until that timeframe's next bar close (report-cache.js). Expiry at each timeframe, the daily break, the
// weekend and DST for 1h bars.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const B = require('../../scripts/lib/trading/briefing');
const RC = require('../../scripts/lib/trading/report-cache');
const { candles } = require('../../scripts/lib/trading/mtf');
const { inMarketHours } = require('../../scripts/lib/trading/clock');
const { ANALYSTS } = require('../../scripts/lib/trading/roles-ran');
const { barBriefing } = require('../../scripts/lib/harness-tools/briefing');
const { briefingRecorder } = require('../../scripts/lib/runner-wiring');
const { validateConfig, childEnv, prompts } = require('../../scripts/lib/autotrader');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { tmpDir } = require('../helpers');

const BARS = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv'));
const C = 'MNQ:2026-06';
const iso = ms => new Date(ms).toISOString();
const whole = (bars, m) => candles(bars, m).filter(c => c.complete).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
// The runner's briefing on the first n 3m bars, and an analyst's own timeframe built from them.
const first = (n, prev = null) => B.buildBriefing({ symbol: 'MNQ', contractId: C, bars: BARS.slice(0, n), minutes: 3, prev });
const frame = (f, m, bars = BARS.slice(0, BARS.findIndex(b => b.t === f.asOf) + 1)) => B.buildFrameBriefing({ symbol: 'MNQ', contractId: C, bars: whole(bars, m), minutes: m, first: f });
const ET = (y, mo, d, h, mi, offset) => Date.UTC(y, mo - 1, d, h + offset, mi);

/** 3m bars for every 3 minutes the market is open, from `from` to `to` (ms): the daily break and the weekend have none. */
function sessionBars(from, to) {
  const out = [];
  let px = 20000;
  for (let t = from; t < to; t += 180000) {
    if (!inMarketHours(new Date(t))) continue;
    px += ((t / 180000) % 7) - 3;
    out.push({ t: iso(t), o: px, h: px + 4, l: px - 4, c: px + 1, v: 100 });
  }
  return out;
}

test('frameUntil: a bar holds until the next bar\'s close in market hours: closedAt + its minutes in a session; across the daily break, the weekend and a DST change, the first bar after the open', () => {
  const edt = (d, h, mi = 0) => ET(2026, 4, d, h, mi, 4);
  for (const m of [1, 3, 15, 30, 60]) assert.strictEqual(B.frameUntil(new Date(edt(27, 10)), m).getTime(), edt(27, 10) + m * 60000, `${m}m`);
  // The last bars before the 16:00 ET break: held until the first bar after the 18:00 ET open closes.
  assert.strictEqual(iso(B.frameUntil(new Date(edt(27, 16)), 60)), iso(edt(27, 19)));
  assert.strictEqual(iso(B.frameUntil(new Date(edt(27, 16)), 15)), iso(edt(27, 18, 15)));
  assert.strictEqual(iso(B.frameUntil(new Date(edt(27, 16)), 1)), iso(edt(27, 18, 1)));
  // 15:00-16:00 is still a session bar: its predecessor holds only to 16:00.
  assert.strictEqual(iso(B.frameUntil(new Date(edt(27, 15)), 60)), iso(edt(27, 16)));
  // Friday's last bar holds over the weekend, to Sunday's first.
  assert.strictEqual(iso(B.frameUntil(new Date(edt(24, 16)), 60)), iso(edt(26, 19)));
  // DST starts Sunday 2026-03-08 (EST -5 to EDT -4) and ends Sunday 2026-11-01: Sunday's 19:00 ET is an hour apart in UTC.
  assert.strictEqual(iso(B.frameUntil(new Date(ET(2026, 3, 6, 16, 0, 5)), 60)), iso(ET(2026, 3, 8, 19, 0, 4)));
  assert.strictEqual(iso(B.frameUntil(new Date(ET(2026, 10, 30, 16, 0, 4)), 60)), iso(ET(2026, 11, 1, 19, 0, 5)));
  assert.strictEqual(iso(B.frameUntil(new Date(ET(2026, 10, 30, 16, 0, 4)), 15)), iso(ET(2026, 11, 1, 18, 15, 5)));
});

test('1h bars across the DST change and the daily break: built on the ET hour; the briefing holds from its close until the next one, never at or after it', () => {
  // Friday 2026-03-06 13:00 EST to Monday 2026-03-09 12:00 EDT.
  const bars = sessionBars(ET(2026, 3, 6, 13, 0, 5), ET(2026, 3, 9, 12, 0, 4));
  const h1 = whole(bars, 60);
  // Every 1h bar opens on an ET hour: 13:00-15:00 EST Friday, then from 18:00 EDT Sunday (22:00 UTC, not 23:00).
  assert.deepStrictEqual(h1.slice(0, 3).map(b => b.t), ['2026-03-06T18:00:00.000Z', '2026-03-06T19:00:00.000Z', '2026-03-06T20:00:00.000Z']);
  assert.strictEqual(h1[3].t, '2026-03-08T22:00:00.000Z');
  // The runner's briefing and the 1h one at Friday's 16:00 EST close, then at Sunday's first 3m close and its 19:00 close.
  const at = t => bars.findIndex(b => Date.parse(b.t) + 180000 === t) + 1;
  const mk = (n, prev = null) => B.buildBriefing({ symbol: 'MNQ', contractId: C, bars: bars.slice(0, n), minutes: 3, prev });
  const friday = mk(at(ET(2026, 3, 6, 16, 0, 5)));
  const f1 = B.buildFrameBriefing({ symbol: 'MNQ', contractId: C, bars: whole(bars.slice(0, at(ET(2026, 3, 6, 16, 0, 5))), 60), minutes: 60, first: friday });
  assert.strictEqual(f1.asOf, '2026-03-06T20:00:00.000Z');
  assert.strictEqual(f1.sections.bar.validUntil, iso(ET(2026, 3, 8, 19, 0, 4)), 'Friday\'s last 1h bar holds to Sunday 19:00 EDT');
  const until = Date.parse(f1.sections.bar.validUntil);
  assert.ok(B.frameHolds(f1, new Date(Date.parse(f1.closedAt))) && B.frameHolds(f1, new Date(until - 1)));
  assert.ok(!B.frameHolds(f1, new Date(until)) && !B.frameHolds(f1, new Date(Date.parse(f1.closedAt) - 1)));
  // Sunday 18:03 EDT: the runner's parts are new (the break expired them), so a report keyed on Friday's misses; then
  // the 1h report made at 18:03 holds to 19:00 and is never served at 19:00.
  const sunday = mk(at(ET(2026, 3, 8, 18, 3, 4)), friday);
  assert.notStrictEqual(sunday.sections.h1.version, friday.sections.h1.version);
  const fNow = RC.frameVersions(sunday, f1, 60, new Date(ET(2026, 3, 8, 18, 3, 4)));
  assert.deepStrictEqual(Object.keys(fNow.versions), ['bar', 'h1', 'day']);
  assert.strictEqual(fNow.until, f1.sections.bar.validUntil);
  assert.strictEqual(RC.frameVersions(sunday, f1, 60, new Date(ET(2026, 3, 8, 19, 0, 4))), null);
  const f2 = B.buildFrameBriefing({ symbol: 'MNQ', contractId: C, bars: whole(bars.slice(0, at(ET(2026, 3, 8, 19, 0, 4))), 60), minutes: 60, first: mk(at(ET(2026, 3, 8, 19, 0, 4)), sunday) });
  assert.strictEqual(f2.asOf, '2026-03-08T22:00:00.000Z');
  assert.strictEqual(f2.sections.bar.validUntil, iso(ET(2026, 3, 8, 20, 0, 4)));
});

test('a briefing on an analyst\'s timeframe: its bar part on its own bars, the gate\'s trend rule, the runner\'s parts it shares; setups only on a lane\'s bars', () => {
  const f = first(1300);
  const h = frame(f, 60);
  const q = frame(f, 15);
  assert.strictEqual(h.minutes, 60);
  assert.match(h.sections.bar.version, /^bar60m@/);
  assert.strictEqual(h.sections.bar.data.trendRule, f.sections.m3.data.trendRule, 'the trend rule is the gate\'s, never one read off 1h bars');
  const gate = { ...f, sections: { ...f.sections, m3: { ...f.sections.m3, data: { ...f.sections.m3.data, trendRule: 'Trend rule: the gate\'s own line' } } } };
  assert.strictEqual(frame(gate, 60).sections.bar.data.trendRule, 'Trend rule: the gate\'s own line');
  assert.ok(!('candidates' in h.sections.bar.data) && /not scanned on 60m bars/.test(h.sections.bar.data.setups));
  assert.deepStrictEqual(Object.keys(h.sections), ['bar'], 'the shared parts are read from the runner\'s briefing, never copied');
  assert.deepStrictEqual([B.sharedParts(1), B.sharedParts(15), B.sharedParts(30), B.sharedParts(60)], [['m15', 'h1', 'day'], ['m15', 'h1', 'day'], ['h1', 'day'], ['h1', 'day']]);
  const text = B.renderFrameBriefing(h, f, { now: new Date(h.closedAt) });
  assert.match(text, /^Bar briefing MNQ 60m \(your own timeframe; the runner's bars are 3m\)/);
  assert.match(text, /may be up to one 60m bar old/);
  assert.match(text, /\[bar 60m\] version bar60m@/);
  assert.match(text, new RegExp(`\\[h1\\] version ${f.sections.h1.version}`));
  assert.doesNotMatch(text, /\[m15\]/);
  assert.match(text, /- Alignment: not in a 60m briefing/);
  assert.match(text, /- Setups: not scanned on 60m bars \(no lane trades them\): this bar's setups are in the 3m bar briefing\./);
  assert.match(B.renderFrameBriefing(q, f, { now: new Date(q.closedAt) }), new RegExp(`\\[m15\\] version ${f.sections.m15.version}`));
  // On a lane's bars its scan is its setups.
  const lane = B.buildFrameBriefing({ symbol: 'MNQ', contractId: C, bars: BARS.slice(0, 1300), minutes: 5, first: f, lane: true, scan: [{ name: 'x', direction: 'long', candidate: true, stopDistance: 10, exit: {} }] });
  assert.deepStrictEqual(lane.sections.bar.data.candidates.map(c => c.name), ['x']);
  assert.ok(!('setups' in lane.sections.bar.data));
  // Never without the runner's briefing, or on another contract's.
  assert.throws(() => B.buildFrameBriefing({ symbol: 'MNQ', contractId: C, bars: whole(BARS.slice(0, 1300), 60), minutes: 60, first: null }), /no runner bar briefing/);
  assert.throws(() => B.buildFrameBriefing({ symbol: 'MNQ', contractId: 'MNQ:2026-09', bars: whole(BARS.slice(0, 1300), 60), minutes: 60, first: f }), /not MNQ MNQ:2026-09/);
});

// opencode's task events, as the cycle's output carries them.
const task = (role, report, [start, end]) => JSON.stringify({ type: 'tool_use', part: { tool: 'task', state: { status: 'completed', input: { subagent_type: role }, output: `<task id="s" state="completed">\n<task_result>\n${report}\n</task_result>\n</task>`, time: { start, end } } } });
const ACCT = { id: 7, balance: 100000, positions: [], orders: [], workingOrders: 0, attempts: [] };
const DAY = '2026-04-27';
const dataOf = (f, fr) => `Data: bar_briefing ${fr.minutes === 60 ? '1h' : `${fr.minutes}m`} ${[fr.sections.bar.version, ...B.sharedParts(fr.minutes).map(p => f.sections[p].version)].join(', ')}\nBias: long`;
const legacyData = f => `Data: bar_briefing ${['m3', 'm15', 'h1', 'day'].map(p => f.sections[p].version).join(', ')}\nBias: long`;

/** The cache after one cycle at runner bar n (3m), the 15m and 1h analysts reporting on their own briefings, the third on the 3m one. */
function cycleAt(n, { prev = null, served = [], prevBriefing = null, text = null } = {}) {
  const f = first(n, prevBriefing);
  const fr = { 15: frame(f, 15), 60: frame(f, 60) };
  const now = new Date(f.closedAt);
  const frames = { [ANALYSTS[1]]: 15, [ANALYSTS[2]]: 60 };
  const output = [
    task(ANALYSTS[0], legacyData(f), [1, 2]),
    task(ANALYSTS[1], text ? text(f, fr[15]) : dataOf(f, fr[15]), [1, 3]),
    task(ANALYSTS[2], text ? text(f, fr[60]) : dataOf(f, fr[60]), [1, 4]),
    task('risk-manager', 'Phase 1: budget 2 trades', [1, 5]),
  ].filter((_x, k) => !served.includes([...ANALYSTS, 'risk-manager'][k])).join('\n');
  const args = { briefings: { MNQ: f }, symbols: [{ symbol: 'MNQ', bar: f.asOf, contractId: C }], account: ACCT, day: DAY, frames, frameBriefings: { MNQ: fr } };
  const cache = RC.recordReports({ prev, output, served, now, ...args });
  return { f, fr, now, cache, args };
}

test('report cache, own timeframes: a 15m report holds within its 15m bar, a 1h one within its hour; each misses at its own close and never past it', () => {
  // A run of 3m bars across an hour: n0 is the bar that closes on the hour.
  const n0 = BARS.findIndex((b, i) => i > 1250 && new Date(Date.parse(b.t) + 180000).getUTCMinutes() === 0) + 1;
  const c0 = cycleAt(n0);
  assert.deepStrictEqual(Object.keys(c0.cache.analysts).sort(), [...ANALYSTS].sort());
  assert.deepStrictEqual([c0.cache.analysts[ANALYSTS[1]].tf, c0.cache.analysts[ANALYSTS[2]].tf, c0.cache.analysts[ANALYSTS[0]].tf], [15, 60, undefined]);
  let prevB = c0.f;
  const seq = [];
  for (let n = n0 + 1; n <= n0 + 20; n += 1) {
    const f = first(n, prevB);
    prevB = f;
    const fr = { 15: frame(f, 15), 60: frame(f, 60) };
    const now = new Date(f.closedAt);
    const s = RC.serveReports({ cache: c0.cache, briefings: { MNQ: f }, symbols: [{ symbol: 'MNQ', bar: f.asOf, contractId: C }], account: ACCT, day: DAY, now, frames: c0.args.frames, frameBriefings: { MNQ: fr } });
    seq.push(`${new Date(now).toISOString().slice(11, 16)} ${['market-structure', 'trend-momentum', 'volume-liquidity'].filter((_r, k) => s.roles.includes(ANALYSTS[k])).join('+') || 'none'}`);
    const tm = s.reports.find(r => r.role === ANALYSTS[1]);
    const vl = s.reports.find(r => r.role === ANALYSTS[2]);
    if (tm) assert.ok(Date.parse(tm.until) > now.getTime() && tm.tf === '15m');
    if (vl) assert.ok(Date.parse(vl.until) > now.getTime() && vl.tf === '1h');
  }
  // Each own-timeframe role holds exactly while its bar does; the 3m (first lane) analyst keeps the legacy rule, its
  // 15m-and-up view to the next 15m close.
  const minute = x => Number(x.slice(3, 5));
  for (const line of seq) {
    const m = minute(line);
    assert.strictEqual(/trend-momentum/.test(line), m > 0 && m < 15, line);
    assert.strictEqual(/market-structure/.test(line), m > 0 && m < 15, line);
    // The hour's last 3m close is the next hour's first: the 1h report misses there, and only there.
    assert.strictEqual(/volume-liquidity/.test(line), line.slice(0, 5) !== c0.fr[60].sections.bar.validUntil.slice(11, 16), line);
  }
  // The 1h report at its own expiry instant: served a millisecond before, never at it (whatever the briefings say).
  const vlUntil = Date.parse(c0.fr[60].sections.bar.validUntil);
  const ser = at => RC.serveReports({ cache: c0.cache, ...c0.args, now: new Date(at) }).roles;
  assert.ok(ser(vlUntil - 1).includes(ANALYSTS[2]));
  assert.ok(!ser(vlUntil).includes(ANALYSTS[2]));
  const tmUntil = Date.parse(c0.fr[15].sections.bar.validUntil);
  assert.ok(ser(tmUntil - 1).includes(ANALYSTS[1]) && !ser(tmUntil).includes(ANALYSTS[1]));
  // A shared part that ends before its bar (a runner briefing not rebuilt since): never served past the part's end.
  const h1End = Date.parse(c0.f.sections.h1.validUntil);
  const early = { ...c0.f, sections: { ...c0.f.sections, day: { ...c0.f.sections.day, validUntil: iso(Date.parse(c0.f.closedAt) + 60000) } } };
  const withDay = at2 => RC.serveReports({ cache: c0.cache, ...c0.args, briefings: { MNQ: early }, now: new Date(at2) }).roles.includes(ANALYSTS[2]);
  assert.ok(h1End > Date.parse(c0.f.closedAt) + 60000);
  assert.deepStrictEqual([withDay(Date.parse(c0.f.closedAt) + 59999), withDay(Date.parse(c0.f.closedAt) + 60000)], [true, false]);
  // No clock: no own-timeframe report (its age can't be known).
  assert.ok(!RC.serveReports({ cache: c0.cache, ...c0.args, now: null }).roles.some(r => [ANALYSTS[1], ANALYSTS[2]].includes(r)));
});

test('report cache, own timeframes: keyed on exactly its parts; a report that names other versions, or the 3m briefing, is never cached for it; entries never cross between the rules', () => {
  const c = cycleAt(1300);
  const at = c.now;
  const serve = (cache, more = {}) => RC.serveReports({ cache, ...c.args, now: at, ...more }).roles;
  assert.ok(serve(c.cache).includes(ANALYSTS[2]));
  // Its own bar changes (a rebuilt 1h briefing on another bar): a miss. A missing or other-contract briefing: a miss.
  const moved = { ...c.fr[60], sections: { bar: { ...c.fr[60].sections.bar, version: 'bar60m@2026-04-27T15:00:00.000Z' } } };
  assert.ok(!serve(c.cache, { frameBriefings: { MNQ: { ...c.fr, 60: moved } } }).includes(ANALYSTS[2]));
  assert.ok(!serve(c.cache, { frameBriefings: { MNQ: { 15: c.fr[15] } } }).includes(ANALYSTS[2]));
  assert.ok(!serve(c.cache, { frameBriefings: { MNQ: { ...c.fr, 60: { ...c.fr[60], contractId: 'MNQ:2026-09' } } } }).includes(ANALYSTS[2]));
  // An m15 change is a 15m analyst's miss, never a 1h one's (it carries no m15).
  const m15moved = { ...c.f, sections: { ...c.f.sections, m15: { ...c.f.sections.m15, version: 'm15@2099-01-01T00:00:00.000Z' } } };
  const roles = serve(c.cache, { briefings: { MNQ: m15moved } });
  assert.ok(roles.includes(ANALYSTS[2]) && !roles.includes(ANALYSTS[1]) && !roles.includes(ANALYSTS[0]));
  // A report on the 3m briefing from an analyst set to 1h: never cached for it.
  const wrong = cycleAt(1300, { text: f => legacyData(f) });
  assert.ok(!(ANALYSTS[2] in wrong.cache.analysts) && !(ANALYSTS[1] in wrong.cache.analysts));
  // A report naming another timeframe's bar: never cached.
  const other = cycleAt(1300, { text: (f, fr) => dataOf(f, fr).replace(/bar(15|60)m@/, 'bar30m@') });
  assert.ok(!(ANALYSTS[2] in other.cache.analysts));
  // The Data line may shorten each version to its clock time: the current ones, given them.
  const shortened = cycleAt(1300, { text: (f, fr) => dataOf(f, fr).replace(/@\d{4}-\d{2}-\d{2}T(\d\d:\d\d)[\d:.]*Z/g, '@$1') });
  assert.deepStrictEqual(shortened.cache.analysts[ANALYSTS[2]].versions, c.cache.analysts[ANALYSTS[2]].versions);
  // The rules never cross: a legacy entry is never served to a role now on its own timeframe, nor its entry to the legacy rule.
  const legacyOnly = RC.serveReports({ cache: c.cache, ...c.args, frames: {}, now: at }).roles;
  assert.ok(!legacyOnly.includes(ANALYSTS[1]) && !legacyOnly.includes(ANALYSTS[2]) && legacyOnly.includes(ANALYSTS[0]));
  const asFrame = RC.serveReports({ cache: c.cache, ...c.args, frames: { ...c.args.frames, [ANALYSTS[0]]: 15 }, now: at }).roles;
  assert.ok(!asFrame.includes(ANALYSTS[0]));
  // A served role keeps its entry (only its own rule's); phase 1 is the account's, every cycle, whatever the analysts hit.
  const next = RC.recordReports({ prev: c.cache, output: '', served: [ANALYSTS[2]], now: at, ...c.args });
  assert.deepStrictEqual(next.analysts[ANALYSTS[2]], c.cache.analysts[ANALYSTS[2]]);
  const changed = { ...ACCT, balance: 99950 };
  const s2 = RC.serveReports({ cache: c.cache, ...c.args, account: changed, now: at });
  assert.ok(s2.roles.includes(ANALYSTS[2]) && !s2.roles.includes('risk-manager'), 'the account changed: phase 1 runs; the 1h report still holds');
  // Several symbols: no own-timeframe report (one report can't show which it covers).
  const two = RC.serveReports({ cache: { ...c.cache, symbols: [['MNQ', C], ['MES', null]] }, ...c.args, symbols: [...c.args.symbols, { symbol: 'MES', bar: c.f.asOf, contractId: null }], now: at });
  assert.ok(!two.roles.some(r => ANALYSTS.includes(r)));
});

test('a 1m analyst on a 1m lane: its report holds one minute, served at most until its next 1m close', () => {
  const f = first(1300);
  const bars1 = BARS.slice(1200, 1300).flatMap(b => [0, 1, 2].map(k => ({ t: iso(Date.parse(b.t) + k * 60000), o: b.o, h: b.h, l: b.l, c: b.c, v: 1 })));
  const fr = B.buildFrameBriefing({ symbol: 'MNQ', contractId: C, bars: bars1, minutes: 1, first: f, lane: true, scan: [] });
  assert.strictEqual(fr.closedAt, f.closedAt);
  assert.strictEqual(Date.parse(fr.sections.bar.validUntil) - Date.parse(fr.closedAt), 60000);
  const args = { briefings: { MNQ: f }, symbols: [{ symbol: 'MNQ', bar: f.asOf, contractId: C }], account: ACCT, day: DAY, frames: { [ANALYSTS[0]]: 1 }, frameBriefings: { MNQ: { 1: fr } } };
  const now = new Date(f.closedAt);
  const cache = RC.recordReports({ output: task(ANALYSTS[0], dataOf(f, fr), [1, 2]), now, ...args });
  assert.deepStrictEqual(Object.keys(cache.analysts[ANALYSTS[0]].versions), ['bar', 'm15', 'h1', 'day']);
  const at = ms => RC.serveReports({ cache, ...args, now: new Date(Date.parse(f.closedAt) + ms) }).roles.includes(ANALYSTS[0]);
  assert.deepStrictEqual([at(0), at(59999), at(60000)], [true, true, false]);
});

test('bar_briefing with a timeframe: the analyst\'s briefing holding at the cycle\'s start (FTH_CYCLE_AT), with the shared parts; old, missing and after the replay clock are refused', () => {
  const home = tmpDir();
  try {
    const f = first(1300);
    const h = frame(f, 60);
    B.writeBriefing(home, f);
    B.writeFrameBriefing(home, h);
    const at = Date.parse(f.closedAt);
    const env = { FTH_HOME: home, FTH_CYCLE_BARS: JSON.stringify({ MNQ: f.asOf }), FTH_CYCLE_AT: iso(at) };
    const ctx = (e = env, now = at + 3600000) => ({ env: e, now: () => new Date(now), replayAt: () => null });
    // FTH_CYCLE_AT decides, however long the cycle runs (the clock an hour later).
    const text = barBriefing({ symbol: 'MNQ', timeframe: '1h' }, ctx()).text;
    assert.match(text, /^Bar briefing MNQ 60m \(your own timeframe/);
    assert.match(text, /\[bar 60m\]/);
    const json = JSON.parse(barBriefing({ symbol: 'MNQ', timeframe: '60m', json: true }, ctx()).text);
    assert.deepStrictEqual(Object.keys(json.shared), ['h1', 'day']);
    assert.strictEqual(json.shared.h1.version, f.sections.h1.version);
    // The runner's own timeframe is the plain briefing.
    assert.match(barBriefing({ symbol: 'MNQ', timeframe: '3m' }, ctx()).text, /^Bar briefing MNQ 3m, bar/);
    // At or past its bar's end: old. Without FTH_CYCLE_AT, the clock decides.
    const until = Date.parse(h.sections.bar.validUntil);
    assert.match(barBriefing({ symbol: 'MNQ', timeframe: '1h' }, ctx({ ...env, FTH_CYCLE_AT: iso(until) })).text, /^The 60m bar briefing for MNQ is old/);
    const noAt = { ...env };
    delete noAt.FTH_CYCLE_AT;
    assert.match(barBriefing({ symbol: 'MNQ', timeframe: '1h' }, ctx(noAt, until - 1)).text, /^Bar briefing MNQ 60m/);
    assert.match(barBriefing({ symbol: 'MNQ', timeframe: '1h' }, ctx(noAt, until)).text, /is old/);
    // A timeframe no analyst is on; a malformed one.
    assert.match(barBriefing({ symbol: 'MNQ', timeframe: '15m' }, ctx()).text, /^No 15m bar briefing for MNQ: the runner builds one only for an analyst configured on 15m/);
    assert.throws(() => barBriefing({ symbol: 'MNQ', timeframe: '15' }, ctx()), /--timeframe/);
    // Several lanes: the briefing's bar named apart from the 1m bar that closed is this cycle's.
    assert.match(barBriefing({ symbol: 'MNQ', timeframe: '1h' }, ctx({ ...env, FTH_CYCLE_BARS: JSON.stringify({ MNQ: '2026-01-01T00:00:00.000Z' }), FTH_CYCLE_BRIEFING_BARS: JSON.stringify({ MNQ: f.asOf }) })).text, /^Bar briefing MNQ 60m/);
    // The runner's briefing not this cycle's: no briefing at all, on any timeframe.
    assert.match(barBriefing({ symbol: 'MNQ', timeframe: '1h' }, ctx({ ...env, FTH_CYCLE_BARS: JSON.stringify({ MNQ: '2026-01-01T00:00:00.000Z' }) })).text, /^The bar briefing for MNQ is old/);
    // Under a replay clock before its bar closed: never served (no look-ahead).
    const replay = { env, now: () => new Date(at), replayAt: () => new Date(Date.parse(h.closedAt) - 1) };
    assert.match(barBriefing({ symbol: 'MNQ', timeframe: '1h' }, { ...replay, replayAt: () => new Date(at) }).text, /^Bar briefing MNQ 60m/);
    assert.match(barBriefing({ symbol: 'MNQ', timeframe: '1h' }, replay).text, /not served/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the runner\'s recorder: each analyst timeframe\'s briefing and bars file next to the runner\'s; kept while its bar is the same; none without the runner\'s', () => {
  const home = tmpDir();
  const dataDir = path.join(home, 'bars');
  const logs = [];
  try {
    const cfg = validateConfig({ harness: 'opencode', symbols: ['MNQ'], account: '7', timeframe: 3, premarketAt: '' });
    let clock = Date.parse(BARS[1300].t);
    const rec = briefingRecorder(home, cfg, () => new Date(clock), { FTH_HOME: home, FTH_BLACKOUTS_FILE: path.join(home, 'none.json') }, { frames: [{ role: ANALYSTS[1], minutes: 15, lane: -1 }, { role: ANALYSTS[2], minutes: 60, lane: -1 }, { role: ANALYSTS[0], minutes: 1, lane: 1 }], dataDir, log: (m, l) => logs.push([l, m]) });
    const item = n => ({ symbol: 'MNQ', contractId: C, lane: 0, minutes: 3, bars: BARS.slice(0, n), bar: { t: BARS[n - 1].t } });
    const n0 = BARS.findIndex((b, i) => i > 1250 && new Date(Date.parse(b.t) + 180000).getUTCMinutes() === 0) + 1;
    rec(item(n0), [], null);
    const h = B.readFrameBriefing(home, 'MNQ', 60);
    const q = B.readFrameBriefing(home, 'MNQ', 15);
    assert.strictEqual(h.closedAt, B.readBriefing(home, 'MNQ').closedAt, 'built on the hour: the 1h bar closed with this 3m bar');
    assert.strictEqual(h.barsFile, path.join(dataDir, 'MNQ-60m.json'));
    const file = JSON.parse(fs.readFileSync(h.barsFile, 'utf8'));
    assert.deepStrictEqual([file.barSize, file.builtFrom, file.bars.at(-1).t], ['60 minute', '3 minute', h.asOf]);
    assert.strictEqual(q.asOf, iso(Date.parse(h.closedAt) - 15 * 60000));
    // The next 3m bar: the same 1h bar, kept as it was (not rebuilt); the 15m one too.
    clock += 180000;
    rec(item(n0 + 1), [], null);
    assert.deepStrictEqual(B.readFrameBriefing(home, 'MNQ', 60), h);
    assert.deepStrictEqual(B.readFrameBriefing(home, 'MNQ', 15), q);
    // Another lane's bar briefs only an analyst on its timeframe (a 1m lane here), with its scan.
    const bars1 = BARS.slice(1200, n0 + 1).flatMap(b => [0, 1, 2].map(k => ({ t: iso(Date.parse(b.t) + k * 60000), o: b.o, h: b.h, l: b.l, c: b.c, v: 1 })));
    rec({ symbol: 'MNQ', contractId: C, lane: 1, minutes: 1, bars: bars1, bar: { t: bars1.at(-1).t, file: '/x/MNQ-1m.json' } }, [{ name: 'q', direction: 'long', candidate: true, stopDistance: 5, exit: {} }], null);
    const m1 = B.readFrameBriefing(home, 'MNQ', 1);
    assert.deepStrictEqual([m1.barsFile, m1.sections.bar.data.candidates.map(c => c.name)], ['/x/MNQ-1m.json', ['q']]);
    rec({ symbol: 'MNQ', contractId: C, lane: 2, minutes: 5, bars: bars1, bar: { t: bars1.at(-1).t } }, [], null);
    assert.strictEqual(B.readFrameBriefing(home, 'MNQ', 5), null, 'no analyst on 5m: no 5m briefing');
    // The runner's briefing fails: the timeframes built from it go too (an older one is never read as this bar's).
    assert.throws(() => rec(item(2), [], null), /need closed bars/);
    assert.deepStrictEqual([B.readBriefing(home, 'MNQ'), B.readFrameBriefing(home, 'MNQ', 60), B.readFrameBriefing(home, 'MNQ', 15)], [null, null, null]);
    // A timeframe's own failure is logged and removes only it.
    clock += 180000;
    rec(item(n0 + 2), [], null);
    rec({ symbol: 'MNQ', contractId: 'MNQ:2026-09', lane: 1, minutes: 1, bars: bars1, bar: { t: bars1.at(-1).t } }, [], null);
    assert.ok(B.readBriefing(home, 'MNQ') && B.readFrameBriefing(home, 'MNQ', 60));
    assert.strictEqual(B.readFrameBriefing(home, 'MNQ', 1), null);
    assert.ok(logs.some(([l, m]) => l === 'error' && /no 1m bar briefing this bar/.test(m)));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the cycle\'s environment and prompt: the briefing\'s bar per symbol, the cycle\'s start, each launched analyst\'s timeframe; nothing new without own timeframes', () => {
  const cfg = validateConfig({ harness: 'claude', symbols: ['MNQ'], account: '7', timeframe: 3, premarketAt: '' });
  const base = { HOME: '/h', FTH_HOME: '/h/.fth', FTH_CYCLE_AT: 'stale', FTH_CYCLE_BARS: 'stale', FTH_CYCLE_BRIEFING_BARS: 'stale' };
  const one = childEnv(cfg, '/r', base, { symbols: [{ symbol: 'MNQ', bar: { t: '2026-04-27T14:33:00.000Z' } }] });
  assert.strictEqual(one.FTH_CYCLE_BARS, JSON.stringify({ MNQ: '2026-04-27T14:33:00.000Z' }));
  assert.ok(!('FTH_CYCLE_AT' in one), 'no own timeframes: no cycle start');
  // Several lanes: the first lane's bar (the briefing's), not the 1m bar that closed last.
  const multi = childEnv(cfg, '/r', base, { symbols: [{ symbol: 'MNQ', bar: { t: '2026-04-27T14:33:00.000Z' } }, { symbol: 'MNQ', bar: { t: '2026-04-27T14:35:00.000Z' } }], cycleBars: { MNQ: '2026-04-27T14:33:00.000Z' }, cycleAt: '2026-04-27T14:36:02.000Z' });
  assert.deepStrictEqual([multi.FTH_CYCLE_BRIEFING_BARS, multi.FTH_CYCLE_AT], [JSON.stringify({ MNQ: '2026-04-27T14:33:00.000Z' }), '2026-04-27T14:36:02.000Z']);
  // The other tools' read-once checks keep the bars that closed (a 1m scan is never sent to the 3m briefing).
  assert.strictEqual(multi.FTH_CYCLE_BARS, JSON.stringify({ MNQ: '2026-04-27T14:35:00.000Z' }));
  assert.ok(!('FTH_CYCLE_BRIEFING_BARS' in one));
  const now = new Date('2026-04-27T14:36:02Z');
  const items = [{ symbol: 'MNQ', bar: { t: '2026-04-27T14:33:00.000Z', c: 1, file: '/b/MNQ-3m.json', contractId: 'MNQ' } }];
  const full = { ...cfg, cycle: 'full' };
  const plain = prompts(full, now, '/r').trade(items, {});
  assert.strictEqual(prompts(full, now, '/r').trade(items, { frames: [] }), plain);
  const frames = [{ role: ANALYSTS[1], timeframe: '15m' }, { role: ANALYSTS[2], timeframe: '1h' }];
  assert.match(prompts(full, now, '/r').trade(items, { frames }), /Each analyst reads its own timeframe: give it that timeframe with the symbol: trend-momentum-analyst on 15m \(bar_briefing with "timeframe": "15m"; its bars file is named there\), volume-liquidity-analyst on 1h .*; the others read the 3-minute bars below/);
  // A cached analyst isn't launched, so isn't told; its report says how long it holds.
  const cached = { roles: [ANALYSTS[2]], reports: [{ role: ANALYSTS[2], text: 'Data: bar_briefing 1h ...', at: '2026-04-27T14:00:02.000Z', until: '2026-04-27T15:00:00.000Z', tf: '1h' }] };
  const p = prompts(full, now, '/r').trade(items, { frames, cached });
  assert.match(p, /give it that timeframe with the symbol: trend-momentum-analyst on 15m \(bar_briefing with "timeframe": "15m"; its bars file is named there\); the others/);
  assert.doesNotMatch(p, /volume-liquidity-analyst on 1h/);
  assert.match(p, /--- volume-liquidity-analyst report \(1h, from 10:00 ET, holds until 11:00 ET\) ---/);
  assert.match(p, /A report on an analyst's own timeframe \(volume-liquidity-analyst 1h\) holds until that timeframe's next bar close/);
  assert.doesNotMatch(p, /15m-and-up view/, 'no legacy report served: no legacy line');
  // Lean cycles launch no analysts: nothing said.
  assert.doesNotMatch(prompts({ ...cfg, cycle: 'lean' }, now, '/r').trade(items, { frames }), /own timeframe/);
});
