'use strict';

/**
 * The field-confluence study: GIVEN an event with a direction (a wide-range bar, a breakout, a strategy's
 * trigger), does it follow through better when a bar field at the event bar AGREES with that direction
 * than when it disagrees or is neutral? A field need not predict on its own to confirm a move. Generic,
 * as the field-forward study (lib/field-study.js) is: fields are dotted paths on the broker's bars, events
 * are defined from prices or from a strategy's own rules, and the harness computes no field of its own.
 * docs/BACKTESTING.md ("The field-confluence study") says what it is for.
 *
 * - Events, each on bars up to t only:
 *   `expansion:<k>`: bar t's range (high - low) is at least k x ATR(14) of the bars before t (Wilder,
 *     within t's run of one chunk, contract and trading day); its direction is the sign of close - open.
 *   `breakout:<n>`: close[t] above the high of bars t-n..t-1 (long) or below their low (short), all in
 *     t's run.
 *   `strategy:<name>` (or `strategy:all`, every valid rules strategy on the bars' timeframe): the bars
 *     where its rules fire (rules.evaluateRules over series computed causally, as the evaluator runs
 *     them) inside its sessions, with its direction; none in a chunk's first WARMUP bars (cold series). Its conditions that read the field under test are
 *     removed (and listed), so a strategy never confirms itself; any other field it reads is reported.
 * - Classes, at each threshold: agree (the field's sign is the event's and |field| >= threshold),
 *   disagree (the opposite sign, |field| >= threshold), neutral (anything else). Thresholds are given, or
 *   the p60 and p80 of |field| over every bar of the span.
 * - Outcomes at horizon k, signed by the event's direction: the move close[t+k] - close[t] in ticks, the
 *   follow-through rate (move > 0), the largest favourable and adverse excursions over t+1..t+k, and
 *   which of +1R and -1R is touched first (R: bar t's range, or the prior ATR; both in one bar is a tie).
 *   Pairs crossing a break (lib/field-study.js joinChunks: chunk, contract, trading day, gap) are skipped.
 * - Per class: those numbers with 95% day-block bootstrap intervals, and agree - disagree and agree -
 *   neutral, by RTH / overnight and by New York hour on request, and the cost line.
 */

const fsy = require('./field-study');
const { evaluateRules, seriesSource } = require('./trading/rules');
const { PARAMS } = require('./trading/market-snapshot');
const { inSessions, timeframeMs, DEFAULT_WINDOW } = require('./trading/evaluator');

const { ATR_PERIOD } = require('./trading/indicators'); // the reads' ATR, one home
const DEFAULT_LEVELS = Object.freeze([0.6, 0.8]);
// A class needs this many events over this many trading days for intervals, differences and a cost verdict:
// a handful of events in a day or two gives a degenerate interval, never evidence.
const MIN_EVENTS = 30;
const MIN_DAYS = 10;
// A strategy's series start cold at each chunk's first bar (an average seeded there, a high with too few
// bars); the live scan has history. Its first WARMUP bars in a chunk (the evaluator's window) fire nothing.
const WARMUP = DEFAULT_WINDOW;
const CLASSES = Object.freeze(['agree', 'disagree', 'neutral']);
const EVENT = /^(?:expansion:(\d+(?:\.\d+)?)|breakout:(\d+)|strategy:([a-z0-9][a-z0-9_-]*))$/;

/** 'expansion:1.5,breakout:20,strategy:orb' -> [{ spec, kind, k | n | name }]. */
function parseEvents(text) {
  const out = String(text || '').split(',').map(s => s.trim()).filter(Boolean).map(spec => {
    const m = EVENT.exec(spec);
    if (!m) throw new Error(`--event "${spec}": expansion:<k>, breakout:<n> or strategy:<name|all>`);
    if (m[1] !== undefined) {
      const k = Number(m[1]);
      if (!(k > 0 && k <= 20)) throw new Error(`--event ${spec}: k above 0, at most 20`);
      return { spec, kind: 'expansion', k };
    }
    if (m[2] !== undefined) {
      const n = Number(m[2]);
      if (!(n >= 1 && n <= 500)) throw new Error(`--event ${spec}: n from 1 to 500 bars`);
      return { spec, kind: 'breakout', n };
    }
    return { spec, kind: 'strategy', name: m[3] };
  });
  if (!out.length) throw new Error('--event: one or more events, e.g. expansion:1.5,breakout:20,strategy:orb');
  return [...new Map(out.map(e => [e.spec, e])).values()];
}

/** ATR(14), Wilder, of the bars before t inside t's run (t.runStart): NaN until the run has 14 earlier bars. */
function priorAtr(t, period = ATR_PERIOD) {
  const out = new Float64Array(t.n).fill(NaN);
  let atr = NaN; let count = 0; let sum = 0;
  for (let i = 0; i < t.n; i += 1) {
    if (t.runStart[i] === i) { atr = NaN; count = 0; sum = 0; }
    out[i] = atr;
    const tr = i > t.runStart[i] ? Math.max(t.h[i] - t.l[i], Math.abs(t.h[i] - t.c[i - 1]), Math.abs(t.l[i] - t.c[i - 1])) : t.h[i] - t.l[i];
    count += 1;
    if (count < period) sum += tr;
    else if (count === period) atr = (sum + tr) / period;
    else atr = (atr * (period - 1) + tr) / period;
  }
  return out;
}

/** A price event's direction per bar (1 long, -1 short, 0 none), from bars up to t only. */
function priceEvents(t, ev, atr = priorAtr(t)) {
  const dir = new Int8Array(t.n);
  for (let i = 0; i < t.n; i += 1) {
    if (ev.kind === 'expansion') {
      if (atr[i] > 0 && t.h[i] - t.l[i] >= ev.k * atr[i]) dir[i] = Math.sign(t.c[i] - t.o[i]);
    } else if (ev.kind === 'breakout') {
      if (i - t.runStart[i] < ev.n) continue;
      let hi = -Infinity; let lo = Infinity;
      for (let j = i - ev.n; j < i; j += 1) { if (t.h[j] > hi) hi = t.h[j]; if (t.l[j] < lo) lo = t.l[j]; }
      dir[i] = t.c[i] > hi ? 1 : t.c[i] < lo ? -1 : 0;
    } else {
      throw new Error(`${ev.spec}: not a price event`);
    }
  }
  return dir;
}

const fieldKeys = c => (c.group ? c.items.flatMap(fieldKeys) : [...c.left, ...c.right].flatMap(x => x.factors).filter(f => f.kind === 'series' && f.key.startsWith('field:')).map(f => f.key.slice(6)));

/**
 * A strategy's compiled rules without the conditions that read `path`: { compiled, excluded (their text),
 * reads (the other field paths it still reads) }. A group keeps its other items; a group left empty goes.
 */
function withoutField(compiled, path) {
  const excluded = [];
  const strip = c => {
    if (!c.group) {
      if (fieldKeys(c).includes(path)) { excluded.push(c.text); return null; }
      return c;
    }
    const items = c.items.map(strip).filter(Boolean);
    if (!items.length) return null;
    return items.length === c.items.length ? c : { ...c, items, text: `${c.group}(${items.map(x => x.text).join(c.group === 'any' ? ' | ' : ' & ')})` };
  };
  const out = { long: compiled.long.map(strip).filter(Boolean), short: compiled.short.map(strip).filter(Boolean) };
  for (const side of ['long', 'short']) if (compiled[side].length && !out[side].length) excluded.push(`(the ${side} side has no condition left: it never fires)`);
  const reads = [...new Set([...out.long, ...out.short].flatMap(fieldKeys))].sort();
  return { compiled: out, excluded, reads };
}

/** The strategies a strategy event names, checked against the bars' timeframe (minutes). */
function strategiesFor(ev, strategies, timeframeMin) {
  const tf = `${timeframeMin}m`;
  const rules = strategies.filter(s => s.valid && s.signal === 'rules' && s.status !== 'disabled' && s.compiledRules);
  if (ev.name === 'all') {
    const all = rules.filter(s => timeframeMs(s.timeframe) === timeframeMin * 60000);
    if (!all.length) throw new Error(`${ev.spec}: no rules strategy trades ${tf} bars`);
    return all;
  }
  const s = strategies.find(x => x.name === ev.name);
  if (!s) throw new Error(`${ev.spec}: no strategy named ${ev.name}`);
  if (s.status === 'disabled') throw new Error(`${ev.spec}: ${s.name} is disabled`);
  if (!rules.includes(s)) throw new Error(`${ev.spec}: not a valid rules strategy`);
  if (timeframeMs(s.timeframe) !== timeframeMin * 60000) throw new Error(`${ev.spec}: ${s.name} trades ${s.timeframe} bars, these are ${tf} (fetch bars on its timeframe)`);
  return [s];
}

/**
 * One chunk's strategy events: per strategy and field, the direction per bar, from the rules evaluated on
 * this chunk's bars 0..i only (seriesSource is causal), inside the strategy's sessions (checked at the
 * bar's close). Rule variants shared by several fields are evaluated once.
 * Returns [{ spec, name, perField: [{ excluded, reads, dir }] }].
 */
function chunkStrategyEvents(bars, events, { strategies, fields, timeframeMin }) {
  const out = [];
  for (const ev of events.filter(e => e.kind === 'strategy')) {
    for (const s of strategiesFor(ev, strategies, timeframeMin)) {
      const params = { ...PARAMS, ...(s.params || {}) };
      const get = seriesSource(bars, params);
      const step = timeframeMs(s.timeframe);
      const open = bars.map(b => inSessions(s, new Date(Date.parse(b.t) + step)));
      const memo = new Map();
      const perField = fields.map(f => {
        const v = withoutField(s.compiledRules, f.path);
        const key = v.excluded.join('\n');
        if (!memo.has(key)) {
          const dir = new Int8Array(bars.length);
          for (let i = WARMUP; i < bars.length; i += 1) {
            if (!open[i]) continue;
            const r = evaluateRules(v.compiled, bars, params, { index: i, get });
            dir[i] = r.direction === 'long' ? 1 : r.direction === 'short' ? -1 : 0;
          }
          memo.set(key, dir);
        }
        return { excluded: v.excluded, reads: v.reads, dir: memo.get(key) };
      });
      out.push({ spec: `strategy:${s.name}`, name: s.name, perField, warmup: Math.min(WARMUP, bars.length), cold: bars.length <= WARMUP ? 1 : 0 });
    }
  }
  return out;
}

/** The chunks' strategy events joined in chunk order (as joinChunks joins the bars); every chunk must name the same strategies. */
function joinStrategyEvents(perChunk, n) {
  if (!perChunk.length) return [];
  const names = perChunk.map(c => c.map(e => e.spec).join(','));
  if (names.some(x => x !== names[0])) throw new Error('the bar files resolve to different strategies (mixed timeframes?)');
  return perChunk[0].map((e, j) => ({
    spec: e.spec, kind: 'strategy', name: e.name,
    warmupBars: perChunk.reduce((a, c) => a + c[j].warmup, 0), coldFiles: perChunk.reduce((a, c) => a + c[j].cold, 0),
    perField: e.perField.map((pf, q) => {
      const dir = new Int8Array(n);
      let at = 0;
      for (const c of perChunk) { dir.set(c[j].perField[q].dir, at); at += c[j].perField[q].dir.length; }
      if (at !== n) throw new Error('strategy events and bars differ in length');
      return { excluded: pf.excluded, reads: pf.reads, dir };
    }),
  }));
}

/**
 * The events in `dir` with field q (from bar t - shift, same unbroken run) and their outcomes at horizon k,
 * signed by the event's direction. first: 1 (+1R first), -1 (-1R first), 0 (neither), 2 (both in one bar),
 * NaN (no R). Counts: events, skipped (t+k past a break), tail (past the data's end), missing (no field).
 */
function eventPairs(t, dir, q, shift, k, { tick, rMode = 'bar', atr }) {
  const cap = t.n;
  const E = { x: new Float64Array(cap), d: new Int8Array(cap), fwd: new Float64Array(cap), mfe: new Float64Array(cap), mae: new Float64Array(cap), first: new Float64Array(cap), at: new Int32Array(cap), day: new Int32Array(cap), hour: new Int8Array(cap), rth: new Uint8Array(cap), n: 0, events: 0, skipped: 0, tail: 0, missing: 0 };
  for (let i = 0; i < t.n; i += 1) {
    const d = dir[i];
    if (!d) continue;
    E.events += 1;
    const end = t.segEnd[i];
    if (i + k >= end) { if (end === t.n) E.tail += 1; else E.skipped += 1; continue; }
    const src = i - shift;
    const x = src >= 0 && t.segEnd[src] === end ? t.f[q][src] : NaN;
    if (!Number.isFinite(x)) { E.missing += 1; continue; }
    const c0 = t.c[i];
    const R = rMode === 'atr' ? atr[i] : t.h[i] - t.l[i];
    let mfe = 0; let mae = 0; let first = R > 0 ? 0 : NaN;
    for (let j = i + 1; j <= i + k; j += 1) {
      const fav = d > 0 ? t.h[j] - c0 : c0 - t.l[j];
      const adv = d > 0 ? c0 - t.l[j] : t.h[j] - c0;
      if (fav > mfe) mfe = fav;
      if (adv > mae) mae = adv;
      if (first === 0) first = fav >= R && adv >= R ? 2 : fav >= R ? 1 : adv >= R ? -1 : 0;
    }
    const m = E.n;
    E.x[m] = x; E.d[m] = d; E.fwd[m] = (d * (t.c[i + k] - c0)) / tick; E.mfe[m] = mfe / tick; E.mae[m] = mae / tick; E.first[m] = first;
    E.at[m] = i; E.day[m] = t.day[i]; E.hour[m] = t.hour[i]; E.rth[m] = t.rth[i];
    E.n += 1;
  }
  return E;
}

/** 0 agree, 1 disagree, 2 neutral: the field against the event's direction at |field| >= thr. */
function classOf(x, d, thr) {
  if (x !== 0 && Math.abs(x) >= thr) return Math.sign(x) === d ? 0 : 1;
  return 2;
}

const W = 6; // per class and day: n, sum fwd, follow-throughs, pairs with R, +1R first, -1R first

/** Per-day sums per class, for the statistics and the bootstrap. */
function daySums(E, idx, thr) {
  const days = new Map();
  for (const i of idx) {
    let a = days.get(E.day[i]);
    if (!a) { a = new Float64Array(3 * W); days.set(E.day[i], a); }
    const o = W * classOf(E.x[i], E.d[i], thr);
    a[o] += 1; a[o + 1] += E.fwd[i]; a[o + 2] += E.fwd[i] > 0 ? 1 : 0;
    if (Number.isFinite(E.first[i])) { a[o + 3] += 1; a[o + 4] += E.first[i] === 1 ? 1 : 0; a[o + 5] += E.first[i] === -1 ? 1 : 0; }
  }
  return [...days.values()];
}

/** The statistics read from summed day blocks: per class mean move, follow-through, +1R first; and the differences. */
function readSums(s) {
  const per = CLASSES.map((_, c) => {
    const o = W * c;
    return { mean: s[o] ? s[o + 1] / s[o] : NaN, follow: s[o] ? s[o + 2] / s[o] : NaN, plusFirst: s[o + 3] ? s[o + 4] / s[o + 3] : NaN };
  });
  const diff = (a, b, key) => per[a][key] - per[b][key];
  return [
    ...per.flatMap(p => [p.mean, p.follow, p.plusFirst]),
    diff(0, 1, 'mean'), diff(0, 2, 'mean'), diff(0, 1, 'follow'), diff(0, 2, 'follow'), diff(0, 1, 'plusFirst'), diff(0, 2, 'plusFirst'),
  ];
}
const STAT_KEYS = [...CLASSES.flatMap(c => [`${c}.mean`, `${c}.follow`, `${c}.plusFirst`]), 'agreeMinusDisagree.mean', 'agreeMinusNeutral.mean', 'agreeMinusDisagree.follow', 'agreeMinusNeutral.follow', 'agreeMinusDisagree.plusFirst', 'agreeMinusNeutral.plusFirst'];

/** 95% intervals of every statistic in readSums, resampling days with replacement (seeded). */
function bootDays(blocks, { reps = 1000, seed = 1 } = {}) {
  if (blocks.length < 2) return null;
  const draw = fsy.rng(seed);
  const s = new Float64Array(3 * W);
  const draws = STAT_KEYS.map(() => []);
  for (let r = 0; r < reps; r += 1) {
    s.fill(0);
    for (let b = 0; b < blocks.length; b += 1) {
      const a = blocks[Math.floor(draw() * blocks.length)];
      for (let q = 0; q < s.length; q += 1) s[q] += a[q];
    }
    readSums(s).forEach((v, j) => { if (Number.isFinite(v)) draws[j].push(v); });
  }
  const ci = v => (v.length >= reps / 2 ? (f => [fsy.quantile(f, 0.025), fsy.quantile(f, 0.975)])(Float64Array.from(v).sort()) : null);
  return Object.fromEntries(STAT_KEYS.map((k, j) => [k, ci(draws[j])]));
}

const excludesZero = c => Boolean(c) && (c[0] > 0 || c[1] < 0);

/**
 * The classes of events `idx` (all when null) at threshold thr: per class n, mean move, follow-through,
 * mean excursions, +1R / -1R first; the differences; intervals; the cost line (a class clears it when its
 * mean move's interval lies wholly above the cost).
 */
function summarizeClasses(E, thr, { idx = null, costTicks = 2, boot = null } = {}) {
  const ids = idx || Array.from({ length: E.n }, (_, i) => i);
  const classes = CLASSES.map(name => ({ name, n: 0, mean: null, follow: null, mfe: null, mae: null, plusFirst: null, minusFirst: null, tie: null }));
  const acc = CLASSES.map(() => ({ fwd: 0, fol: 0, mfe: 0, mae: 0, r: 0, p: 0, m: 0, tie: 0, days: new Set() }));
  for (const i of ids) {
    const c = classOf(E.x[i], E.d[i], thr);
    const a = acc[c];
    a.days.add(E.day[i]);
    classes[c].n += 1;
    a.fwd += E.fwd[i]; a.fol += E.fwd[i] > 0 ? 1 : 0; a.mfe += E.mfe[i]; a.mae += E.mae[i];
    if (Number.isFinite(E.first[i])) { a.r += 1; a.p += E.first[i] === 1; a.m += E.first[i] === -1; a.tie += E.first[i] === 2; }
  }
  classes.forEach((k, c) => {
    const a = acc[c];
    k.days = a.days.size;
    k.tested = k.n >= MIN_EVENTS && k.days >= MIN_DAYS;
    if (k.n) Object.assign(k, { mean: a.fwd / k.n, follow: a.fol / k.n, mfe: a.mfe / k.n, mae: a.mae / k.n });
    if (a.r) Object.assign(k, { plusFirst: a.p / a.r, minusFirst: a.m / a.r, tie: a.tie / a.r });
  });
  const d = (x, y, key) => (classes[x][key] === null || classes[y][key] === null ? null : classes[x][key] - classes[y][key]);
  const res = {
    n: ids.length, threshold: thr, costTicks, classes,
    diff: { agreeMinusDisagree: { mean: d(0, 1, 'mean'), follow: d(0, 1, 'follow'), plusFirst: d(0, 1, 'plusFirst') }, agreeMinusNeutral: { mean: d(0, 2, 'mean'), follow: d(0, 2, 'follow'), plusFirst: d(0, 2, 'plusFirst') } },
    ci: null,
  };
  if (boot) {
    const b = bootDays(daySums(E, ids, thr), boot);
    if (b) {
      res.ci = b;
      res.days = new Set(ids.map(i => E.day[i])).size;
      // Too few events or days in a class: no interval, no difference interval, no cost verdict for it.
      const ok = name => classes.find(k => k.name === name).tested;
      classes.forEach(k => { k.ciMean = k.tested ? b[`${k.name}.mean`] : null; k.ciFollow = k.tested ? b[`${k.name}.follow`] : null; k.clearsCost = Boolean(k.ciMean) && k.ciMean[0] > costTicks; });
      for (const [key, v] of Object.entries(res.diff)) {
        const other = key === 'agreeMinusDisagree' ? 'disagree' : 'neutral';
        for (const stat of Object.keys(v)) v[`${stat}Ci`] = ok('agree') && ok(other) ? b[`${key}.${stat}`] : null;
      }
      // Only when the others were tested and failed: a class too small to test is no evidence that it fails.
      res.agreeOnlyClears = classes[0].clearsCost && classes[1].tested && classes[2].tested ? !classes[1].clearsCost && !classes[2].clearsCost : classes[0].clearsCost ? null : false;
    }
  }
  return res;
}

/** Group keys of events: by session (RTH / overnight) or New York hour. */
function groupsOf(E, by) {
  const out = new Map();
  for (let i = 0; i < E.n; i += 1) {
    const key = by === 'hour' ? String(E.hour[i]).padStart(2, '0') : E.rth[i] ? 'rth' : 'overnight';
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(i);
  }
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

/** The p-levels of |field q| over every bar of the table with a value. */
function fieldLevels(t, q, levels) {
  const abs = Float64Array.from(t.f[q].filter(Number.isFinite), Math.abs).sort();
  return levels.map(p => ({ level: fsy.quantile(abs, p), quantile: p }));
}

/**
 * The study. events: parsed price events and joined strategy events (joinStrategyEvents). For every event,
 * field, horizon and threshold: the classes overall and by each `by` group, with intervals.
 */
function confluence(t, { fields, events, horizons, tick, thresholds = null, costTicks = 2, by = [], rMode = 'bar', reps = 1000, seed = 1 }) {
  if (!(tick > 0)) throw new Error('tick: the contract\'s tick size');
  if (!['bar', 'atr'].includes(rMode)) throw new Error('R: bar (the event bar\'s range) or atr');
  const atr = priorAtr(t);
  const priceDirs = new Map();
  const results = [];
  for (const ev of events) {
    fields.forEach((f, q) => {
      let dir; let meta = {};
      if (ev.kind === 'strategy') {
        const pf = ev.perField[q];
        dir = pf.dir;
        meta = { excluded: pf.excluded, reads: pf.reads, warmupBars: ev.warmupBars, coldFiles: ev.coldFiles };
      } else {
        if (!priceDirs.has(ev.spec)) priceDirs.set(ev.spec, priceEvents(t, ev, atr));
        dir = priceDirs.get(ev.spec);
      }
      const levels = thresholds ? thresholds.map(level => ({ level, quantile: null })) : fieldLevels(t, q, DEFAULT_LEVELS);
      for (const k of horizons) {
        const E = eventPairs(t, dir, q, f.shift, k, { tick, rMode, atr });
        for (const lv of levels) {
          const boot = { reps, seed };
          const row = { event: ev.spec, field: f.spec, horizon: k, level: lv.level, quantile: lv.quantile, ...meta, events: E.events, skipped: E.skipped, tail: E.tail, missing: E.missing, ...summarizeClasses(E, lv.level, { costTicks, boot }) };
          row.by = {};
          for (const b of by) row.by[b] = groupsOf(E, b).map(([key, idx]) => ({ key, ...summarizeClasses(E, lv.level, { idx, costTicks, boot }) }));
          results.push(row);
        }
      }
    });
  }
  return results;
}

const fmt = (v, dp = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '-' : Number(v).toFixed(dp));
const pct = v => (v === null || v === undefined || !Number.isFinite(v) ? '-' : `${(v * 100).toFixed(1)}%`);
const ci = (c, f = fmt) => (c ? `[${f(c[0])}, ${f(c[1])}]` : '-');
const mark = c => (excludesZero(c) ? ' *' : '');
const lvl = r => `${fmt(r.level, 4)}${r.quantile ? ` (p${Math.round(r.quantile * 100)})` : ''}`;
const triple = (r, key, f) => r.classes.map(k => `${f(k[key])}${key === 'n' && !k.tested ? ' (few)' : ''}`).join(' / ');
const clearsLine = r => (r.ci ? (r.classes.filter(k => k.clearsCost).map(k => k.name).join(', ') || 'none') + (r.agreeOnlyClears ? ' (agree only)' : r.agreeOnlyClears === null && !r.classes[1].clearsCost && !r.classes[2].clearsCost ? ' (the others too few to test)' : '') : 'not tested');

function row(label, r) {
  const ad = r.diff.agreeMinusDisagree; const an = r.diff.agreeMinusNeutral;
  return `| ${label} | ${triple(r, 'n', v => v)} | ${triple(r, 'follow', pct)} | ${triple(r, 'mean', fmt)} | ${fmt(ad.mean)} ${ci(ad.meanCi)}${mark(ad.meanCi)} | ${fmt(an.mean)} ${ci(an.meanCi)}${mark(an.meanCi)} | ${pct(ad.follow)} ${ci(ad.followCi, pct)}${mark(ad.followCi)} | ${triple(r, 'plusFirst', pct)} | ${triple(r, 'mfe', fmt)} | ${triple(r, 'mae', fmt)} | ${clearsLine(r)} |`;
}

/** The report as Markdown. `header` as the field-forward study's, plus { events, rMode }. */
function toMarkdown(header, results) {
  const L = ['# Field-confluence study', ''];
  L.push(`- Span: ${header.span.from} to ${header.span.to} (${header.bars} bars, ${header.segments} unbroken runs)`);
  L.push(`- Bar source: ${header.source}; timeframe ${header.timeframeMin} min; tick ${header.tick}; round-trip cost ${header.costTicks} ticks; R = ${header.rMode === 'atr' ? 'the prior ATR(14)' : 'the event bar\'s range'}`);
  L.push(`- Months and split roles: ${header.months.map(m => `${m.month} ${m.role}${m.part ? ` (${m.part})` : ''}`).join(', ')}`);
  if (header.warning) L.push(`- ${header.warning}`);
  L.push('- Events on bars up to t only; outcomes after t, signed by the event\'s direction, in ticks. Classes: agree (field has the event\'s sign, |field| >= threshold), disagree (the other sign, past the threshold), neutral. Cells read agree / disagree / neutral. Follow: the move after k bars is > 0. +1R first: share touching +1R before -1R. Intervals: 95% block bootstrap, one trading day a block; * marks an interval that excludes zero.');
  const has = r => Boolean(r.ci && (r.diff.agreeMinusDisagree.meanCi || r.diff.agreeMinusNeutral.meanCi));
  const tests = results.reduce((a, r) => a + (has(r) ? 1 : 0) + Object.values(r.by || {}).reduce((b, g) => b + g.filter(has).length, 0), 0);
  L.push(`- ${tests} class comparisons are tested here, each at 95% on its own (no correction across them): some exclude zero by chance alone, so a lone result is a hypothesis for held-out months, not a finding. A class clears the cost when its mean move's interval lies wholly above the cost. A class with fewer than ${MIN_EVENTS} events or ${MIN_DAYS} trading days (marked few) gets no interval, no difference interval and no cost verdict.`, '');
  const strat = results.find(r => r.event.startsWith('strategy:'));
  if (strat) {
    L.push(`- strategy: events are each strategy's rules firing inside its sessions, on bars ${WARMUP} and on of each file (warm-up: ${strat.warmupBars} bars skipped in all); the regime, trend-rule and filter checks are not applied.`);
    if (strat.coldFiles) L.push(`- WARNING: ${strat.coldFiles} file(s) hold no more than ${WARMUP} bars, so no strategy event comes from them: give longer files (a month a file) for strategy events.`);
  }
  const seen = new Set();
  for (const r of results) {
    const key = `${r.event} ${r.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.excluded && r.excluded.length) L.push(`- ${r.event} with ${r.field}: its conditions reading the field are removed: ${r.excluded.join('; ')}`);
    if (r.reads && r.reads.length) L.push(`- ${r.event} with ${r.field}: it still reads ${r.reads.join(', ')}`);
  }
  const head = ['| event | field | k | abs(field) >= | n | follow | mean move | agree - disagree [95%] | agree - neutral [95%] | follow, agree - disagree [95%] | +1R first | MFE | MAE | clears the cost |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  L.push('', '## All events', '', ...head);
  for (const r of results) L.push(row(`${r.event} | ${r.field} | ${r.horizon} | ${lvl(r)}`, r));
  const groups = [...new Set(results.flatMap(r => Object.keys(r.by || {})))];
  for (const b of groups) {
    L.push('', `## By ${b === 'hour' ? 'New York hour' : 'session'}`, '', head[0].replace('| event |', '| event | group |'), `${head[1]}---|`);
    for (const r of results) for (const g of r.by[b] || []) L.push(row(`${r.event} | ${g.key} | ${r.field} | ${r.horizon} | ${lvl(r)}`, g));
  }
  return `${L.join('\n')}\n`;
}

module.exports = { MIN_EVENTS, MIN_DAYS, WARMUP, parseEvents, priorAtr, priceEvents, withoutField, strategiesFor, chunkStrategyEvents, joinStrategyEvents, eventPairs, classOf, summarizeClasses, confluence, toMarkdown, excludesZero, CLASSES };
