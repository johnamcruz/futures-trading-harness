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
  // No trend rule: neither one read off 1h bars nor the gate's copied (it would be served as current for the hour).
  assert.match(h.sections.bar.data.trendRule, /^Trend rule: not in a 60m briefing \(it would be up to a 60m bar old\): the order gate's current rule is in the runner's 3m bar briefing/);
  const gate = { ...f, sections: { ...f.sections, m3: { ...f.sections.m3, data: { ...f.sections.m3.data, trendRule: 'Trend rule: the gate\'s own line' } } } };
  assert.doesNotMatch(JSON.stringify(frame(gate, 60)), /the gate's own line/);
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

test('wholeBars: a higher-timeframe bar opens on its own boundary, whichever of its sub-bars is missing (first, middle, last)', () => {
  const edt = (h, mi) => ET(2026, 4, 27, h, mi, 4);
  const all = sessionBars(edt(11, 0), edt(16, 0)); // 11:00 .. 15:57 ET 3m bars
  const without = t => all.filter(b => b.t !== iso(t));
  for (const [label, missing] of [['first', edt(14, 0)], ['middle', edt(14, 30)], ['last', edt(14, 57)]]) {
    const bars = without(missing);
    const h1 = B.wholeBars(bars, 60);
    assert.deepStrictEqual(h1.map(b => b.t), [11, 12, 13, 14, 15].map(h => iso(edt(h, 0))), label);
    // The briefing built on them: the 14:00 bar closes at 15:00, never 15:03.
    const upTo15 = bars.filter(b => Date.parse(b.t) < edt(15, 3));
    const first15 = B.buildBriefing({ symbol: 'MNQ', contractId: C, bars: upTo15, minutes: 3 });
    const f = B.buildFrameBriefing({ symbol: 'MNQ', contractId: C, bars: B.wholeBars(upTo15, 60), minutes: 60, first: first15 });
    assert.deepStrictEqual([f.asOf, f.closedAt, f.sections.bar.validUntil], [iso(edt(14, 0)), iso(edt(15, 0)), iso(edt(16, 0))], label);
    assert.ok(B.frameHolds(f, new Date(edt(15, 3))), label);
  }
  // Not vacuous: the raw candles take the first sub-bar's time.
  assert.strictEqual(whole(without(edt(14, 0)), 60)[3].t, iso(edt(14, 3)));
  // The same OHLCV as the candles.
  assert.deepStrictEqual(B.wholeBars(all, 15).map(({ o, h, l, c, v }) => [o, h, l, c, v]), whole(all, 15).map(({ o, h, l, c, v }) => [o, h, l, c, v]));
});

test('wholeBars and nextClose agree for 15m, 30m and 1h (the candles 18:00 ET grid and the clock.js trading-day start), across both DST weekends', () => {
  for (const [from, to] of [[ET(2026, 3, 5, 9, 0, 5), ET(2026, 3, 10, 12, 0, 4)], [ET(2026, 10, 29, 9, 0, 4), ET(2026, 11, 3, 12, 0, 5)]]) {
    const bars = sessionBars(from, to);
    for (const m of [15, 30, 60]) {
      const raw = whole(bars, m);
      const stamped = B.wholeBars(bars, m);
      assert.ok(raw.length > 50, `${m}m`);
      // With no sub-bar missing, each candle's first sub-bar is its boundary: the nextClose stamp must be it.
      assert.deepStrictEqual(stamped.map(b => b.t), raw.map(b => b.t), `${m}m`);
      for (const b of stamped) assert.strictEqual(B.nextClose(new Date(b.t), m).getTime(), Date.parse(b.t) + m * 60000, `${m}m ${b.t}`);
    }
  }
});

test('the runner\'s recorder with a missing sub-bar: the 1h bars file and the served 1h briefing are boundary-stamped (14:00-15:00, not 14:03-15:03)', () => {
  const home = tmpDir();
  const dataDir = path.join(home, 'bars');
  try {
    const edt = (h, mi) => ET(2026, 4, 27, h, mi, 4);
    // 3m bars to the 15:00 close, the 14:00 one missing.
    const bars = sessionBars(edt(9, 0), edt(15, 0)).filter(b => b.t !== iso(edt(14, 0)));
    const cfg = validateConfig({ harness: 'opencode', symbols: ['MNQ'], account: '7', timeframe: 3, premarketAt: '' });
    const rec = briefingRecorder(home, cfg, () => new Date(edt(15, 0) + 2000), { FTH_HOME: home, FTH_BLACKOUTS_FILE: path.join(home, 'none.json') }, { frames: [{ role: ANALYSTS[2], minutes: 60, lane: -1 }], dataDir, log: () => {} });
    rec({ symbol: 'MNQ', contractId: C, lane: 0, minutes: 3, bars, bar: { t: bars.at(-1).t } }, [], null);
    const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'MNQ-60m.json'), 'utf8'));
    assert.strictEqual(file.bars.at(-1).t, iso(edt(14, 0)));
    assert.ok(file.bars.every(b => Date.parse(b.t) % 3600000 === 0), 'every 1h bar on the hour');
    const f = B.readFrameBriefing(home, 'MNQ', 60);
    assert.deepStrictEqual([f.asOf, f.closedAt], [iso(edt(14, 0)), iso(edt(15, 0))]);
    const env = { FTH_HOME: home, FTH_CYCLE_BARS: JSON.stringify({ MNQ: bars.at(-1).t }), FTH_CYCLE_AT: iso(edt(15, 0) + 2000) };
    assert.match(barBriefing({ symbol: 'MNQ', timeframe: '1h' }, { env, now: () => new Date(edt(15, 0) + 2000), replayAt: () => null }).text, /^Bar briefing MNQ 60m .*bar 14:00 ET closed 15:00 ET/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// One value per fact: the session's facts (computed on the runner's bars) are never in a frame. On 1h bars they would
// be wrong (no 1h bar opens at 09:30 ET: the 09:00 bar counted as overnight, no whole RTH day, the RTH VWAP without
// its 09:00 bar), and on 15m bars another number (a VWAP or a profile on coarser bars).
const SESSION_FIELDS = ['vwap', 'today', 'overnight', 'sessionProfile', 'priorProfileNodes', 'location', 'declared'];
const SESSION_NAMES = /\b(day high|day low|IB high|IB low|opening range|session high|session low|VWAP|prior RTH|overnight|prior VA[HL]|prior POC|session VA[HL]|session POC)\b/;
// The fixture's 3m bars through the one closing at hh:mm ET on Monday 2026-04-27 (EDT).
const upTo = (h, mi) => BARS.findIndex(b => Date.parse(b.t) + 180000 === ET(2026, 4, 27, h, mi, 4)) + 1;

test('one value per fact: the 15m and 1h frames on the fixture carry no session fact of their own; the ones they show are the runner\'s, the same values', () => {
  for (const [h, mi] of [[9, 33], [10, 0], [10, 45], [13, 15], [15, 57]]) {
    const f = first(upTo(h, mi));
    for (const m of [15, 60]) {
      const fr = frame(f, m);
      const d = fr.sections.bar.data;
      const label = `${m}m at ${h}:${mi}`;
      for (const k of SESSION_FIELDS) assert.ok(!(k in d), `${label}: no ${k} of its own`);
      assert.match(d.sessionLevels, new RegExp(`^not in a ${m}m briefing: .* computed on the runner's 3m bars only, one value each: in the runner's 3m bar briefing \\(bar_briefing without a timeframe\\); the prior RTH day and its profile are the \\[day\\] part below$`));
      // Its levels and sweeps are its own: no session level named in its room or its sweeps.
      for (const x of [...d.nearestLiquidity.above, ...d.nearestLiquidity.below, ...d.sweeps]) assert.doesNotMatch(x.name, SESSION_NAMES, label);
      const text = B.renderFrameBriefing(fr, f, { now: new Date(fr.closedAt) });
      // The session facts it shows are the runner's day part: the same values as the 3m briefing's.
      for (const k of ['priorRth', 'priorProfile']) assert.ok(text.includes(`  ${k}: ${JSON.stringify(f.sections.day.data[k])}`), `${label}: ${k}`);
      assert.match(text, /^- VWAP and the session's levels \(today, overnight, opening range, IB, profile\): each is in the runner's bar briefing \(bar_briefing without a timeframe\), one value in every briefing/m);
      // Above the [day] part, no prior-day level of its own.
      assert.doesNotMatch(text.split(/^\[day\]/m)[0], /prior (POC|VAH|VAL)|prior RTH (high|low|close)/, `${label}: no prior day of its own`);
    }
  }
  // The values the audit found at 13:15 on 1h bars (overnight low 27298.5, RTH VWAP 27364.53, prior POC 27406.26) and
  // on 15m bars (prior POC 27411) are in no frame; the runner's are: overnight low 27344.25, prior POC 27414.25 (on the tick).
  const f = first(upTo(13, 15));
  assert.deepStrictEqual([f.sections.m3.data.overnight.low, f.sections.day.data.priorProfile.poc], [27344.25, 27414.25]);
  const h = JSON.stringify(frame(f, 60));
  const q = JSON.stringify(frame(f, 15));
  for (const v of ['27364.53', '27406.26', '27406.25']) assert.ok(!h.includes(v), v);
  assert.ok(!/\b27411\b/.test(q));
  assert.ok(!/overnight low|"overnight"/.test(h + q));
});

test('one value per fact: a frame\'s higher-timeframe swings are only those at or above its own, and a break through one names the close that made it', () => {
  const f = first(upTo(13, 15));
  const h = frame(f, 60).sections.bar.data;
  const q = frame(f, 15).sections.bar.data;
  assert.ok(h.htfLevels.length && h.htfLevels.every(x => /^1h swing/.test(x.name) && x.brokenBy === 'a 60m close'), 'no "15m swing" made of 1h bars');
  assert.ok(q.htfLevels.some(x => /^15m swing/.test(x.name)) && q.htfLevels.every(x => x.brokenBy === 'a 15m close'));
  assert.ok(f.sections.m3.data.htfLevels.every(x => !('brokenBy' in x)), 'the runner\'s are its own closes, as before');
  assert.ok([...h.nearestLiquidity.above, ...h.nearestLiquidity.below].every(x => !/3m/.test(x.name)), 'its own swings are named by its timeframe');
});

test('every R and ATR names its timeframe: 1R in a frame is its own bars\' reference stop, labelled so; the runner\'s is labelled 3m', () => {
  const f = first(upTo(13, 15));
  const fText = B.renderBriefing(f, { now: new Date(f.closedAt) });
  assert.deepStrictEqual(f.sections.m3.data.oneR, { points: 7.91, basis: '0.5 x 3m ATR(20) 15.83, the 3m reference stop' });
  assert.match(fText, /^- Price [\d.]+\. 1R = 7\.91 pts \(0\.5 x 3m ATR\(20\) 15\.83, the 3m reference stop\)/m);
  assert.match(fText, /^- VWAP \(rth\): price above, 3\.18 x 3m ATR\(14\) away/m);
  assert.match(fText, /^- Room above \(R = the 3m reference stop\): /m);
  const q = frame(f, 15);
  const qText = B.renderFrameBriefing(q, f, { now: new Date(q.closedAt) });
  assert.deepStrictEqual(q.sections.bar.data.oneR, { points: 18.43, basis: '0.5 x 15m ATR(20) 36.87, the 15m reference stop' });
  assert.match(qText, /^- Price [\d.]+\. 1R = 18\.43 pts \(0\.5 x 15m ATR\(20\) 36\.87, the 15m reference stop\)/m);
  assert.match(qText, /^- Room above \(R = the 15m reference stop\): /m);
  assert.match(qText, /^- Room below \(R = the 15m reference stop\): /m);
  const h = frame(f, 60);
  assert.match(B.renderFrameBriefing(h, f, { now: new Date(h.closedAt) }), /^- Price [\d.]+\. 1R = [\d.]+ pts \(0\.5 x 60m ATR\(20\) [\d.]+, the 60m reference stop\)/m);
  // A frame's room is in its own R: the points over its own 1R.
  for (const x of q.sections.bar.data.nearestLiquidity.above) assert.ok(Math.abs(x.R - x.points / 18.43) < 0.01);
  // A lane's candidates: the VWAP side is against the runner's VWAP (its one value), never a VWAP off the lane's bars.
  const lane = B.buildFrameBriefing({ symbol: 'MNQ', contractId: C, bars: BARS.slice(0, upTo(13, 15)), minutes: 5, first: f, lane: true, scan: [{ name: 'x', direction: 'long', candidate: true, stopDistance: 10, exit: {} }] });
  const c = lane.sections.bar.data.candidates[0];
  const vwap = f.keyLevels.find(([n]) => n === 'VWAP (rth)')[1];
  assert.strictEqual(vwap, f.sections.m3.data.vwap.rth);
  assert.strictEqual(c.vwapSide, lane.price > vwap ? 'above' : lane.price < vwap ? 'below' : 'at');
});

// A lane's frame trades its setups: their room (the first level in the way, the levels ahead) and the frame's room
// take every key level, the session's from the runner's briefing (keyLevels, its values), never computed without them.
// The fixture's bars through the last 3m bar closing on a 15m close at or before bar n: a 15m lane bar closes with it.
const at15 = n => { let k = n; while (k > 0 && (Date.parse(BARS[k - 1].t) + 180000) % 900000 !== 0) k -= 1; return k; };
const laneAt = (f, n, scan) => B.buildFrameBriefing({ symbol: 'MNQ', contractId: C, bars: whole(BARS.slice(0, n), 15), minutes: 15, first: f, lane: true, scan });
const both = [{ name: 'x', direction: 'long', candidate: true, stopDistance: 10, exit: { trailActivateR: 2 } }, { name: 'y', direction: 'short', candidate: true, stopDistance: 10, exit: { trailActivateR: 2 } }];

test('a lane\'s traded setups: their room includes the runner\'s session levels (the same values), so a session level in the way is never skipped', () => {
  let sessionFirst = 0;
  let flips = 0;
  let profileAhead = 0;
  const PROFILE = /^(prior|session) (POC|VAH|VAL)$/;
  for (let n0 = 1100; n0 <= upTo(15, 57); n0 += 7) {
    const n = at15(n0);
    const f = first(n);
    const fr = laneAt(f, n, both);
    const d = fr.sections.bar.data;
    const keys = f.keyLevels.filter(([, p]) => Number.isFinite(p));
    // The runner's key levels hold the profiles' (prior day and session: POC, VAH, VAL), each with its shown price.
    assert.ok(['prior POC', 'prior VAH', 'prior VAL', 'session POC', 'session VAH', 'session VAL'].every(k => keys.some(([name, , shown]) => name === k && Number.isFinite(shown))), `${n}: ${keys.map(([k]) => k).join(', ')}`);
    // The session levels it uses are exactly the runner's: each one in its room has the runner's price.
    for (const x of [...d.nearestLiquidity.above, ...d.nearestLiquidity.below]) {
      for (const name of x.name.split(' / ').filter(s => SESSION_NAMES.test(s))) assert.ok(keys.some(([k, p]) => k === name && Math.abs(p - x.price) <= 0.25), `${name} ${x.price}`);
    }
    // Each candidate's room equals the one computed with every key level: the runner's session levels and its own.
    const bare = laneAt({ ...f, keyLevels: [] }, n, both).sections.bar.data;
    for (const [i, c] of d.candidates.entries()) {
      const up = c.direction === 'long';
      const ahead = keys.filter(([, p]) => (up ? p > fr.price : p < fr.price)).sort(([, a], [, b]) => (up ? a - b : b - a));
      if (ahead.length) {
        const dist = Math.abs(ahead[0][1] - fr.price);
        // The nearest session level is in its levels ahead, or three nearer levels come first; never past the first.
        assert.ok(c.inTheWay.points <= dist + 1e-9, `${c.name} at ${n}: in the way ${c.inTheWay.name} ${c.inTheWay.points} pts, a session level at ${dist}`);
        assert.ok(c.ahead.some(x => Math.abs(x.price - ahead[0][1]) <= 0.25) || c.ahead.length === 3 && c.ahead.every(x => x.points <= dist + 0.25));
        if (SESSION_NAMES.test(c.inTheWay.name)) sessionFirst += 1;
      }
      if (bare.candidates[i].inTheWay.name !== c.inTheWay.name) flips += 1;
      if (c.ahead.some(x => x.name.split(' / ').some(k => PROFILE.test(k)))) profileAhead += 1;
    }
  }
  // A profile level is in a traded setup's way on some bars: the room never leaves them out.
  assert.ok(profileAhead > 5, `${profileAhead} candidates with a profile level ahead`);
  // The check has teeth: session levels come first for some setups, and without them their room would differ.
  assert.ok(sessionFirst > 5 && flips > 5, `${sessionFirst} with a session level first, ${flips} that differ without them`);
});

test('a lane\'s candidates: the VWAP side is against the runner\'s VWAP (its one value), never a VWAP computed on the lane\'s bars', () => {
  const sideOf = (p, v) => (p > v ? 'above' : p < v ? 'below' : 'at');
  let differs = 0;
  for (let n0 = 1000; n0 <= upTo(15, 57); n0 += 5) {
    const n = at15(n0);
    const f = first(n);
    const fr = laneAt(f, n, both);
    const vw = f.keyLevels.find(([k]) => /^VWAP /.test(k));
    // The lane's own bars' VWAP side (what a VWAP computed on them would say).
    const own = B.buildBriefing({ symbol: 'MNQ', contractId: C, bars: whole(BARS.slice(0, n), 15), minutes: 15 }).sections.m3.data.vwap.side;
    for (const c of fr.sections.bar.data.candidates) {
      assert.strictEqual(c.vwapSide, vw ? sideOf(fr.price, vw[1]) : null, `${c.name} at ${n}`);
      if (c.vwapSide !== own) differs += 1;
    }
  }
  assert.ok(differs > 0, 'the fixture has bars where the lane\'s own VWAP is on the other side: the check has teeth');
});

test('a lane\'s briefing takes the session levels only from the runner\'s bar holding at its close: a bar behind, hours old or a later one is refused', () => {
  const n = upTo(13, 15);
  const refused = /the runner's bar briefing \(closed .*\) isn't the one holding at the 15m lane bar's close \(2026-04-27T17:15:00.000Z\): its session levels aren't this bar's/;
  for (const k of [upTo(8, 15), upTo(13, 12), upTo(13, 18)]) assert.throws(() => laneAt(first(k), n, both), refused, `runner bar closing ${BARS[k - 1].t}`);
  assert.ok(laneAt(first(n), n, both).sections.bar.data.candidates.length === 2, 'the runner\'s bar closing with it');
  // A faster lane inside the runner's bar: a 5m lane bar closing 13:17 reads the runner's 13:15 bar (it holds to 13:18).
  const five = B.buildFrameBriefing({ symbol: 'MNQ', contractId: C, bars: BARS.slice(0, n), minutes: 5, first: first(n), lane: true, scan: both });
  assert.strictEqual(five.closedAt, '2026-04-27T17:17:00.000Z');
  assert.throws(() => B.buildFrameBriefing({ symbol: 'MNQ', contractId: C, bars: BARS.slice(0, n), minutes: 5, first: first(upTo(13, 12)), lane: true, scan: both }), /isn't the one holding/);
  // An analyst's frame (no traded setups) builds as before.
  assert.ok(frame(first(n), 15).sections.bar);
});

test('a lane\'s briefing on a runner briefing without session levels (an older file) is refused: never a traded room without them; an analyst\'s frame needs none', () => {
  const f = first(upTo(13, 15));
  const { keyLevels, ...old } = f;
  assert.ok(Array.isArray(keyLevels) && keyLevels.length > 5);
  assert.throws(() => laneAt(old, upTo(13, 15), both), /no session levels for the 15m lane's room/);
  assert.ok(frame(old, 15).sections.bar.data.sessionLevels);
  // Rendered: a lane's summary says its room has them; an analyst's that its room is its own.
  const lane = laneAt(f, upTo(13, 15), both);
  assert.match(B.renderFrameBriefing(lane, f, { now: new Date(lane.closedAt) }), /the room below and the setups' levels include them \(the runner's values\), with this 15m bar's own\./);
  assert.match(lane.sections.bar.data.sessionLevels, /the room and the setups' levels below include the runner's session levels \(its values\)$/);
  const q = frame(f, 15);
  assert.match(B.renderFrameBriefing(q, f, { now: new Date(q.closedAt) }), /the room below is this 15m bar's own levels\./);
});

test('a frame never sweeps a session level computed on its own bars (prior RTH, overnight): where its bars would, the sweep is not in it', () => {
  // Sunday 21:03 ET (the 15m bars' own prior RTH high swept) and Monday 10:03 ET (their own overnight low swept).
  for (const n of [at15(975), at15(1235)]) {
    const own = B.buildBriefing({ symbol: 'MNQ', contractId: C, bars: whole(BARS.slice(0, n), 15), minutes: 15 }).sections.m3.data.sweeps;
    assert.ok(own.some(x => /^(prior RTH|overnight) /.test(x.name)), `${n}: the 15m bars sweep one of their own session levels`);
    const f = first(n);
    for (const fr of [frame(f, 15), laneAt(f, n, both)]) assert.ok(fr.sections.bar.data.sweeps.every(x => !SESSION_NAMES.test(x.name)), `${n}`);
  }
});

test('no look-ahead: a frame is built from completed bars only; the sub-bars of the bar still forming, or any later bar, never change it', () => {
  for (const m of [15, 60]) {
    const f = first(upTo(13, 15));
    const fr = frame(f, m);
    assert.ok(Date.parse(fr.closedAt) <= Date.parse(f.closedAt), `${m}m: closed by the runner's bar`);
    assert.strictEqual(Date.parse(fr.asOf) + m * 60000, Date.parse(fr.closedAt));
    // The same frame bar with the forming bar's sub-bars (up to one 3m bar short of its close) added.
    const lastIn = m === 15 ? upTo(13, 27) : upTo(13, 57);
    const later = frame(first(lastIn), m);
    assert.strictEqual(later.asOf, fr.asOf, `${m}m: the forming bar isn't in it`);
    assert.deepStrictEqual(later.sections.bar.data, fr.sections.bar.data, `${m}m: nothing from the forming bar`);
    // Bending every bar after its close changes nothing in it.
    const close = Date.parse(fr.closedAt);
    const bent = BARS.slice(0, lastIn).map(b => (Date.parse(b.t) >= close ? { ...b, h: b.h + 500, l: b.l - 500, c: b.c + 100 } : b));
    assert.deepStrictEqual(frame(f, m, bent).sections.bar.data, fr.sections.bar.data, `${m}m: no later bar read`);
  }
});

test('a frame\'s round numbers use the configured steps, as the runner\'s briefing (none without them)', () => {
  const { defaultRoundSteps, roundStepFor } = require('../../scripts/lib/trading/round-numbers');
  const steps = defaultRoundSteps();
  const step = roundStepFor('MNQ', steps);
  assert.ok(step > 0);
  const n = upTo(13, 15);
  const f = B.buildBriefing({ symbol: 'MNQ', contractId: C, bars: BARS.slice(0, n), minutes: 3, roundSteps: steps });
  for (const m of [15, 60]) {
    const fr = B.buildFrameBriefing({ symbol: 'MNQ', contractId: C, bars: whole(BARS.slice(0, n), m), minutes: m, first: f, roundSteps: steps });
    const room = fr.sections.bar.data.nearestLiquidity;
    const rounds = [...room.above, ...room.below].filter(x => x.name.split(' / ').includes('round number'));
    assert.ok(rounds.length >= 1 && rounds.every(x => Math.abs(x.price / step - Math.round(x.price / step)) < 1e-9), `${m}m: ${JSON.stringify(rounds)}`);
    const none = B.buildFrameBriefing({ symbol: 'MNQ', contractId: C, bars: whole(BARS.slice(0, n), m), minutes: m, first: f }).sections.bar.data.nearestLiquidity;
    assert.ok([...none.above, ...none.below].every(x => !x.name.split(' / ').includes('round number')), `${m}m without steps`);
  }
});

test('the runner\'s recorder builds 5m candles from a 1m lane\'s noted bars (same contract only); without them 5m is unavailable, and why', () => {
  const home = tmpDir();
  try {
    const cfg = validateConfig({ harness: 'opencode', symbols: ['MNQ'], account: '7', timeframe: 3, premarketAt: '' });
    const rec = briefingRecorder(home, cfg, () => new Date(Date.parse(BARS[1300].t)), { FTH_HOME: home, FTH_BLACKOUTS_FILE: path.join(home, 'none.json') }, {});
    const bars3 = BARS.slice(0, 1300);
    const ones = bars3.slice(-60).flatMap(b => [0, 1, 2].map(k => ({ t: iso(Date.parse(b.t) + k * 60000), o: b.o, h: b.h, l: b.l, c: b.c, v: 1 })));
    const item = { symbol: 'MNQ', contractId: C, lane: 0, minutes: 3, bars: bars3, bar: { t: bars3.at(-1).t } };
    rec(item, [], null);
    assert.match(B.readBriefing(home, 'MNQ').sections.m3.data.candles['5m'].unavailable, /no 1m bars configured/);
    rec.fine({ symbol: 'MNQ', contractId: 'MNQ:2026-09', lane: 1, minutes: 1, bars: ones });
    rec(item, [], null);
    assert.match(B.readBriefing(home, 'MNQ').sections.m3.data.candles['5m'].unavailable, /no 1m bars configured/, 'another contract\'s 1m bars are never read');
    rec.fine({ symbol: 'MNQ', contractId: C, lane: 1, minutes: 1, bars: ones });
    rec(item, [], null);
    const c5 = B.readBriefing(home, 'MNQ').sections.m3.data.candles['5m'];
    assert.ok(c5.closedAt && !c5.unavailable, JSON.stringify(c5));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
