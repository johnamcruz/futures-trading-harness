'use strict';

/**
 * The broker's history at any timeframe (broker/adapter.js history, barSpec) and the fetch to a file
 * (backtest/fetch.js): get_bars's unit and unitNumber, paging through a long span, every field the
 * broker put on its bars kept, and file formats that keep them (a CSV refused for bars that carry more).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createAdapter, barSpec, pageHistory } = require('../../scripts/lib/broker/adapter');
const { writeBarsFile, fetchToFile } = require('../../scripts/lib/backtest/fetch');
const { loadBars } = require('../../scripts/lib/backtest/data');
const { tmpDir } = require('../helpers');

const T0 = Date.UTC(2024, 5, 10, 13, 0);

/**
 * A stand-in broker server: `step`-ms bars from T0 for `n` bars, each with a nested field of its own, served
 * between startTime and endTime (inclusive), at most `limit`; it records each get_bars call's arguments.
 */
function stubServer(n, step) {
  const calls = [];
  const all = Array.from({ length: n }, (_, k) => ({ t: new Date(T0 + k * step).toISOString(), o: 1, h: 2, l: 0, c: 1, v: 10, ext: { deep: { k, list: [k] } }, note: null }));
  return {
    calls,
    all,
    mcp: {
      call: async (name, args) => {
        assert.strictEqual(name, 'get_bars');
        calls.push(args);
        const a = Date.parse(args.startTime);
        const b = Date.parse(args.endTime);
        // Newest first, as some servers answer: the adapter sorts.
        return { bars: all.filter(x => Date.parse(x.t) >= a && Date.parse(x.t) <= b).slice(0, args.limit).reverse() };
      },
      close: () => {},
    },
  };
}

test('barSpec: minutes by default (a number or "3"), or a count and unit; anything else refused', () => {
  assert.deepStrictEqual(barSpec(3), { unit: 'minute', unitNumber: 3, ms: 180000 });
  assert.deepStrictEqual(barSpec('3'), { unit: 'minute', unitNumber: 3, ms: 180000 });
  assert.deepStrictEqual(barSpec('3m'), { unit: 'minute', unitNumber: 3, ms: 180000 });
  assert.deepStrictEqual(barSpec('30s'), { unit: 'second', unitNumber: 30, ms: 30000 });
  assert.deepStrictEqual(barSpec('1H'), { unit: 'hour', unitNumber: 1, ms: 3600000 });
  assert.deepStrictEqual(barSpec('1d'), { unit: 'day', unitNumber: 1, ms: 86400000 });
  assert.deepStrictEqual(barSpec(), { unit: 'minute', unitNumber: 1, ms: 60000 });
  // Bounded by the bar's length (1 second to 1 day), whatever the unit says it in.
  assert.deepStrictEqual(barSpec('3600s'), { unit: 'second', unitNumber: 3600, ms: 3600000 });
  assert.deepStrictEqual(barSpec('24h'), { unit: 'hour', unitNumber: 24, ms: 86400000 });
  assert.deepStrictEqual(barSpec(1440), { unit: 'minute', unitNumber: 1440, ms: 86400000 });
  for (const bad of [0, -3, 1.5, '3x', 'm', '', 'abc', 99999, null, '48h', '2d', 1441, '86401s']) assert.throws(() => barSpec(bad), /timeframe .*: minutes \(3\), or a count and unit .*from 1 second to 1 day/, String(bad));
});

test('history: get_bars at the timeframe\'s unit and size, paged through a long span, every bar once, oldest first, fields untouched', async () => {
  const step = 180000;
  const n = 25000; // 25,000 3-minute bars: three pages of 10,000
  const s = stubServer(n, step);
  const adapter = createAdapter({ mcp: s.mcp });
  const got = await adapter.history('MNQ', { from: new Date(T0), to: new Date(T0 + n * step), timeframe: 3 });
  assert.strictEqual(got.length, n);
  assert.deepStrictEqual(got, s.all, 'the broker\'s own objects, every field (nested, null) kept');
  assert.ok(got.every((b, i) => !i || Date.parse(b.t) > Date.parse(got[i - 1].t)));
  assert.ok(s.calls.length >= 3 && s.calls.length <= 4, String(s.calls.length));
  for (const c of s.calls) {
    assert.deepStrictEqual([c.contractId, c.unit, c.unitNumber, c.limit, c.includePartialBar], ['MNQ', 'minute', 3, 20000, false]);
    assert.ok(Date.parse(c.endTime) - Date.parse(c.startTime) <= 10000 * step + 2, 'a page never asks for more than 10,000 bars (1 ms wider each side)');
  }
  assert.deepStrictEqual([s.calls[0].startTime, s.calls[2].endTime], [new Date(T0 - 1).toISOString(), new Date(T0 + n * step + 1).toISOString()]);
  // The 1-minute default, with start/end as before.
  const one = stubServer(30, 60000);
  const bars = await createAdapter({ mcp: one.mcp }).history('MNQ', { start: new Date(T0), end: new Date(T0 + 30 * 60000) });
  assert.strictEqual(bars.length, 30);
  assert.deepStrictEqual([one.calls[0].unit, one.calls[0].unitNumber], ['minute', 1]);
  // Hours: the interface's unit.
  const hours = stubServer(5, 3600000);
  await createAdapter({ mcp: hours.mcp }).history('MNQ', { from: new Date(T0), to: new Date(T0 + 5 * 3600000), timeframe: '1h' });
  assert.deepStrictEqual([hours.calls[0].unit, hours.calls[0].unitNumber], ['hour', 1]);
});

test('history: a bar without a readable time, or a span that isn\'t one, is refused', async () => {
  const mcp = { call: async () => ({ bars: [{ t: 'never', o: 1, h: 1, l: 1, c: 1, v: 1 }] }), close: () => {} };
  await assert.rejects(() => createAdapter({ mcp }).history('MNQ', { from: new Date(T0), to: new Date(T0 + 60000) }), /get_bars returned a bar with no readable time/);
  await assert.rejects(() => createAdapter({ mcp }).history('MNQ', { from: 'x', to: new Date(T0) }), /from and to must be times/);
  await assert.rejects(() => createAdapter({ mcp }).history('MNQ', { from: new Date(T0), to: new Date(T0 + 60000), timeframe: '3x' }), /timeframe/);
});

test('fetchToFile: JSON lines and JSON keep every field and load back with them; a CSV is refused for bars that carry more', async () => {
  const dir = tmpDir();
  const step = 180000;
  const s = stubServer(400, step);
  const adapter = createAdapter({ mcp: s.mcp });
  const span = { contractId: 'MNQ', from: new Date(T0), to: new Date(T0 + 400 * step), timeframe: 3 };
  const jsonl = path.join(dir, 'sub', 'MNQ-3m.jsonl');
  const r = await fetchToFile(adapter, { ...span, out: jsonl });
  assert.deepStrictEqual(r, { count: 400, format: 'jsonl', barSize: '3 minute', extra: ['ext', 'note'] });
  const lines = fs.readFileSync(jsonl, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 400);
  assert.deepStrictEqual(JSON.parse(lines[7]), s.all[7]);
  assert.deepStrictEqual(loadBars(jsonl).map(b => b.ext), s.all.map(b => b.ext), 'loaded with the nested field intact');
  const json = path.join(dir, 'MNQ-3m.json');
  await fetchToFile(adapter, { ...span, out: json });
  const doc = JSON.parse(fs.readFileSync(json, 'utf8'));
  assert.deepStrictEqual([doc.contractId, doc.barSize, doc.count], ['MNQ', '3 minute', 400]);
  assert.deepStrictEqual(loadBars(json)[399].ext, s.all[399].ext);
  const csv = path.join(dir, 'MNQ-3m.csv');
  await assert.rejects(() => fetchToFile(adapter, { ...span, out: csv }), /MNQ-3m\.csv: these bars carry the broker's own fields \(ext, note\), which a CSV can't hold: write \.jsonl or \.json/);
  assert.ok(!fs.existsSync(csv));
  // Plain bars may go to a CSV.
  writeBarsFile(csv, [{ t: new Date(T0).toISOString(), o: 1, h: 2, l: 0, c: 1, v: 5 }]);
  assert.strictEqual(fs.readFileSync(csv, 'utf8'), `time,open,high,low,close,volume\n${new Date(T0).toISOString()},1,2,0,1,5\n`);
  // An unknown format is refused before anything is fetched.
  const before = s.calls.length;
  await assert.rejects(() => fetchToFile(adapter, { ...span, out: path.join(dir, 'x.txt') }), /write \.jsonl/);
  assert.strictEqual(s.calls.length, before);
  assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.includes('.tmp-')), [], 'no temporary file left');
});

/**
 * A server of `n` bars every `step` ms from T0 with one behaviour at the edges of a call: `cap` bars at most, from
 * the oldest (`capFrom: 'start'`) or the newest; a start or end that is exclusive; a startTime it ignores.
 */
function edgeServer(n, step, { cap = Infinity, capFrom = 'start', startExclusive = false, endExclusive = false, ignoreStart = false } = {}) {
  const all = Array.from({ length: n }, (_, k) => ({ ms: T0 + k * step, bar: { t: new Date(T0 + k * step).toISOString(), k } }));
  const calls = [];
  const page = async (a, b) => {
    calls.push([a, b]);
    const list = all.filter(x => (ignoreStart || (startExclusive ? x.ms > a : x.ms >= a)) && (endExclusive ? x.ms < b : x.ms <= b));
    return capFrom === 'start' ? list.slice(0, cap) : list.slice(-cap);
  };
  return { all, calls, page };
}

test('pageHistory: every bar in [from, to] whatever the server does at a page\'s edges', async () => {
  const step = 60000;
  const n = 25001;
  const span = { from: T0, to: T0 + (n - 1) * step, chunk: 10000 * step };
  const want = Array.from({ length: n }, (_, k) => k);
  const ks = bars => bars.map(b => b.k);
  // A server that returns at most 5,000 bars a call (from the start of the span): continued from the last bar.
  const capped = edgeServer(n, step, { cap: 5000 });
  assert.deepStrictEqual(ks(await pageHistory(capped.page, span)), want);
  // Capped from the newest end: asked again up to the first bar it returned.
  const newest = edgeServer(n, step, { cap: 5000, capFrom: 'end' });
  assert.deepStrictEqual(ks(await pageHistory(newest.page, span)), want);
  // An exclusive start, an exclusive end, both, and a cap with an exclusive start.
  for (const o of [{ startExclusive: true }, { endExclusive: true }, { startExclusive: true, endExclusive: true }, { startExclusive: true, cap: 3000 }]) {
    assert.deepStrictEqual(ks(await pageHistory(edgeServer(n, step, o).page, span)), want, JSON.stringify(o));
  }
  // A server that ignores startTime (older bars come back too) and one that also caps from the newest end:
  // only the bars in [from, to] are kept.
  const inner = { from: T0 + 100 * step, to: T0 + 24000 * step, chunk: 10000 * step };
  const kept = Array.from({ length: 23901 }, (_, k) => k + 100);
  assert.deepStrictEqual(ks(await pageHistory(edgeServer(n, step, { ignoreStart: true }).page, inner)), kept);
  assert.deepStrictEqual(ks(await pageHistory(edgeServer(n, step, { ignoreStart: true, cap: 4000, capFrom: 'end' }).page, inner)), kept);
  // Gaps (inside pages and at their edges): nothing invented, nothing lost, and the calls stay few.
  const gappy = edgeServer(n, step);
  const hole = x => x.bar.k % 10000 > 9000 || (x.bar.k > 3000 && x.bar.k < 4500);
  const sparse = async (a, b) => (await gappy.page(a, b)).filter(x => !hole(x));
  assert.deepStrictEqual(ks(await pageHistory(sparse, span)), gappy.all.filter(x => !hole(x)).map(x => x.bar.k));
  assert.ok(gappy.calls.length <= 12, String(gappy.calls.length));
});

test('pageHistory: a server that ignores startTime and cuts the newer bars makes no progress: refused, never a hole', async () => {
  const step = 60000;
  // At most 5,000 bars a call (the limit asked), the oldest first, from wherever startTime says.
  const s = edgeServer(25001, step, { ignoreStart: true, cap: 5000 });
  await assert.rejects(() => pageHistory(s.page, { from: T0, to: T0 + 25000 * step, chunk: 10000 * step, limit: 5000 }), /get_bars made no progress: asked from .*, it returned 5000 bars \(the most asked for\), none new, and fewer up to just before its newest: it keeps the oldest bars and cuts the newer ones/);
  // Within one page: refused at the bar its cap stopped on, never a silent stop there.
  await assert.rejects(() => pageHistory(s.page, { from: T0, to: T0 + 9000 * step, chunk: 10000 * step, limit: 5000 }), /made no progress/);
  // From a span past its first 5,000 bars: refused too, not read as an empty span.
  await assert.rejects(() => pageHistory(s.page, { from: T0 + 12000 * step, to: T0 + 25000 * step, chunk: 10000 * step, limit: 5000 }), /made no progress/);
  // The same server under the limit (it cut nothing): every bar.
  const fine = edgeServer(3000, step, { ignoreStart: true, cap: 5000 });
  assert.strictEqual((await pageHistory(fine.page, { from: T0, to: T0 + 2999 * step, chunk: 1000 * step, limit: 5000 })).length, 3000);
  // A server that honours startTime and returns the limit: continued, never refused.
  const honest = edgeServer(25001, step, { cap: 5000 });
  assert.strictEqual((await pageHistory(honest.page, { from: T0, to: T0 + 25000 * step, chunk: 10000 * step, limit: 5000 })).length, 25001);
});

test('pageHistory: a server that ignores startTime and keeps the newest bars up to endTime, across the end of its data: every bar, never refused', async () => {
  const step = 60000;
  const all = Array.from({ length: 30000 }, (_, k) => ({ ms: T0 + k * step, bar: { k } }));
  const page = async (a, b) => all.filter(x => x.ms <= b).slice(-20000);
  const got = await pageHistory(page, { from: T0 + 15000 * step, to: T0 + 30060 * step, chunk: 10000 * step, limit: 20000 });
  assert.deepStrictEqual(got.map(b => b.k), Array.from({ length: 15000 }, (_, k) => k + 15000));
  // A page wholly in a break (no bar in it), with the server's full reply of older bars: not refused either.
  const gap = all.filter(x => x.bar.k < 12000 || x.bar.k >= 24000);
  const gapPage = async (a, b) => gap.filter(x => x.ms <= b).slice(-5000);
  const kept = await pageHistory(gapPage, { from: T0 + 10000 * step, to: T0 + 29999 * step, chunk: 1000 * step, limit: 5000 });
  assert.deepStrictEqual(kept.map(b => b.k), gap.filter(x => x.bar.k >= 10000).map(x => x.bar.k));
});

test('pageHistory: a server that answers with bars after the endTime asked (the same page every time) is refused', async () => {
  const step = 60000;
  const all = Array.from({ length: 25001 }, (_, k) => ({ ms: T0 + k * step, bar: { k } }));
  await assert.rejects(() => pageHistory(async () => all, { from: T0, to: T0 + 25000 * step, chunk: 10000 * step, limit: 20000 }), /get_bars returned bars after the endTime it was asked for/);
});

test('pageHistory: a bar 1 ms past `to` (inside the 1 ms a call asks wider) is not kept', async () => {
  const step = 60000;
  const s = edgeServer(300, step);
  const got = await pageHistory(s.page, { from: T0, to: T0 + 100 * step - 1, chunk: 30 * step });
  assert.deepStrictEqual(got.map(b => b.k), Array.from({ length: 100 }, (_, k) => k));
});

test('history: refuses a server that keeps its oldest bars and cuts the rest at the interface\'s 20,000-bar limit', async () => {
  const step = 60000;
  const all = Array.from({ length: 30000 }, (_, k) => ({ t: new Date(T0 + k * step).toISOString(), o: 1, h: 1, l: 1, c: 1, v: 1 }));
  const mcp = { call: async (name, a) => ({ bars: all.filter(b => Date.parse(b.t) <= Date.parse(a.endTime)).slice(0, a.limit) }), close: () => {} };
  await assert.rejects(() => createAdapter({ mcp }).history('MNQ', { from: new Date(T0 + 25000 * step), to: new Date(T0 + 29999 * step) }), /get_bars made no progress/);
});

test('pageHistory: what a server that ignores startTime gets, as documented', async () => {
  const step = 60000;
  // Keeps the oldest bars and caps below the limit: not caught (a broker must honour startTime).
  const below = edgeServer(25001, step, { ignoreStart: true, cap: 5000 });
  const got = await pageHistory(below.page, { from: T0, to: T0 + 25000 * step, chunk: 10000 * step, limit: 20000 });
  assert.deepStrictEqual(got.map(b => b.k), Array.from({ length: 5000 }, (_, k) => k), 'the bars past its cap are lost');
  // Keeps the newest bars up to endTime and holds exactly the limit: refused at the end of its data (the safe side).
  const all = Array.from({ length: 20000 }, (_, k) => ({ ms: T0 + k * step, bar: { k } }));
  const newest = async (a, b) => all.filter(x => x.ms <= b).slice(-20000);
  await assert.rejects(() => pageHistory(newest, { from: T0 + 15000 * step, to: T0 + 20060 * step, chunk: 10000 * step, limit: 20000 }), /made no progress/);
  // One bar short of the limit (19,999 bars): nothing was cut, so every bar in the span.
  const short = all.slice(0, 19999);
  const shortPage = async (a, b) => short.filter(x => x.ms <= b).slice(-20000);
  const kept = await pageHistory(shortPage, { from: T0 + 10000 * step, to: T0 + 20060 * step, chunk: 10000 * step, limit: 20000 });
  assert.deepStrictEqual(kept.map(b => b.k), Array.from({ length: 9999 }, (_, k) => k + 10000));
});

test('pageHistory: the extra call asks from one chunk before the newest bar returned up to 1 ms before it', async () => {
  const step = 60000;
  const chunk = 10000 * step;
  const s = edgeServer(25001, step, { ignoreStart: true, cap: 5000 });
  await assert.rejects(() => pageHistory(s.page, { from: T0 + 12000 * step, to: T0 + 25000 * step, chunk, limit: 5000 }), /made no progress/);
  const newest = T0 + 4999 * step;
  assert.deepStrictEqual(s.calls, [[T0 + 12000 * step - 1, T0 + 12000 * step + chunk + 1], [newest - chunk, newest - 1]]);
});

test('pageHistory: a bar at the endTime asked (1 ms past the span) is ignored; one 1 ms later is refused', async () => {
  const step = 60000;
  const s = edgeServer(100, step);
  const span = { from: T0, to: T0 + 50 * step, chunk: 100 * step };
  const at = async (a, b) => [...(await s.page(a, b)), { ms: b, bar: { k: 'edge' } }];
  assert.strictEqual((await pageHistory(at, span)).length, 51);
  const past = async (a, b) => [...(await s.page(a, b)), { ms: b + 1, bar: { k: 'past' } }];
  await assert.rejects(() => pageHistory(past, span), /returned bars after the endTime it was asked for/);
});

test('writeBarsFile: a write that fails leaves no temporary file (and no file) behind', () => {
  const dir = tmpDir();
  const ok = { t: new Date(T0).toISOString(), o: 1, h: 2, l: 0, c: 1, v: 5 };
  // A bar JSON can't write (a BigInt): fails part-way, after the first line.
  for (const name of ['bad.jsonl', 'bad.json']) {
    assert.throws(() => writeBarsFile(path.join(dir, name), [ok, { ...ok, x: 1n }]), /BigInt/);
  }
  // The rename fails: the target is a folder.
  fs.mkdirSync(path.join(dir, 'taken.jsonl'));
  assert.throws(() => writeBarsFile(path.join(dir, 'taken.jsonl'), [ok]));
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['taken.jsonl'], 'no .tmp file, and nothing half written');
});
