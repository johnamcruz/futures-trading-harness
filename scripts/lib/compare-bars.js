'use strict';

/**
 * Compare the bars two sources give for the same span: the broker's own fields on them (any dotted path),
 * as one server and another (or two builds of a replay store, or recorded live minutes and a replay of
 * them) return them. The harness gives the fields no meaning: it reads them by path (rules.js readField:
 * a number, or a boolean as 1/0; anything else is null) and reports how far apart the two sources are.
 *
 *   readBarsFile(file)                       bars from a .jsonl or .json file (as `backtest.js fetch` writes), every field kept
 *   fetchBrokerBars({ broker, contract, from, to, timeframe, root, env, withAdapter })
 *                                            the named broker's bars through the broker adapter's history()
 *   parseFields(text) / parseThresholds(text) the --fields and --fail-below values ([] / {} when empty; throws on a bad one)
 *   leafPaths(bars, { prefix })              every numeric or boolean leaf path the bars carry (OHLCV left out)
 *   align(a, b, { ohlcvTol })                bars by time (and contract, when both carry one): pairs, one-sided, price mismatches
 *   fieldStats(xs, ys, opts)                 coverage, n, differences, tolerance share, correlation, sign agreement, percentiles
 *   compareBars(a, b, opts)                  the whole report, with `failures` against opts.thresholds
 *   toMarkdown(report)                       the report as Markdown
 *   clip(bars, { from, to })                 the bars inside the span (a file source, cut to --from/--to)
 *   parseArgs(argv)                          the CLI's options (scripts/compare-bars.js); throws a UsageError
 *
 * Bars whose open, high, low, close or volume differ by more than `ohlcvTol` are listed and left out of
 * the field statistics: when the prices differ the fields describe different bars.
 */

const path = require('path');
const { readField } = require('./trading/rules');
const { readTable } = require('./backtest/data');
const { normalizeBars } = require('./trading/indicators');
const { zonedParts, MARKET_TZ } = require('./trading/clock');

const OHLCV = ['o', 'h', 'l', 'c', 'v'];
const CONTRACT_KEYS = ['contract', 'contractId', 'symbol'];
const MAX_DEPTH = 8;
const MAX_FIELDS = 2000;
const MAX_SHIFT = 500;
const THRESHOLD_KEYS = ['corr', 'within', 'sign', 'coverage', 'bars'];
const FIELD_SPEC = /^([^.[\]\s]+(?:\.[^.[\]\s]+)*)(?:\[(\d+)\])?$/;

function readBarsFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (!['.jsonl', '.ndjson', '.json'].includes(ext)) throw new Error(`${file}: a .jsonl or .json bars file (the formats that keep every field)`);
  return readTable(file);
}

async function fetchBrokerBars({ broker, contract, from, to, timeframe = '1', root, env = process.env, withAdapter = require('./broker/adapter').withAdapter }) {
  const benv = { ...env, FTH_BROKER: broker };
  const raw = await withAdapter({ root, env: benv }, a => a.history(contract, { from: new Date(from), to: new Date(to), timeframe }));
  return normalizeBars(raw);
}

function parseFields(text) {
  if (text === undefined || text === null || String(text).trim() === '') return [];
  return String(text).split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const m = FIELD_SPEC.exec(s);
    if (!m) throw new Error(`--fields: "${s}" is not a dotted path (a.b.c, optionally [n] for n bars back)`);
    const shift = Number(m[2] || 0);
    if (shift > MAX_SHIFT) throw new Error(`--fields: "${s}": look-back must be 0-${MAX_SHIFT}`);
    if (m[1].split('.').length > MAX_DEPTH) throw new Error(`--fields: "${s}": at most ${MAX_DEPTH} path segments`);
    return { path: m[1], shift, name: shift ? `${m[1]}[${shift}]` : m[1] };
  });
}

function parseThresholds(text) {
  const out = {};
  if (text === undefined || text === null || String(text).trim() === '') return out;
  for (const part of String(text).split(',').map(s => s.trim()).filter(Boolean)) {
    const m = /^([a-z]+)=(.+)$/.exec(part);
    const v = m ? Number(m[2]) : NaN;
    if (!m || !THRESHOLD_KEYS.includes(m[1]) || !Number.isFinite(v) || v < -1 || v > 1) {
      throw new Error(`--fail-below: "${part}" (keys ${THRESHOLD_KEYS.join(', ')}, each =a number from -1 to 1)`);
    }
    out[m[1]] = v;
  }
  return out;
}

/** Numeric and boolean leaves under `node`, as dotted paths (arrays by index), into `set`. */
const underPrefix = (p, prefix) => !prefix || p === prefix || p.startsWith(`${prefix}.`);
// A path that may still lead under `prefix`: inside it, or on the way to it.
const towardPrefix = (p, prefix) => underPrefix(p, prefix) || prefix.startsWith(`${p}.`);

/** Numeric and boolean leaves under `node`, as dotted paths (arrays by index), into `set`: only those under `want`. */
function leaves(node, prefix, depth, set, want) {
  if (want && !towardPrefix(prefix, want)) return;
  if (typeof node === 'number' || typeof node === 'boolean') { if (underPrefix(prefix, want)) set.add(prefix); return; }
  if (node === null || typeof node !== 'object' || depth >= MAX_DEPTH) return;
  for (const [k, v] of Object.entries(node)) {
    if (k.includes('.') || k === '') continue; // a dotted path can't name it
    leaves(v, prefix ? `${prefix}.${k}` : k, depth + 1, set, want);
  }
}

function leafPaths(bars, { prefix = null } = {}) {
  const set = new Set();
  for (const b of bars) {
    for (const [k, v] of Object.entries(b)) {
      if (OHLCV.includes(k) || k === 't' || k === 'ms' || k.includes('.') || k === '') continue;
      leaves(v, k, 1, set, prefix);
    }
    if (set.size > MAX_FIELDS) throw new Error(`the bars carry more than ${MAX_FIELDS} leaf fields${prefix ? ` under ${prefix}` : ''}: narrow them with --prefix or --fields`);
  }
  return [...set].sort();
}

const contractOf = b => {
  for (const k of CONTRACT_KEYS) if (typeof b[k] === 'string' && b[k]) return b[k];
  return null;
};

/**
 * Bars sorted by time with duplicates (same key) dropped, keeping the last: { list, byKey, seq, duplicates }.
 * `seq` holds each contract's own bars in time order (one sequence when bars align by time alone), and
 * each entry's `i` is its place there, so a look-back stays on the bar's own contract.
 */
function indexed(bars, useContract) {
  const byKey = new Map();
  let duplicates = 0;
  for (const b of bars) {
    const ms = Date.parse(b.t);
    if (!Number.isFinite(ms)) continue;
    const key = useContract ? `${contractOf(b)}|${ms}` : String(ms);
    if (byKey.has(key)) duplicates += 1;
    byKey.set(key, { bar: b, ms, key });
  }
  const list = [...byKey.values()].sort((x, y) => x.ms - y.ms || (x.key < y.key ? -1 : 1));
  const seq = new Map();
  for (const e of list) {
    e.ck = useContract ? contractOf(e.bar) : '';
    if (!seq.has(e.ck)) seq.set(e.ck, []);
    e.i = seq.get(e.ck).push(e.bar) - 1;
  }
  return { list, byKey, seq, duplicates };
}

function align(a, b, { ohlcvTol = 0 } = {}) {
  const useContract = a.length > 0 && b.length > 0 && a.every(contractOf) && b.every(contractOf);
  const A = indexed(a, useContract);
  const B = indexed(b, useContract);
  const pairs = [];
  const mismatched = [];
  const onlyA = [];
  for (const ea of A.list) {
    const eb = B.byKey.get(ea.key);
    if (!eb) { onlyA.push(ea.bar.t); continue; }
    const diffs = {};
    for (const k of OHLCV) {
      const x = Number(ea.bar[k]);
      const y = Number(eb.bar[k]);
      if (!(Math.abs(x - y) <= ohlcvTol)) diffs[k] = [ea.bar[k], eb.bar[k]];
    }
    const pair = { t: ea.bar.t, ms: ea.ms, contract: useContract ? contractOf(ea.bar) : null, ck: ea.ck, ia: ea.i, ib: eb.i };
    if (Object.keys(diffs).length) mismatched.push({ ...pair, diffs });
    else pairs.push(pair);
  }
  const onlyB = B.list.filter(e => !A.byKey.has(e.key)).map(e => e.bar.t);
  return { A: A.list.map(e => e.bar), B: B.list.map(e => e.bar), seqA: A.seq, seqB: B.seq, pairs, mismatched, onlyA, onlyB, duplicates: { a: A.duplicates, b: B.duplicates }, byContract: useContract };
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const constant = v => v.every(x => x === v[0]);

function pearson(xs, ys) {
  const n = xs.length;
  // Fewer than two values, or a constant series (tested exactly: a mean's rounding leaves sums of squares
  // that are not 0): correlation is undefined.
  if (n < 2 || constant(xs) || constant(ys)) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i += 1) { mx += xs[i]; my += ys[i]; }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (!(sxx > 0 && syy > 0)) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  return Math.max(-1, Math.min(1, Math.round(r * 1e12) / 1e12));
}

const within = (x, y, tol, rtol) => {
  const d = Math.abs(x - y);
  return d <= tol || d <= rtol * Math.max(Math.abs(x), Math.abs(y));
};

/**
 * Statistics of two value series (NaN = missing), one value per compared bar. `at[i]` names bar i in the
 * worst list. Sign agreement: of the bars where either value is non-zero, the share where both are and
 * share a sign (null when every pair is zero).
 */
function fieldStats(xs, ys, { tol = 0, rtol = 0, worst = 5, at = [] } = {}) {
  const N = xs.length;
  const px = [];
  const py = [];
  const idx = [];
  let covA = 0;
  let covB = 0;
  for (let i = 0; i < N; i += 1) {
    const okx = Number.isFinite(xs[i]);
    const oky = Number.isFinite(ys[i]);
    if (okx) covA += 1;
    if (oky) covB += 1;
    if (okx && oky) { px.push(xs[i]); py.push(ys[i]); idx.push(i); }
  }
  const n = px.length;
  let sumAbs = 0;
  let maxAbs = 0;
  let inTol = 0;
  let signDen = 0;
  let signNum = 0;
  const bad = [];
  for (let k = 0; k < n; k += 1) {
    const d = py[k] - px[k];
    sumAbs += Math.abs(d);
    maxAbs = Math.max(maxAbs, Math.abs(d));
    if (within(px[k], py[k], tol, rtol)) inTol += 1;
    else bad.push(k);
    if (px[k] !== 0 || py[k] !== 0) {
      signDen += 1;
      if (Math.sign(px[k]) === Math.sign(py[k])) signNum += 1;
    }
  }
  bad.sort((p, q) => Math.abs(py[q] - px[q]) - Math.abs(py[p] - px[p]) || p - q);
  const sx = [...px].sort((p, q) => p - q);
  const sy = [...py].sort((p, q) => p - q);
  const pcts = s => ({ p5: quantile(s, 0.05), p50: quantile(s, 0.5), p95: quantile(s, 0.95) });
  return {
    bars: N,
    coverage: { a: N ? covA / N : null, b: N ? covB / N : null },
    n,
    onlyA: covA - n,
    onlyB: covB - n,
    meanAbs: n ? sumAbs / n : null,
    maxAbs: n ? maxAbs : null,
    within: n ? inTol / n : null,
    corr: pearson(px, py),
    sign: signDen ? signNum / signDen : null,
    pct: { a: pcts(sx), b: pcts(sy) },
    worst: bad.slice(0, worst).map(k => ({ t: at[idx[k]] ?? null, a: px[k], b: py[k], diff: py[k] - px[k] })),
  };
}

/** Why a field misses the thresholds: [message]. An undefined statistic passes only where the values agree. */
function fieldFailures(s, th) {
  const out = [];
  if (th.corr !== undefined) {
    if (s.corr === null ? !(s.n >= 2 && s.within === 1) : s.corr < th.corr) out.push(`corr ${s.corr === null ? 'undefined' : fmt(s.corr)} < ${th.corr}`);
  }
  if (th.within !== undefined && !(s.n > 0 && s.within >= th.within)) out.push(`within ${fmt(s.within)} < ${th.within}`);
  if (th.sign !== undefined && !(s.n > 0 && (s.sign === null || s.sign >= th.sign))) out.push(`sign ${fmt(s.sign)} < ${th.sign}`);
  if (th.coverage !== undefined) {
    const c = s.bars ? Math.min(s.coverage.a, s.coverage.b) : null;
    if (!(c !== null && c >= th.coverage)) out.push(`coverage ${fmt(c)} < ${th.coverage}`);
  }
  return out;
}

function hourOf(ms) {
  return zonedParts(new Date(ms), MARKET_TZ).hour;
}

function compareBars(a, b, { fields = [], prefix = null, tol = 0, rtol = 0, ohlcvTol = 0, worst = 5, by = null, thresholds = {}, labels = { a: 'A', b: 'B' } } = {}) {
  const al = align(a, b, { ohlcvTol });
  const specs = fields.length
    ? fields.filter(f => underPrefix(f.path, prefix))
    : [...new Set([...leafPaths(al.A, { prefix }), ...leafPaths(al.B, { prefix })])].sort().map(p => ({ path: p, shift: 0, name: p }));
  const at = al.pairs.map(p => (p.contract ? `${p.contract} ${p.t}` : p.t));
  // Each source's own bar `shift` bars back on the same contract.
  const value = (seq, p, i, f) => (i - f.shift >= 0 ? readField(seq.get(p.ck)[i - f.shift], f.path) : NaN);
  const hourGroups = new Map();
  if (by === 'hour') {
    al.pairs.forEach((p, i) => {
      const h = hourOf(p.ms);
      if (!hourGroups.has(h)) hourGroups.set(h, []);
      hourGroups.get(h).push(i);
    });
  }
  const hours = [...hourGroups.keys()].sort((p, q) => p - q);
  const out = [];
  for (const f of specs) {
    const xs = al.pairs.map(p => value(al.seqA, p, p.ia, f));
    const ys = al.pairs.map(p => value(al.seqB, p, p.ib, f));
    const s = { field: f.name, ...fieldStats(xs, ys, { tol, rtol, worst, at }) };
    if (by === 'hour') {
      s.byHour = {};
      for (const h of hours) {
        const idx = hourGroups.get(h);
        const r = fieldStats(idx.map(i => xs[i]), idx.map(i => ys[i]), { tol, rtol, worst: 0 });
        s.byHour[h] = { bars: r.bars, n: r.n, meanAbs: r.meanAbs, within: r.within, corr: r.corr, sign: r.sign };
      }
    }
    s.failures = fieldFailures(s, thresholds);
    out.push(s);
  }
  const keys = al.pairs.length + al.mismatched.length + al.onlyA.length + al.onlyB.length;
  const matchedShare = keys ? al.pairs.length / keys : null;
  const failures = out.filter(s => s.failures.length).map(s => `${s.field}: ${s.failures.join(', ')}`);
  if (thresholds.bars !== undefined && !(matchedShare !== null && matchedShare >= thresholds.bars)) failures.unshift(`bars: ${fmt(matchedShare)} of the bars are in both with the same prices (< ${thresholds.bars})`);
  if (Object.keys(thresholds).some(k => k !== 'bars') && !out.length) failures.push('no field to compare');
  // Nothing to compare is never a pass, thresholds or not (no overlap, different contract names, empty sources).
  if (!al.pairs.length) failures.unshift('no bar is in both sources with the same prices: nothing was compared');
  return {
    labels,
    options: { tol, rtol, ohlcvTol, prefix, by, thresholds },
    bars: {
      a: al.A.length, b: al.B.length, compared: al.pairs.length, matchedShare, byContract: al.byContract,
      onlyA: al.onlyA.length, onlyB: al.onlyB.length, mismatched: al.mismatched.length, duplicates: al.duplicates,
      first: al.pairs.length ? al.pairs[0].t : null, last: al.pairs.length ? al.pairs.at(-1).t : null,
      examples: { onlyA: al.onlyA.slice(0, worst), onlyB: al.onlyB.slice(0, worst), mismatched: al.mismatched.slice(0, worst).map(m => ({ t: m.t, contract: m.contract, diffs: m.diffs })) },
    },
    fields: out,
    failures,
    pass: failures.length === 0,
  };
}

function fmt(x) {
  if (x === null || x === undefined || Number.isNaN(x)) return '-';
  if (Number.isInteger(x)) return String(x);
  return String(Number(x.toPrecision(6)));
}
// Floored (100% only when all), past float error: 0.29 is 29%, not 28.999%.
const pctFmt = x => (x === null || x === undefined ? '-' : `${fmt(Math.floor(x * 100000 + 1e-6) / 1000)}%`);
const tri = p => `${fmt(p.p5)} / ${fmt(p.p50)} / ${fmt(p.p95)}`;
const cell = s => String(s).replace(/\|/g, '\\|');

function toMarkdown(r) {
  const L = r.labels;
  const b = r.bars;
  const lines = [
    '# Bar comparison', '',
    `- A: ${cell(L.a)}`, `- B: ${cell(L.b)}`,
    `- Bars: A ${b.a}, B ${b.b}; compared ${b.compared}${b.first ? ` (${b.first} to ${b.last})` : ''}; only in A ${b.onlyA}; only in B ${b.onlyB}; prices differ ${b.mismatched} (left out); duplicates A ${b.duplicates.a}, B ${b.duplicates.b}`,
    `- Aligned by time${b.byContract ? ' and contract' : ''}; tolerance ${r.options.tol} absolute, ${r.options.rtol} relative; OHLCV tolerance ${r.options.ohlcvTol}${r.options.prefix ? `; prefix ${r.options.prefix}` : ''}`,
    `- Verdict: ${r.pass ? 'pass' : 'FAIL'}${Object.keys(r.options.thresholds).length ? ` (fail below ${Object.entries(r.options.thresholds).map(([k, v]) => `${k}=${v}`).join(', ')})` : ' (no thresholds set)'}`,
    '',
  ];
  if (b.examples.onlyA.length) lines.push(`Only in A (first ${b.examples.onlyA.length}): ${b.examples.onlyA.join(', ')}`, '');
  if (b.examples.onlyB.length) lines.push(`Only in B (first ${b.examples.onlyB.length}): ${b.examples.onlyB.join(', ')}`, '');
  if (b.examples.mismatched.length) {
    lines.push('Prices differ (first few):', '');
    for (const m of b.examples.mismatched) lines.push(`- ${m.contract ? `${m.contract} ` : ''}${m.t}: ${Object.entries(m.diffs).map(([k, [x, y]]) => `${k} ${x} vs ${y}`).join(', ')}`);
    lines.push('');
  }
  lines.push('## Fields', '');
  if (!r.fields.length) lines.push('No numeric or boolean field to compare.', '');
  else {
    lines.push('| field | coverage A | coverage B | n | mean abs diff | max abs diff | within tol | corr | sign agree | A p5 / p50 / p95 | B p5 / p50 / p95 |', '|---|---|---|---|---|---|---|---|---|---|---|');
    for (const s of r.fields) {
      lines.push(`| \`${cell(s.field)}\` | ${pctFmt(s.coverage.a)} | ${pctFmt(s.coverage.b)} | ${s.n} | ${fmt(s.meanAbs)} | ${fmt(s.maxAbs)} | ${pctFmt(s.within)} | ${fmt(s.corr)} | ${pctFmt(s.sign)} | ${tri(s.pct.a)} | ${tri(s.pct.b)} |`);
    }
    lines.push('');
  }
  if (r.failures.length) lines.push('## Below thresholds', '', ...r.failures.map(f => `- ${cell(f)}`), '');
  const worst = r.fields.filter(s => s.worst.length);
  if (worst.length) {
    lines.push('## Worst bars', '');
    for (const s of worst) {
      lines.push(`### \`${cell(s.field)}\``, '', '| bar | A | B | B - A |', '|---|---|---|---|');
      for (const w of s.worst) lines.push(`| ${w.t} | ${fmt(w.a)} | ${fmt(w.b)} | ${fmt(w.diff)} |`);
      lines.push('');
    }
  }
  const hourly = r.fields.filter(s => s.byHour);
  if (hourly.length) {
    lines.push('## By hour (ET, bar open)', '');
    for (const s of hourly) {
      lines.push(`### \`${cell(s.field)}\``, '', '| hour | n | mean abs diff | within tol | corr | sign agree |', '|---|---|---|---|---|---|');
      for (const [h, x] of Object.entries(s.byHour)) lines.push(`| ${String(h).padStart(2, '0')} | ${x.n} | ${fmt(x.meanAbs)} | ${pctFmt(x.within)} | ${fmt(x.corr)} | ${pctFmt(x.sign)} |`);
      lines.push('');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** The bars inside [from, to] (either may be missing), as a broker source's history() keeps them. */
function clip(bars, { from, to } = {}) {
  const lo = from ? Date.parse(from) : -Infinity;
  const hi = to ? Date.parse(to) : Infinity;
  return bars.filter(b => { const ms = Date.parse(b.t); return ms >= lo && ms <= hi; });
}

class UsageError extends Error {}

const VALUE_FLAGS = ['--a', '--b', '--contract', '--from', '--to', '--timeframe', '--fields', '--prefix', '--tol', '--rtol', '--ohlcv-tol', '--by', '--worst', '--fail-below', '--out'];

/** A source: `broker:<name>` (fetched through the adapter) or a bars file. */
function parseSource(text, flag) {
  const m = /^broker:(.*)$/.exec(text);
  if (!m) return { kind: 'file', file: text, label: text };
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(m[1])) throw new UsageError(`${flag}: broker:<name>, a broker named in brokers.json`);
  return { kind: 'broker', broker: m[1] };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const f = argv[i];
    if (!VALUE_FLAGS.includes(f)) throw new UsageError(`unknown argument: ${f} (flags: ${VALUE_FLAGS.join(' ')})`);
    if (i + 1 >= argv.length || String(argv[i + 1]).startsWith('--')) throw new UsageError(`${f} needs a value`);
    o[f] = argv[(i += 1)];
  }
  if (!o['--a'] || !o['--b']) throw new UsageError('--a and --b: two bar sources, each a .jsonl/.json file or broker:<name>');
  const num = (flag, def, ok) => {
    if (o[flag] === undefined) return def;
    const v = Number(o[flag]);
    if (!ok(v)) throw new UsageError(`${flag}: ${o[flag]} is out of range`);
    return v;
  };
  const sources = { a: parseSource(o['--a'], '--a'), b: parseSource(o['--b'], '--b') };
  const span = { contract: o['--contract'], from: o['--from'], to: o['--to'], timeframe: o['--timeframe'] || '1' };
  for (const f of ['--from', '--to']) if (o[f] !== undefined && !Number.isFinite(Date.parse(o[f]))) throw new UsageError(`${f}: an ISO time`);
  if (Object.values(sources).some(s => s.kind === 'broker')) {
    if (!span.contract || !Number.isFinite(Date.parse(span.from || '')) || !Number.isFinite(Date.parse(span.to || ''))) {
      throw new UsageError('a broker source needs --contract <name> --from <ISO> --to <ISO> [--timeframe 1]');
    }
    for (const s of Object.values(sources)) if (s.kind === 'broker') s.label = `broker ${s.broker}: ${span.contract} ${span.timeframe} from ${span.from} to ${span.to}`;
  }
  if (o['--by'] !== undefined && o['--by'] !== 'hour') throw new UsageError('--by: hour (the only breakdown)');
  if (o['--out'] !== undefined && !o['--out'].endsWith('.json')) throw new UsageError('--out: a .json file (the Markdown goes next to it, as .md)');
  let fields;
  let thresholds;
  try {
    fields = parseFields(o['--fields']);
    thresholds = parseThresholds(o['--fail-below']);
  } catch (err) {
    throw new UsageError(err.message);
  }
  return {
    sources,
    span,
    out: o['--out'] || null,
    compare: {
      fields,
      thresholds,
      prefix: o['--prefix'] || null,
      by: o['--by'] || null,
      tol: num('--tol', 0, v => Number.isFinite(v) && v >= 0),
      rtol: num('--rtol', 0, v => Number.isFinite(v) && v >= 0),
      ohlcvTol: num('--ohlcv-tol', 0, v => Number.isFinite(v) && v >= 0),
      worst: num('--worst', 5, v => Number.isInteger(v) && v >= 0 && v <= 1000),
      labels: { a: sources.a.label, b: sources.b.label },
    },
  };
}

module.exports = { UsageError, parseArgs, clip, OHLCV, THRESHOLD_KEYS, readBarsFile, fetchBrokerBars, parseFields, parseThresholds, leafPaths, align, fieldStats, fieldFailures, compareBars, toMarkdown, pearson, quantile };
