'use strict';

/**
 * The field-forward study: does a bar field at bar t predict the price move AFTER t? Generic: a field is a
 * dotted path on the broker's bars (read with rules.readField, as strategies read field("...")), with an
 * optional look-back `[n]` (the value n bars earlier); the harness computes no field of its own.
 * docs/BACKTESTING.md ("The field-forward study") says what it is for.
 *
 * - Forward only: fwd_k = close[t+k] - close[t], in ticks, and the largest excursions up and down over
 *   bars t+1..t+k. The field is read from bar t's own data (or an earlier bar's, with [n]); bar t+1 on
 *   never feeds it. The same-bar move (close[t] - open[t]) is reported only as a contemporaneous
 *   reference, never as a prediction.
 * - Pairs never span a break: a new file (a chunk, possibly another contract), a contract change on the
 *   bars (`contractId`), a new trading day (the session break), or a time gap above 2x the timeframe.
 *   Those are counted as skipped.
 * - Stats per field and horizon: Pearson and Spearman IC, deciles, |field| thresholds, the hit rate (the
 *   move's sign equals the field's), block-bootstrap 95% intervals (blocks of one trading day, seeded),
 *   a cost line, and breakdowns by New York hour and by session (RTH / overnight).
 * - Held-out discipline: a span with a month whose role (prop/splits.js roleOf) is not train is refused
 *   unless a reason for the look is given, and then a warning says to record it (RECORDED_LOOKS, R16).
 */

const { readField } = require('./trading/rules');
const { tradingDayKey, zonedParts, parseWindows, SESSION_ALIASES, MARKET_TZ } = require('./trading/clock');
const { roleOf } = require('./prop/splits');

const MINUTE = 60000;
const FIELD_SPEC = /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)(?:\[(\d{1,3})\])?$/;
const FS = require('./tunables').training().fieldStudy; // config/training.json fieldStudy
const DEFAULT_QUANTILES = FS.quantiles;
const FREE_ROLES = Object.freeze(['train']);

/** 'a.b.c' or 'a.b.c[2]' -> { spec, path, shift }. */
function parseFieldSpec(text) {
  const m = FIELD_SPEC.exec(String(text || '').trim());
  if (!m) throw new Error(`field "${text}": a dotted path of letters, digits and _, optionally with a look-back [n]`);
  return { spec: m[0], path: m[1], shift: Number(m[2] || 0) };
}

/** '1,3,5' -> [1, 3, 5]: whole bars, 1 to 1000, unique, ascending. */
function parseHorizons(text) {
  const out = String(text || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
  if (!out.length || !out.every(k => Number.isInteger(k) && k >= 1 && k <= 1000)) throw new Error('--horizons: whole bars from 1 to 1000, e.g. 1,3,5,15');
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * One chunk of bars (a file, or one broker fetch) as columns: times, prices, and each field's value on
 * its own bar (NaN when absent). `fields`: parsed specs. Only what the study needs is kept.
 */
function columns(bars, fields) {
  const n = bars.length;
  const col = () => new Float64Array(n);
  const out = { n, ms: col(), o: col(), h: col(), l: col(), c: col(), contract: new Array(n), f: fields.map(col) };
  const paths = [...new Set(fields.map(f => f.path))];
  bars.forEach((b, i) => {
    out.ms[i] = Number.isFinite(b.ms) ? b.ms : Date.parse(b.t);
    out.o[i] = b.o; out.h[i] = b.h; out.l[i] = b.l; out.c[i] = b.c;
    out.contract[i] = b.contractId === undefined ? null : b.contractId;
    const read = Object.fromEntries(paths.map(p => [p, readField(b, p)]));
    fields.forEach((f, j) => { out.f[j][i] = read[f.path]; });
  });
  return out;
}

/** Per UTC hour (New York offsets are whole hours): the trading day and the New York hour. */
function hourMeta() {
  const cache = new Map();
  return ms => {
    const h = Math.floor(ms / 3600000);
    let m = cache.get(h);
    if (!m) {
      const d = new Date(h * 3600000);
      m = { day: tradingDayKey(d), hour: zonedParts(d, MARKET_TZ).hour };
      cache.set(h, m);
    }
    return m;
  };
}

/** The harness's RTH window (SESSION_ALIASES.ny) in New York minutes. */
function rthWindow() {
  const w = parseWindows(SESSION_ALIASES.ny).windows[0];
  if (!w || w.timeZone !== MARKET_TZ) throw new Error('the ny session is not a New York window');
  return w;
}

/**
 * Join chunks into one table with segments: runs of bars a pair may span. A segment ends at a chunk's
 * end, a contract change, a new trading day, a time not after the last, or a gap above 2x timeframe.
 * Returns { ms, o, h, l, c, f, day (index), dayKeys, hour, rth (0/1), segEnd (exclusive end per bar),
 * runStart (the first bar of the bar's run of the same chunk, contract and trading day, gaps allowed: the
 * bars a look-back such as an event's ATR may use) }.
 */
function joinChunks(chunks, { timeframeMin }) {
  if (!(timeframeMin > 0)) throw new Error('timeframe: minutes per bar');
  const n = chunks.reduce((a, ch) => a + ch.n, 0);
  const nf = chunks.length ? chunks[0].f.length : 0;
  const col = () => new Float64Array(n);
  const t = { n, ms: col(), o: col(), h: col(), l: col(), c: col(), f: Array.from({ length: nf }, col), day: new Int32Array(n), hour: new Int8Array(n), rth: new Uint8Array(n), segEnd: new Int32Array(n), runStart: new Int32Array(n), dayKeys: [] };
  const meta = hourMeta();
  const rth = rthWindow();
  const dayIndex = new Map();
  const maxGap = 2 * timeframeMin * MINUTE;
  let i = 0;
  const starts = [];
  for (const ch of chunks) {
    for (let j = 0; j < ch.n; j += 1, i += 1) {
      const ms = ch.ms[j];
      t.ms[i] = ms; t.o[i] = ch.o[j]; t.h[i] = ch.h[j]; t.l[i] = ch.l[j]; t.c[i] = ch.c[j];
      for (let q = 0; q < nf; q += 1) t.f[q][i] = ch.f[q][j];
      const m = meta(ms);
      if (!dayIndex.has(m.day)) { dayIndex.set(m.day, t.dayKeys.length); t.dayKeys.push(m.day); }
      t.day[i] = dayIndex.get(m.day);
      t.hour[i] = m.hour;
      const minute = m.hour * 60 + Math.floor((((ms % 3600000) + 3600000) % 3600000) / MINUTE);
      t.rth[i] = minute >= rth.start && minute < rth.end ? 1 : 0;
      const hard = j === 0 || ch.contract[j] !== ch.contract[j - 1] || t.day[i] !== t.day[i - 1] || !(ms > t.ms[i - 1]);
      t.runStart[i] = hard ? i : t.runStart[i - 1];
      if (hard || ms - t.ms[i - 1] > maxGap) starts.push(i);
    }
  }
  starts.push(n);
  for (let s = 0; s < starts.length - 1; s += 1) for (let k = starts[s]; k < starts[s + 1]; k += 1) t.segEnd[k] = starts[s + 1];
  t.segments = starts.length - 1;
  return t;
}

/**
 * The (field, forward move) pairs of field q at horizon k. x: the field at t (from bar t - shift, same
 * segment); y: fwd_k in ticks; up/dn: largest excursion above/below close[t] over t+1..t+k; same: the
 * same-bar move. Counts: skipped (t+k beyond a break), tail (beyond the data's end), missing (no field).
 */
function pairs(t, q, shift, k, tick) {
  const cap = t.n;
  const P = { x: new Float64Array(cap), y: new Float64Array(cap), up: new Float64Array(cap), dn: new Float64Array(cap), same: new Float64Array(cap), at: new Int32Array(cap), day: new Int32Array(cap), hour: new Int8Array(cap), rth: new Uint8Array(cap), n: 0, skipped: 0, tail: 0, missing: 0 };
  for (let i = 0; i < t.n; i += 1) {
    const end = t.segEnd[i];
    if (i + k >= end) {
      if (end === t.n) P.tail += 1; else P.skipped += 1;
      continue;
    }
    const src = i - shift;
    const sameRun = src >= 0 && t.segEnd[src] === end;
    const x = sameRun ? t.f[q][src] : NaN;
    if (!Number.isFinite(x)) { P.missing += 1; continue; }
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i + 1; j <= i + k; j += 1) { if (t.h[j] > hi) hi = t.h[j]; if (t.l[j] < lo) lo = t.l[j]; }
    const c0 = t.c[i];
    const m = P.n;
    P.x[m] = x; P.y[m] = (t.c[i + k] - c0) / tick; P.up[m] = (hi - c0) / tick; P.dn[m] = (c0 - lo) / tick;
    P.same[m] = (c0 - t.o[i]) / tick; P.at[m] = i; P.day[m] = t.day[i]; P.hour[m] = t.hour[i]; P.rth[m] = t.rth[i];
    P.n += 1;
  }
  return P;
}

/** The pairs at indices `idx` (a breakdown group). */
function subset(P, idx) {
  const out = { n: idx.length, skipped: 0, tail: 0, missing: 0 };
  for (const key of ['x', 'y', 'up', 'dn', 'same', 'at', 'day', 'hour', 'rth']) {
    const a = new P[key].constructor(idx.length);
    idx.forEach((i, j) => { a[j] = P[key][i]; });
    out[key] = a;
  }
  return out;
}

function pearson(x, y, n = x.length) {
  if (n < 3) return null;
  let sx = 0; let sy = 0;
  for (let i = 0; i < n; i += 1) { sx += x[i]; sy += y[i]; }
  const mx = sx / n; const my = sy / n;
  let cxy = 0; let cxx = 0; let cyy = 0;
  for (let i = 0; i < n; i += 1) { const a = x[i] - mx; const b = y[i] - my; cxy += a * b; cxx += a * a; cyy += b * b; }
  return cxx > 0 && cyy > 0 ? cxy / Math.sqrt(cxx * cyy) : null;
}

/** Ranks 1..n, ties averaged. */
function ranks(v, n = v.length) {
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => v[a] - v[b]);
  const r = new Float64Array(n);
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && v[order[j + 1]] === v[order[i]]) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let q = i; q <= j; q += 1) r[order[q]] = avg;
    i = j + 1;
  }
  return r;
}

const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
function median(a) {
  if (!a.length) return null;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** The q-quantile (nearest rank) of a sorted array. */
const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null);
const sign = v => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** Hit rate: share of pairs with a non-zero field whose move has the field's sign (a flat move misses). */
function hitRate(xs, ys) {
  let n = 0; let hit = 0;
  for (let i = 0; i < xs.length; i += 1) {
    if (xs[i] === 0) continue;
    n += 1;
    if (sign(ys[i]) === sign(xs[i])) hit += 1;
  }
  return n ? hit / n : null;
}

/** Seeded PRNG (mulberry32): the same seed, the same intervals. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let z = a;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Block-bootstrap 95% intervals, one trading day a block: the Pearson IC, the Spearman IC (Pearson on
 * the full sample's ranks), and weighted means of the move (`means`: { w } per pair, the mean being
 * sum(w * y) / sum(|w|): 1 on the top decile's pairs for its mean move, sign(field) past a threshold for
 * the move signed by the field). Sets are fixed on the full sample. Days are drawn with replacement,
 * `reps` times, from rng(seed).
 */
function bootstrap(P, { rx, ry, means = [], reps = FS.reps, seed = FS.seed }) {
  const width = 11 + 2 * means.length;
  const days = new Map();
  for (let i = 0; i < P.n; i += 1) {
    let a = days.get(P.day[i]);
    if (!a) { a = new Float64Array(width); days.set(P.day[i], a); }
    const x = P.x[i]; const y = P.y[i]; const u = rx[i]; const v = ry[i];
    a[0] += 1; a[1] += x; a[2] += y; a[3] += x * x; a[4] += y * y; a[5] += x * y;
    a[6] += u; a[7] += v; a[8] += u * u; a[9] += v * v; a[10] += u * v;
    for (let j = 0; j < means.length; j += 1) {
      const w = means[j].w[i];
      if (w !== 0) { a[11 + 2 * j] += Math.abs(w); a[12 + 2 * j] += w * y; }
    }
  }
  const blocks = [...days.values()];
  if (blocks.length < 2) return null;
  const corr = (s, o) => {
    const n = s[0];
    const cxy = s[o + 4] - (s[o] * s[o + 1]) / n;
    const cxx = s[o + 2] - (s[o] * s[o]) / n;
    const cyy = s[o + 3] - (s[o + 1] * s[o + 1]) / n;
    return cxx > 0 && cyy > 0 ? cxy / Math.sqrt(cxx * cyy) : NaN;
  };
  const draw = rng(seed);
  const out = { pearson: [], spearman: [], means: means.map(() => []) };
  const s = new Float64Array(width);
  for (let r = 0; r < reps; r += 1) {
    s.fill(0);
    for (let b = 0; b < blocks.length; b += 1) {
      const a = blocks[Math.floor(draw() * blocks.length)];
      for (let q = 0; q < width; q += 1) s[q] += a[q];
    }
    out.pearson.push(corr(s, 1));
    out.spearman.push(corr(s, 6));
    out.means.forEach((m, j) => m.push(s[11 + 2 * j] ? s[12 + 2 * j] / s[11 + 2 * j] : NaN));
  }
  const ci = v => {
    const f = Float64Array.from(v.filter(Number.isFinite)).sort();
    return f.length ? [quantile(f, 0.025), quantile(f, 0.975)] : null;
  };
  return { reps, seed, days: blocks.length, pearson: ci(out.pearson), spearman: ci(out.spearman), means: out.means.map(ci) };
}

/**
 * Whether a |field| threshold's move clears the round-trip cost: 'follow' (trading the field's sign) when
 * the interval's low end is above the cost, 'fade' (against it) when its high end is below minus the cost,
 * else null. Without an interval, nothing is claimed (null).
 */
function costVerdict(ci, costTicks) {
  if (!ci) return null;
  if (ci[0] > costTicks) return 'follow';
  if (ci[1] < -costTicks) return 'fade';
  return null;
}

/**
 * The statistics of one set of pairs: IC, deciles, thresholds, the same-bar reference, the cost line,
 * and (with `boot`) the bootstrap intervals. `thresholds`: |field| levels, else the p80/p90/p95/p99 of |field|.
 */
function summarize(P, { thresholds = null, costTicks = FS.costTicks, boot = null } = {}) {
  const n = P.n;
  const x = P.x.subarray(0, n); const y = P.y.subarray(0, n);
  const res = { n, skipped: P.skipped, tail: P.tail, missing: P.missing };
  if (n < 10) return { ...res, note: 'fewer than 10 pairs' };
  const rx = ranks(x); const ry = ranks(y);
  res.pearson = pearson(x, y);
  res.spearman = pearson(rx, ry);
  res.sameBar = { note: 'contemporaneous, NOT predictive', pearson: pearson(x, P.same.subarray(0, n)) };
  res.meanMove = mean(Array.from(y));
  res.hit = hitRate(x, y);
  // Deciles by the field's (average) rank, so equal values always share a decile: a discrete or constant
  // field leaves some deciles empty rather than splitting its ties by time.
  const bins = Array.from({ length: 10 }, () => []);
  for (let i = 0; i < n; i += 1) bins[Math.min(9, Math.floor(((rx[i] - 0.5) * 10) / n))].push(i);
  const top = new Float64Array(n); const bottom = new Float64Array(n);
  bins[0].forEach(i => { bottom[i] = 1; });
  bins[9].forEach(i => { top[i] = 1; });
  res.deciles = bins.map((idx, d) => {
    const ys = idx.map(i => y[i]);
    const xs = idx.map(i => x[i]);
    return {
      decile: d + 1, n: idx.length, from: idx.length ? xs.reduce((a, v) => (v < a ? v : a)) : null, to: idx.length ? xs.reduce((a, v) => (v > a ? v : a)) : null,
      meanMove: mean(ys), medianMove: median(ys), hit: idx.length ? hitRate(xs, ys) : null,
      meanUp: mean(idx.map(i => P.up[i])), meanDown: mean(idx.map(i => P.dn[i])),
    };
  });
  res.topMinusBottom = res.deciles[9].n && res.deciles[0].n ? res.deciles[9].meanMove - res.deciles[0].meanMove : null;
  const abs = Float64Array.from(x, Math.abs).sort();
  const levels = thresholds || DEFAULT_QUANTILES.map(q => quantile(abs, q));
  res.costTicks = costTicks;
  const weights = [];
  res.thresholds = levels.map((thr, j) => {
    const idx = [];
    const w = new Float64Array(n);
    for (let i = 0; i < n; i += 1) if (x[i] !== 0 && Math.abs(x[i]) >= thr) { idx.push(i); w[i] = sign(x[i]); }
    weights.push({ w });
    const m = mean(idx.map(i => sign(x[i]) * y[i]));
    return {
      level: thr, quantile: thresholds ? null : DEFAULT_QUANTILES[j], n: idx.length, meanSigned: m,
      hit: hitRate(idx.map(i => x[i]), idx.map(i => y[i])),
      meanFavourable: mean(idx.map(i => (x[i] > 0 ? P.up[i] : P.dn[i]))), meanAdverse: mean(idx.map(i => (x[i] > 0 ? P.dn[i] : P.up[i]))),
      net: m === null ? null : m - costTicks, netFaded: m === null ? null : -m - costTicks, ci: null, verdict: null,
    };
  });
  if (boot) {
    const b = bootstrap({ ...P, n }, { rx, ry, means: [{ w: top }, { w: bottom }, ...weights], ...boot });
    if (b) {
      res.ci = { reps: b.reps, seed: b.seed, days: b.days, pearson: b.pearson, spearman: b.spearman, top: b.means[0], bottom: b.means[1] };
      res.thresholds.forEach((r, j) => { r.ci = b.means[2 + j]; r.verdict = costVerdict(r.ci, costTicks); });
    }
  }
  // Clears the cost only where an interval says so (follow or fade); with no interval, unknown (null).
  const tested = res.thresholds.some(r => r.ci);
  res.survivesCost = tested ? res.thresholds.filter(r => r.verdict).map(r => `${r.verdict} at ${r.quantile ? `p${Math.round(r.quantile * 100)}` : r.level}`) : null;
  return res;
}

/** Breakdown groups of a set of pairs: by New York hour, or by session (RTH / overnight). */
function groups(P, by) {
  const out = new Map();
  for (let i = 0; i < P.n; i += 1) {
    const key = by === 'hour' ? String(P.hour[i]).padStart(2, '0') : P.rth[i] ? 'rth' : 'overnight';
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(i);
  }
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

/**
 * The study: for every field and horizon, the overall statistics with bootstrap intervals, and the
 * breakdowns asked for (`by`: ['hour', 'session']), each group with its own intervals.
 */
function study(t, { fields, horizons, tick, thresholds = null, costTicks = FS.costTicks, by = [], reps = FS.reps, seed = FS.seed }) {
  if (!(tick > 0)) throw new Error('tick: the contract\'s tick size');
  const results = [];
  fields.forEach((f, q) => {
    for (const k of horizons) {
      const P = pairs(t, q, f.shift, k, tick);
      const row = { field: f.spec, horizon: k, ...summarize(P, { thresholds, costTicks, boot: { reps, seed } }) };
      row.by = {};
      for (const b of by) {
        row.by[b] = groups(P, b).map(([key, idx]) => ({ key, ...summarize(subset(P, idx), { thresholds, costTicks, boot: { reps, seed } }) }));
      }
      results.push(row);
    }
  });
  return results;
}

/** 'YYYY-MM' of every trading day from `from` to `to` (ms, to exclusive). */
function monthsBetween(from, to) {
  const out = new Set();
  for (let ms = from; ms < to; ms += 6 * 3600000) out.add(tradingDayKey(new Date(ms)).slice(0, 7));
  if (to > from) out.add(tradingDayKey(new Date(to - 1)).slice(0, 7));
  return [...out].sort();
}

/**
 * Each month's role, and the held-out check: a month not in Train (Select, Out-of-sample, Recent, a
 * walk-forward or reserve half-year) is refused without `heldOutLook` (the reason for the look); with it,
 * a warning says to record the look. Months before the schedule have no role and run freely.
 */
function splitCheck(months, { heldOutLook = null } = {}) {
  const rows = months.map(month => {
    let r;
    try {
      r = roleOf(`${month}-01`);
    } catch (_err) {
      return { month, role: 'none', block: null, part: null };
    }
    return { month, role: r.role, block: r.block, part: r.part };
  });
  const held = rows.filter(r => r.role !== 'none' && !FREE_ROLES.includes(r.role));
  const reason = typeof heldOutLook === 'string' ? heldOutLook.trim() : '';
  if (held.length && !reason) {
    throw new Error(`refused: the span holds held-out or reserved months (${held.map(r => `${r.month} ${r.role}${r.part ? ` ${r.part}` : ''}`).join(', ')}). Only Train months run freely (docs/LEARNED-RULEBOOK.md section 4, R16). A deliberate look needs --held-out-look "<reason>", and the look must then be recorded.`);
  }
  const warning = held.length ? `WARNING: a held-out look at ${held.map(r => r.month).join(', ')} (${reason}). Record it in the ledger (R16) only: the schedule's recordedLooks (config/schedule.json prop.sealed.recordedLooks) are the pre-ledger looks and are frozen. Do this before using anything it shows.` : null;
  return { months: rows, heldOut: held.map(r => r.month), warning };
}

const fmt = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? '-' : Number(v).toFixed(d));
const pct = v => (v === null || v === undefined ? '-' : `${(v * 100).toFixed(1)}%`);
const ci = c => (c ? `[${fmt(c[0])}, ${fmt(c[1])}]` : '-');
const clears = r => (r.survivesCost === null ? 'not tested' : r.survivesCost.length ? r.survivesCost.join(', ') : 'no');

/** The report as Markdown. `header`: { span, source, timeframeMin, tick, costTicks, months, warning, bars, segments }. */
function toMarkdown(header, results) {
  const L = [];
  L.push('# Field-forward study', '');
  L.push(`- Span: ${header.span.from} to ${header.span.to} (${header.bars} bars, ${header.segments} unbroken runs)`);
  L.push(`- Bar source: ${header.source}; timeframe ${header.timeframeMin} min; tick ${header.tick}; round-trip cost ${header.costTicks} ticks`);
  L.push(`- Months and split roles: ${header.months.map(m => `${m.month} ${m.role}${m.part ? ` (${m.part})` : ''}`).join(', ')}`);
  if (header.warning) L.push(`- ${header.warning}`);
  L.push('- Forward moves only: fwd_k = close[t+k] - close[t] in ticks, the field read from bar t. Pairs that cross a chunk, contract, trading day or gap (> 2x timeframe) are skipped. Hit: the move has the field\'s sign (a flat move misses). Intervals: 95% block bootstrap, one trading day a block.');
  const tests = results.reduce((a, r) => a + (r.thresholds || []).length + Object.values(r.by || {}).reduce((b, g) => b + g.reduce((c, x) => c + (x.thresholds || []).length, 0), 0), 0);
  L.push(`- A threshold clears the cost when its 95% interval of the move signed by the field lies above the cost (follow) or below minus the cost (fade). ${tests} threshold intervals are tested here, each at 95% on its own (no correction across them, nor across the decile and IC intervals): some clear by chance alone, so a lone clear result in one group is a hypothesis for held-out months, not a finding. The Spearman interval resamples the full sample's ranks (an approximation).`, '');
  L.push('## Summary', '', '| field | k | n | skipped | Pearson IC [95%] | Spearman IC [95%] | top decile [95%] | bottom decile [95%] | hit | same bar (contemporaneous, NOT predictive) |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    if (r.note) { L.push(`| ${r.field} | ${r.horizon} | ${r.n} | ${r.skipped} | ${r.note} | | | | | |`); continue; }
    L.push(`| ${r.field} | ${r.horizon} | ${r.n} | ${r.skipped} | ${fmt(r.pearson, 4)} ${ci(r.ci && r.ci.pearson)} | ${fmt(r.spearman, 4)} ${ci(r.ci && r.ci.spearman)} | ${fmt(r.deciles[9].meanMove)} ${ci(r.ci && r.ci.top)} | ${fmt(r.deciles[0].meanMove)} ${ci(r.ci && r.ci.bottom)} | ${pct(r.hit)} | ${fmt(r.sameBar.pearson, 4)} |`);
  }
  for (const r of results) {
    if (r.note) continue;
    L.push('', `## ${r.field}, ${r.horizon} bar${r.horizon > 1 ? 's' : ''} ahead`, '');
    L.push('| decile | n | field from | to | mean fwd | median fwd | hit | mean up | mean down |', '|---|---|---|---|---|---|---|---|---|');
    for (const d of r.deciles) L.push(`| ${d.decile} | ${d.n} | ${fmt(d.from, 4)} | ${fmt(d.to, 4)} | ${fmt(d.meanMove)} | ${fmt(d.medianMove)} | ${pct(d.hit)} | ${fmt(d.meanUp)} | ${fmt(d.meanDown)} |`);
    L.push('', `| abs(field) >= | n | mean fwd signed by field [95%] | hit | favourable | adverse | net of ${r.costTicks}-tick cost | clears the cost |`, '|---|---|---|---|---|---|---|---|');
    for (const x of r.thresholds) L.push(`| ${fmt(x.level, 4)}${x.quantile ? ` (p${Math.round(x.quantile * 100)})` : ''} | ${x.n} | ${fmt(x.meanSigned)} ${ci(x.ci)} | ${pct(x.hit)} | ${fmt(x.meanFavourable)} | ${fmt(x.meanAdverse)} | ${fmt(x.net)} | ${x.verdict || 'no'} |`);
    L.push('', `Clears the cost at a threshold: ${clears(r)}.`);
    for (const [b, rows] of Object.entries(r.by || {})) {
      L.push('', `By ${b === 'hour' ? 'New York hour' : 'session'}:`, '', '| group | n | Pearson IC | Spearman IC [95%] | top decile | bottom decile | hit | clears the cost |', '|---|---|---|---|---|---|---|---|');
      for (const g of rows) {
        if (g.note) { L.push(`| ${g.key} | ${g.n} | ${g.note} | | | | | |`); continue; }
        L.push(`| ${g.key} | ${g.n} | ${fmt(g.pearson, 4)} | ${fmt(g.spearman, 4)} ${ci(g.ci && g.ci.spearman)} | ${fmt(g.deciles[9].meanMove)} | ${fmt(g.deciles[0].meanMove)} | ${pct(g.hit)} | ${clears(g)} |`);
      }
    }
  }
  return `${L.join('\n')}\n`;
}

module.exports = { mean, quantile, parseFieldSpec, parseHorizons, columns, joinChunks, pairs, pearson, ranks, summarize, bootstrap, costVerdict, study, monthsBetween, splitCheck, toMarkdown, rng, FREE_ROLES };
