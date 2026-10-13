'use strict';

/**
 * The pinned inputs of the golden regression tests (tests/golden.js): the parity bar files as the series (and a
 * 1-minute series built from MNQ's 3-minute bars, three bars from each), and the same bars as a broker serves
 * them with its own nested fields:
 *   flow   the shape the shipped flow strategies read with field(): flow.ofiTrade (a number, null when the bar's
 *          minutes are incomplete), flow.complete (a boolean), flow.windows.<3|5>.{ofiTrade, delta} (null unless
 *          every bar in the window is complete). Values follow each bar's own move plus fixed noise, so the flow
 *          strategies fire (with and against the price) on pinned bars.
 *   ext    a neutral field: ext.a (a number in [-1, 1]) and ext.b.{n, flag} (a number and a boolean), read only by
 *          the fixture strategy tests/fixtures/strategies-ext/ext_reader.
 */

const crypto = require('crypto');
const path = require('path');
const { loadBars } = require('../../scripts/lib/backtest/data');

const ROOT = path.resolve(__dirname, '..', '..');
const PARITY = path.join(__dirname, 'parity');
const EXT_STRATEGIES = path.join(__dirname, 'strategies-ext');
const MINUTE = 60000;

/** Three 1-minute bars from each 3-minute bar: open, then the bar's far extreme against its close, its other extreme, then the close. */
function toMinutes(bars) {
  const out = [];
  for (const b of bars) {
    const up = b.c >= b.o;
    const path3 = [b.o, up ? b.l : b.h, up ? b.h : b.l, b.c];
    const vol = [Math.round(b.v * 0.3), Math.round(b.v * 0.3)];
    vol.push(b.v - vol[0] - vol[1]);
    for (let k = 0; k < 3; k += 1) {
      const o = path3[k];
      const c = path3[k + 1];
      const ms = b.ms + k * MINUTE;
      out.push({ t: new Date(ms).toISOString(), o, h: Math.max(o, c), l: Math.min(o, c), c, v: vol[k], ms });
    }
  }
  return out;
}

/** The fixed series: symbol (the micro the strategies trade), its bar size, and how its bars are read. */
const SERIES = [
  { label: 'MNQ 3m', symbol: 'MNQ', minutes: 3, read: () => loadBars(path.join(PARITY, 'NQ-3m.csv')) },
  { label: 'M2K 3m', symbol: 'M2K', minutes: 3, read: () => loadBars(path.join(PARITY, 'RTY-3m.csv')) },
  { label: 'MNQ 1m', symbol: 'MNQ', minutes: 1, read: () => toMinutes(loadBars(path.join(PARITY, 'NQ-3m.csv'))) },
];

const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d + 0; // + 0: never -0 (JSON has none)
const noise = i => ((i * 7919) % 1009) / 504.5 - 1; // fixed, in [-1, 1]

/** The broker's flow fields for every bar (see the header). */
function flowOf(bars) {
  const one = bars.map((b, i) => Math.max(-1, Math.min(1, round(0.7 * (b.c - b.o) / Math.max(b.h - b.l, 0.25) + 0.5 * noise(i)))));
  const complete = bars.map((_b, i) => i % 23 !== 0);
  const windowOf = (i, n) => {
    if (i < n - 1) return { ofiTrade: null, delta: null };
    const idx = Array.from({ length: n }, (_x, k) => i - k);
    if (!idx.every(k => complete[k])) return { ofiTrade: null, delta: null };
    return { ofiTrade: round(idx.reduce((s, k) => s + one[k], 0) / n), delta: Math.round(idx.reduce((s, k) => s + one[k] * bars[k].v, 0)) + 0 };
  };
  return bars.map((_b, i) => ({ ofiTrade: complete[i] ? one[i] : null, complete: complete[i], windows: { 3: windowOf(i, 3), 5: windowOf(i, 5) } }));
}

/** The neutral field on bar i. */
const extOf = i => ({ a: Math.round((((i * 37) % 21) - 10) * 10) / 100, b: { n: i % 7, flag: i % 3 === 0 } });

/** The bars with the neutral field added (a copy). */
const withExt = bars => bars.map((b, i) => ({ ...b, ext: extOf(i) }));
/** The bars with the flow fields added (a copy). */
const withFlow = bars => { const f = flowOf(bars); return bars.map((b, i) => ({ ...b, flow: f[i] })); };
/** The bars as the broker serves them: flow and the neutral field. */
const broker = bars => withExt(withFlow(bars));

/** The bars as get_bars serves them (t, o, h, l, c, v and the broker's own fields), without the loader's ms. */
const served = bars => bars.map(({ ms, ...rest }) => rest); // eslint-disable-line no-unused-vars

/** Only the bar itself, for comparing loaders: time and OHLCV. */
const ohlcv = bars => bars.map(b => ({ t: new Date(Date.parse(b.t)).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));

const digest = x => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex').slice(0, 16);

const load = s => s.read();

module.exports = { ROOT, PARITY, EXT_STRATEGIES, SERIES, toMinutes, flowOf, extOf, withExt, withFlow, broker, served, ohlcv, digest, load };
