'use strict';

/**
 * The history library (the owner's "code to scan and teach it"): code scans practice-train history for the setup
 * moments the practice mode finds (setup-moments.js: the setup timeframe's completed candle reacting at a fixed key
 * level or a fair value gap's edge) and measures ONE fixed standard trade at each, the owner's way. Never the model's
 * decisions, never a learning result, never advice: experience_lookup shows its index in a section of its own,
 * "history library: code-measured, not your decisions", next to the model's own record.
 *
 * Per reaction moment (scanLibrary), on the bar briefings the runner builds (briefing.js, bar by bar, causal):
 *   confirmation   the first entry-timeframe close in the reaction's window (the closes AFTER the reaction bar, while
 *                  its candle is still the last completed one: an entry read is on a candle closed after the setup
 *                  candle, the gate's same-candle rule) whose candle confirms the reaction's side, in this order: an
 *                  entry pattern (hammer or bullish engulfing long, shooting star or bearish engulfing short), momentum
 *                  that way, a close in the far third, and that composes; a confirming close that doesn't compose
 *                  leaves the next one to try. A close in a no-entry window (briefing.js sessionWindow, the gate's
 *                  entry clock) is skipped (`no-entry-window` when nothing else was tried). None: `no-confirmation`;
 *                  otherwise the last close tried says why.
 *   reads          the reads TRUE at the confirmation bar, in compose_check's read forms (composed-reads.js), one per
 *                  step: bias `1h <trend>` when the 1h trend is the side's or a range, else `regime <name>`; location
 *                  `at <level>` (`at <tf> fvg`), else `vwap <side>`; setup the reaction itself (`15m rejected prior vah
 *                  down`); entry the confirming read; stop `<tf> high|low <price>`, the reaction candle's far side;
 *                  target the nearest real level (a swing target, the prior 1h or 4h high, mid or low, a gap's edge)
 *                  whose plan is at least 2:1. checkReads verifies them all on that briefing, so the signature is the
 *                  one a model stating the same reads gets. Not every read true, or the checker or the plan refusing
 *                  the combination for anything but room: `not-composable`, with the problem.
 *   plan           trade-lifecycle.js planOf, as compose_check plans a model's record: a limit at the confirmation
 *                  close, the stop one tick beyond the reaction candle (D3), D13's floor (a closer stop is refused,
 *                  never widened: `stop-under-floor`), the target on the tick, R:R at least 2 (no verified target reaching it:
 *                  `no-room`).
 *   outcome        experience-log.js limitOutcome, the experience log's counterfactual: the limit until the record
 *                  expires (the trade_lifecycle strategy's valid_bars base bars after the confirmation bar's close,
 *                  trade-lifecycle.js expiryOf: the plan the gate allows), the stop checked first on every bar,
 *                  SLIPPAGE_TICKS on the stop, out at end of day. Each record keeps its validBars; an index of records
 *                  with different ones is refused.
 * No parameter search and no optimisation: one standard, measured. Practice-train only (learning/splits.js): a scan
 * touching practice-validate, test or final is refused, and so is an index of any record outside practice-train.
 *
 * The index (buildLibraryIndex): per read signature and context (the experience index's cells, experience-index.js
 * cellStats: n, days, the win rate and mean R with day-clustered 90% intervals, MIN_N and MIN_DAYS), and per reaction
 * (the setup read alone), walk-forward by day (a statistic for day D counts only rows known before D), with each
 * reaction's no-room days; hashed, and pinned per run (pinLibrary) next to the experience index, never mixed with it.
 *
 *   STANDARD                               the standard, one line (the lookup shows it)
 *   scanLibrary({ bars, root, minutes, tick, from, to, setupTf, eodOf, sessions, validBars })   [record], causal,
 *                                          deterministic; validBars (required): the strategy's valid_bars
 *   strategyValidBars(pluginRoot, env)     the shipped trade_lifecycle strategy's valid_bars (throws without a valid one)
 *   composeAt(briefing, reaction, { side, tick })   { reads, checked, plan, status, why } at one confirmation bar
 *   buildLibraryIndex(records, { sources, seed, reps, now })   the index document, with its hash
 *   setupKeyOf(reads)                      'setup:<slug>' of the first setup relation read, or null
 *   readLibrary(file), writeLibrary(dir, doc), pinLibrary(runHome, file), loadPinnedLibrary(home)
 *   baseBars(bars, minutes)                a bars file's bars as base bars (1m bars aggregated), by time
 *   runnerClock({ from, to, sessions })    { inSession(closeMs), eodOf(ms) }: the runner's decision times and end of day
 *                                          (its default sessions, the exchange calendar for those years)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { buildBriefing, sessionWindow } = require('../trading/briefing');
const { checkReads, parseRead } = require('../trading/composed-reads');
const { STRATEGY: LIFECYCLE, planOf, expiryOf } = require('../trading/trade-lifecycle');
const { limitOutcome } = require('./experience-log');
const { setupMoment, DEFAULTS } = require('./setup-moments');
const { assertUse, sessionDate } = require('./splits');
const { cellStats, cellKey, contextKey, knownDay, assertPracticeTrain, MIN_N, MIN_DAYS, LEVEL } = require('./experience-index');
const { CONTEXT_KEYS } = require('./lifecycle-record');
const { barMinutes, aggregate } = require('../backtest/data');

// 2: the limit window is the strategy's valid_bars (1 held it one bar); a version-1 library is rebuilt.
const VERSION = 2;
const KIND = 'setup-library';
const MIN_RR = 2;
const WINDOW_BARS = 700;
const PINNED = 'library-pinned.json';
const STANDARD = 'one fixed standard at every reaction: a limit at the confirmation close, the stop one tick beyond the reaction candle (D13 floor), the first real level at 2:1 or more (else no room)';
const ENTRY_PATTERNS = { long: ['bullish engulfing', 'hammer'], short: ['bearish engulfing', 'shooting star'] };
const SKILL = { bias: 'mtf-bias-filter', location: 'levels-and-reactions', rejected: 'rejection', broke: 'breakout', fvg: 'fair-value-gaps', entry: 'candle-reading', stop: 'invalidation', target: 'take-profit' };

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const m3Of = b => (b && b.sections && b.sections.m3 ? b.sections.m3.data : null);
const tfLabel = m => (m % 60 === 0 ? `${m / 60}h` : `${m}m`);
/** A level's name as reads write it (composed-reads.js levelName): lower case, brackets dropped. */
const levelWords = name => String(name).replace(/[()[\]{}]/g, ' ').toLowerCase().split(/\s+/).filter(Boolean).join(' ');
const sideOf = dir => (dir === 'up' ? 'long' : dir === 'down' ? 'short' : null);

/** The entry read that confirms `side` on the base candle, in the standard's order, or null. */
function entryRead(c, side, base) {
  if (!isObj(c) || c.unavailable) return null;
  const pats = [...new Set([...(Array.isArray(c.patterns) ? c.patterns : []), c.pattern].filter(Boolean))];
  const pat = ENTRY_PATTERNS[side].find(p => pats.includes(p));
  if (pat) return `${base} pattern ${pat}`;
  if (c.momentum === (side === 'long' ? 'up' : 'down')) return `${base} momentum ${side === 'long' ? 'up' : 'down'}`;
  if (c.closeLocation === (side === 'long' ? 'top' : 'bottom')) return `${base} close ${c.closeLocation}`;
  return null;
}

/** The target candidates on the side's winning side, nearest first: [{ read, price }]. */
function targetCandidates(m3, side, ref) {
  const long = side === 'long';
  const out = [];
  const t = isObj(m3.swingTargets) ? m3.swingTargets : {};
  for (const x of (long ? t.above : t.below) || []) if (isObj(x) && num(x.price) !== null && x.frame) out.push({ read: `target ${levelWords(x.frame)} swing ${long ? 'high' : 'low'} ${x.price}`, price: x.price });
  for (const tf of ['1h', '4h']) {
    const r = isObj(m3.rangeTargets) ? m3.rangeTargets[tf] : null;
    for (const part of ['high', 'mid', 'low']) {
      const p = isObj(r) && isObj(r[part]) ? num(r[part].price) : null;
      if (p !== null) out.push({ read: `target prior ${tf} ${part} ${p}`, price: p });
    }
  }
  for (const [tf, v] of Object.entries(isObj(m3.fvgs) ? m3.fvgs : {})) {
    for (const g of Array.isArray(v) ? v : []) {
      for (const [edge, p] of [['low', num(g && g.low)], ['high', num(g && g.high)]]) if (p !== null) out.push({ read: `target ${tf} fvg ${edge} ${p}`, price: p });
    }
  }
  return out.filter(x => (long ? x.price > ref : x.price < ref)).sort((a, b) => Math.abs(a.price - ref) - Math.abs(b.price - ref) || a.read.localeCompare(b.read));
}

/**
 * The standard's reads and plan at one confirmation bar: { status, reads, checked, plan, why }. status: traded
 * (a plan), not-composable, stop-under-floor, no-room.
 */
function composeAt(b, reaction, { side, tick, setupTf = DEFAULTS.setupTf }) {
  const m3 = m3Of(b);
  const base = tfLabel(b.minutes);
  const stf = tfLabel(setupTf);
  const c = m3.candles[stf];
  const entry = entryRead(m3.candles[base], side, base);
  if (!entry) return { status: 'not-composable', why: 'no confirming entry read' };
  const fvg = reaction.kind === 'fvg';
  const setupRead = `${stf} ${reaction.rel} ${levelWords(reaction.name)} ${reaction.dir}`;
  const trend = b.sections.h1 && b.sections.h1.data && b.sections.h1.data.h1 ? b.sections.h1.data.h1.trend : null;
  const biasReads = [...(trend === 'range' || trend === (side === 'long' ? 'up' : 'down') ? [`1h ${trend}`] : []), ...(isObj(m3.regime) && m3.regime.primary ? [`regime ${m3.regime.primary}`] : [])];
  const locReads = [fvg ? `at ${levelWords(reaction.name).split(' ')[0]} fvg` : `at ${levelWords(reaction.name)}`, ...(isObj(m3.vwap) && m3.vwap.side ? [`vwap ${m3.vwap.side}`] : [])];
  const stopRead = `stop ${stf} ${side === 'long' ? 'low' : 'high'} ${side === 'long' ? c.l : c.h}`;
  const reads = (bias, loc, target) => [
    { step: 'bias', skill: SKILL.bias, read: bias }, { step: 'location', skill: SKILL.location, read: loc },
    { step: 'setup', skill: fvg ? SKILL.fvg : SKILL[reaction.rel], read: setupRead }, { step: 'entry', skill: SKILL.entry, read: entry },
    { step: 'stop', skill: SKILL.stop, read: stopRead }, { step: 'target', skill: SKILL.target, read: target },
  ];
  const ref = num(m3.price);
  const targets = targetCandidates(m3, side, ref);
  if (!targets.length) return { status: 'no-room', why: 'no level on the winning side' };
  // The first bias and location that are true (the target aside), then the nearest target at 2:1 or more.
  let pair = null;
  for (const bias of biasReads) {
    for (const loc of locReads) {
      const ch = checkReads({ reads: reads(bias, loc, targets[0].read), side, briefing: b, tick });
      if (ch.reads.filter(r => r.step !== 'target').every(r => r.check === true && r.agrees !== false)) { pair = [bias, loc]; break; }
    }
    if (pair) break;
  }
  if (!pair) return { status: 'not-composable', why: 'no true bias and location read for the side' };
  let floorRefused = null;
  // No room only when a target the checker verified fell short of 2:1; a refusal by the checker (or by the plan for
  // another reason) is not-composable, with its problem.
  let short = null;
  let refused = null;
  for (const t of targets) {
    const list = reads(pair[0], pair[1], t.read);
    const checked = checkReads({ reads: list, side, briefing: b, tick });
    if (!checked.ok) { refused = refused || `the checker refused ${t.read}: ${checked.problems[0] || (checked.reads.find(r => r.check !== true) || {}).fact || 'a read is not true'}`; continue; }
    const planned = planOf({ checked, briefing: b, side, size: 1, tick, tickValue: 1, minRR: MIN_RR, maxRiskUsd: Number.MAX_SAFE_INTEGER });
    if (!planned.plan) { refused = refused || `the plan refused ${t.read}: ${planned.problems[0]}`; continue; }
    const floor = planned.problems.find(p => /under the minimum/.test(p));
    if (floor) { floorRefused = floor; break; }
    const others = planned.problems.filter(p => !/^R:R .* is under the strategy's min/.test(p));
    if (others.length) { refused = refused || `the plan refused ${t.read}: ${others[0]}`; continue; }
    if (planned.problems.length) { short = short || planned.problems[0]; continue; }
    return { status: 'traded', reads: list, checked, plan: planned.plan };
  }
  if (floorRefused) return { status: 'stop-under-floor', why: floorRefused };
  if (short) return { status: 'no-room', why: `no level at ${MIN_RR}:1 or more (${short})` };
  return { status: 'not-composable', why: refused || 'no target the checker verifies' };
}

/** The shipped trade_lifecycle strategy's valid_bars: the window the library's limit is measured over. */
function strategyValidBars(pluginRoot, env = {}) {
  const doc = require('../trading/strategies').loadStrategies(pluginRoot, env).strategies.find(x => x.name === LIFECYCLE);
  if (!doc || !doc.valid || !Number.isInteger(doc.valid_bars)) throw new Error(`strategies/${LIFECYCLE}/STRATEGY.md is ${doc ? 'invalid or states no valid_bars' : 'missing'}: the library's limit window comes from it`);
  return doc.valid_bars;
}

/** 'setup:<slug>' of the first setup relation read, or null. */
function setupKeyOf(reads) {
  for (const r of Array.isArray(reads) ? reads : []) {
    if (!r || r.step !== 'setup') continue;
    const p = parseRead(r.read);
    if (p.kind === 'relation' && p.slug) return `setup:${p.slug}`;
  }
  return null;
}

const idOf = (...parts) => crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);

/**
 * Every reaction moment of the bars, with the standard measured: [record]. bars: closed base bars ({ t, o, h, l, c, v },
 * by time) of one root; from/to: the session dates scanned ([from, to), practice-train only); eodOf(ms): that day's end
 * of day; inSession(closeMs): whether a bar is a decision time (the runner's sessions).
 */
function scanLibrary({ bars, root, minutes = 3, tick = 0.25, from, to, setupTf = DEFAULTS.setupTf, eodOf, inSession = () => true, validBars }) {
  assertUse('practice', from, to);
  if (!(Number.isInteger(validBars) && validBars >= 1)) throw new Error(`validBars: the ${LIFECYCLE} strategy's valid_bars, a whole number of bars from 1 (the limit's window, as the gate allows it)`);
  const list = bars.map(b => ({ ...b, ms: Date.parse(b.t) }));
  const tfMs = minutes * 60000;
  const stepMs = setupTf * 60000;
  const span = Math.round(setupTf / minutes);
  const brief = i => buildBriefing({ symbol: root, bars: list.slice(Math.max(0, i - WINDOW_BARS + 1), i + 1).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v })), minutes, now: new Date(list[i].ms + tfMs) });
  const out = [];
  const first = sessionDate(from);
  for (let i = 300; i < list.length; i += 1) {
    const close = list[i].ms + tfMs;
    if (close % stepMs !== 0 || !inSession(close)) continue;
    const day = sessionDate(close - 1);
    if (day < first || day >= sessionDate(to)) continue;
    const b = brief(i);
    const m = setupMoment(m3Of(b).candles, { setupTf, barClose: close });
    if (!m.moment || m.phase !== 'reaction') continue;
    const reaction = m.reactions[0];
    const side = sideOf(reaction.dir);
    if (!side) continue;
    const base = { v: VERSION, validBars, root, day, reactionAt: m.candle.closedAt, reaction: { kind: reaction.kind, name: reaction.name, rel: reaction.rel, dir: reaction.dir, price: reaction.price }, side };
    let rec = { ...base, id: idOf(root, m.candle.closedAt, reaction.name, reaction.rel), bar: list[i].t, status: 'no-confirmation', why: null, reads: [], signature: null, setupKey: null, context: null, plan: null, outcome: null };
    // The window: the closes AFTER the reaction bar (an entry read is on a candle closed after the setup candle, the
    // gate's same-candle rule) while the reaction candle is the last completed one. Each confirming close is tried in
    // turn until one composes; a close in a no-entry window (the gate's entry clock, briefing.js sessionWindow) is skipped.
    for (let j = i + 1; j < Math.min(list.length, i + span); j += 1) {
      const cj = list[j].ms + tfMs;
      if (cj % stepMs === 0 || !inSession(cj) || sessionDate(cj - 1) !== day) break;
      if (sessionWindow(new Date(cj)).entries !== 'allowed') {
        if (rec.status === 'no-confirmation') rec = { ...rec, bar: list[j].t, status: 'no-entry-window', why: sessionWindow(new Date(cj)).text };
        continue;
      }
      const bj = brief(j);
      const cand = m3Of(bj).candles[tfLabel(setupTf)];
      if (!cand || cand.closedAt !== m.candle.closedAt) break;
      if (!entryRead(m3Of(bj).candles[tfLabel(minutes)], side, tfLabel(minutes))) continue;
      const r = composeAt(bj, reaction, { side, tick, setupTf });
      rec = { ...rec, bar: list[j].t, status: r.status, why: r.why || null };
      if (r.status === 'traded') {
        const outcome = limitOutcome({ bars: list, tfMs, side, entry: r.plan.entry.price, stop: r.plan.stop.price, target: r.plan.target.price, fromMs: cj, expiresMs: expiryOf(bj, validBars), eodMs: eodOf(cj), tick });
        rec = {
          ...rec, reads: r.reads.map(x => ({ step: x.step, skill: x.skill, read: x.read })), signature: r.checked.signature, setupKey: setupKeyOf(r.reads), context: r.checked.context,
          plan: { entry: r.plan.entry.price, stop: r.plan.stop.price, target: r.plan.target.price, rr: r.plan.rr, stopTicks: r.plan.stop.ticks },
          outcome: { ...outcome, source: 'library' },
        };
      } else {
        // Not composed on this close: the next confirming close is tried.
        continue;
      }
      break;
    }
    if (!rec.setupKey) rec.setupKey = `setup:${parseRead(`${tfLabel(setupTf)} ${reaction.rel} ${levelWords(reaction.name)} ${reaction.dir}`).slug}`;
    out.push(rec);
  }
  return out;
}

function libraryHash(doc) {
  const { builtAt: _b, hash: _h, ...rest } = doc;
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

const hasR = r => r.outcome && Number.isFinite(r.outcome.R);

/** The library's index: cells per read signature and context, and per reaction (see the header). */
function buildLibraryIndex(records, { sources = [], seed = 1, reps = 2000, now = new Date() } = {}) {
  const hashes = sources.map(s => s.sha256).filter(Boolean);
  if (new Set(hashes).size !== hashes.length) throw new Error('library index refused: the same library file given twice (its sha256 repeats)');
  const ids = new Set();
  const recs = records.filter(r => r && r.v === VERSION && (ids.has(r.id) ? false : (ids.add(r.id), true)));
  assertPracticeTrain(recs);
  const windows = [...new Set(recs.map(r => r.validBars))];
  if (windows.length > 1) throw new Error(`library index refused: records measured with different limit windows (valid_bars ${windows.join(', ')}): scan them again under one`);
  let cells = {};
  const add = (k, row) => { (cells[k] = cells[k] || []).push(row); };
  const noRoom = {};
  const status = {};
  for (const r of recs) {
    status[r.status] = (status[r.status] || 0) + 1;
    const day = knownDay(r);
    if (r.status === 'no-room' && r.setupKey) (noRoom[r.setupKey] = noRoom[r.setupKey] || []).push(day);
    if (r.status !== 'traded') continue;
    const row = [day, hasR(r) ? r.outcome.R : null, 1, (r.context && r.context.regime) || '-'];
    add(cellKey('read', r.signature), row);
    for (const k of CONTEXT_KEYS) add(cellKey('read', r.signature, `${k}=${r.context && r.context[k] !== null && r.context[k] !== undefined ? r.context[k] : '-'}`), row);
    add(cellKey('read', r.signature, contextKey(r.context)), row);
    if (r.setupKey) {
      add(cellKey('setup', r.setupKey), row);
      add(cellKey('setup', r.setupKey, contextKey(r.context)), row);
    }
  }
  const keys = Object.keys(cells).sort();
  cells = Object.fromEntries(keys.map(k => [k, cells[k].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))]));
  for (const k of Object.keys(noRoom)) noRoom[k].sort();
  const days = [...new Set(recs.map(knownDay))].sort();
  const doc = {
    v: VERSION, kind: KIND, builtAt: now.toISOString(), standard: STANDARD, validBars: windows[0] ?? null, minN: MIN_N, minDays: MIN_DAYS, level: LEVEL, seed, reps, walkForward: true,
    sources: sources.map(s => ({ file: s.file ? path.basename(s.file) : null, sha256: s.sha256 || null })),
    roles: ['practice-train'], months: { from: days[0] || null, to: days[days.length - 1] || null },
    records: recs.length, status: Object.fromEntries(Object.entries(status).sort()), cells, noRoom: Object.fromEntries(Object.entries(noRoom).sort()),
  };
  return { ...doc, hash: libraryHash(doc) };
}

/** A reaction's no-room count before a day. */
const noRoomBefore = (doc, key, before) => ((doc.noRoom || {})[key] || []).filter(d => before === null || d < before).length;
const libraryCellAt = (doc, key, before = null) => (doc.cells[key] ? cellStats(doc.cells[key], { before, seed: doc.seed, reps: doc.reps, key }) : null);

function writeLibrary(dir, doc) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `library-${doc.hash.slice(0, 16)}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

function readLibrary(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isObj(doc) || doc.kind !== KIND || typeof doc.hash !== 'string') throw new Error(`${file}: not a history library index`);
  if (doc.v !== VERSION || doc.walkForward !== true) throw new Error(`${file}: a library index of version ${doc.v}, not ${VERSION} (walk-forward): rebuild it`);
  if (libraryHash(doc) !== doc.hash) throw new Error(`${file}: its content doesn't match its hash (changed after it was built)`);
  return doc;
}

const learningRun = home => { try { return JSON.parse(fs.readFileSync(path.join(home, 'learning-run.json'), 'utf8')); } catch (_err) { return null; } };

/** Pin a library index for a run (its own copy, frozen by its hash); a run keeps the one it pinned. */
function pinLibrary(runHome, file) {
  const doc = readLibrary(file);
  const run = learningRun(runHome);
  if (run && run.learning === false) throw new Error('this run is declared not learning: no history library');
  const dir = path.join(runHome, 'experience');
  let pinned = null;
  try { pinned = JSON.parse(fs.readFileSync(path.join(dir, PINNED), 'utf8')); } catch (_err) { /* none yet */ }
  if (pinned && pinned.hash !== doc.hash) throw new Error(`this run pinned library ${String(pinned.hash).slice(0, 16)}; a run keeps its library (start another runId for ${doc.hash.slice(0, 16)})`);
  const copy = writeLibrary(dir, doc);
  fs.writeFileSync(path.join(dir, PINNED), `${JSON.stringify({ file: path.basename(copy), hash: doc.hash, walkForward: true })}\n`);
  return { file: copy, hash: doc.hash };
}

/** The run's pinned library index (hash checked), or null when none is pinned or the run is declared not learning. */
function loadPinnedLibrary(home) {
  const run = learningRun(home);
  if (run && run.learning === false) return null;
  const dir = path.join(home, 'experience');
  let pin;
  try { pin = JSON.parse(fs.readFileSync(path.join(dir, PINNED), 'utf8')); } catch (_err) { return null; }
  if (!pin || !/^library-[0-9a-f]{16}\.json$/.test(String(pin.file))) throw new Error('the pinned library is not a library file');
  const doc = readLibrary(path.join(dir, pin.file));
  if (doc.hash !== pin.hash) throw new Error(`the pinned library's hash ${String(pin.hash).slice(0, 16)} is not its file's ${doc.hash.slice(0, 16)}`);
  return doc;
}

/** A bars file's bars as base bars of `minutes`: as they are, or 1m bars aggregated on the clock's grid. */
function baseBars(bars, minutes) {
  const list = bars.map(b => ({ t: new Date(Date.parse(b.t)).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, ms: Date.parse(b.t) })).sort((a, b) => a.ms - b.ms);
  const m = barMinutes(list);
  if (m === minutes) return list.map(({ ms: _ms, ...b }) => b);
  if (m === 1) return aggregate(list, { unit: 2, unitNumber: minutes, nowMs: Infinity, extraFields: 'drop' });
  throw new Error(`the bars are ${m}m: give ${minutes}m or 1m bars`);
}

/** The runner's decision times and end of day over [from, to) (its default sessions unless given; holidays closed). */
function runnerClock({ from, to, sessions = null }) {
  const { validateConfig } = require('../autotrader');
  const { isTradeTime, holidayDates } = require('../replay/schedule');
  const { eodOf } = require('../replay/labels');
  const h = holidayDates(new Date(`${sessionDate(from)}T00:00:00Z`), new Date(`${sessionDate(to)}T00:00:00Z`));
  const cfg = validateConfig({ harness: 'opencode', symbols: ['MNQ'], premarketAt: '', ...(sessions ? { sessions } : {}), closedDates: h.closed, earlyCloseDates: h.early });
  return { inSession: ms => isTradeTime(cfg, new Date(ms)), eodOf: ms => eodOf(cfg, ms) };
}

module.exports = { strategyValidBars,
  baseBars, runnerClock,
  VERSION, KIND, MIN_RR, STANDARD, scanLibrary, composeAt, entryRead, targetCandidates, setupKeyOf, buildLibraryIndex, libraryCellAt, noRoomBefore,
  libraryHash, writeLibrary, readLibrary, pinLibrary, loadPinnedLibrary,
};
