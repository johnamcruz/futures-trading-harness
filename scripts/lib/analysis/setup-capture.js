'use strict';

/**
 * Setup capture (the owner: "confirm trades are catching setups"): for one arm's run homes, every census trend leg the
 * run covered, caught or not and why, and every setup its briefings listed or its scans fired, taken or not and why.
 * Analysis after the run only (never shown to the model). It measures with the loop's own tools, not new ones:
 *
 * - The legs are the leg census's (learning/leg-census.js), and a leg is caught as the loop counts it: an entry its way
 *   that filled within the leg's first catchShare (replay/trend-capture.js captureReport, the census's legs given). Its
 *   R banked, its available R, its blocker by flow step and the run's entries in a leg or not are captureReport's.
 * - A leg is in scope for a run only when the run covered its catch span: a decision time of the run (a day record's
 *   `t`, or one in its `skipped` list: passed while a cycle ran) fell on one of its catch bars. A stepped-windows run
 *   (the loop's) covers its windows' legs; a whole-session run every leg of its days. Out of scope: 'not-run', never a
 *   miss. The day's other census legs only classify entries (captureReport `context`).
 * - Aligned: the leg's 4h and 1h both trend its way at its start (train/trend-align.js aligned, trendsAt, on the run's
 *   own served base bars: causal, the briefing's read); unreadable trends are no agreement, as the loop's filter.
 * - The late refusals and their counterfactual (target or stop first) are replay/late-skips.js lateSkipReport's.
 * - An "on" run's path per close is prepare-shadow-report.js pathKey's (confirm, or fallback:<why>).
 * - A setup's kind is its read's (trading/composed-reads.js parseRead): relation reads by rel (rejected, broke), cisd,
 *   compression; a fired scan setup by its strategy's name (momentum_continuation).
 *
 * An uncaught leg's reason, one each (REASONS, a partition), from its blocker (the cycle that came closest to an
 * entry, captureReport's): late-chased | late-missed | late-beyond-stop | late-unknown (the late-entry rule, by kind),
 * gate-refusal (another gate check; one the runner logged as its entry's outcome is execution), execution (an executor
 * abort or block, an entry unfilled), risk-veto | verdict-unread | min-contracts (phase 2: a VETO, a verdict the runner
 * could not read, the sizing floor), passed-by-head (an OK record not placed), compose-refused, position-open-own-side |
 * position-open-opposite | position-open-unknown (a position held in the catch window, by its side against the leg's),
 * account-blocked (the attempt's entry block in a span cycle's account, not one that only says a position is open),
 * rule (a named rule: news, opening print, a stop), cycle-overran (no plan, and a catch bar passed while a cycle ran or
 * a cycle overran its bar), setup-passed (no plan, a setup listed or fired its way), no-setup-listed (no plan, none
 * listed), no-cycle (its catch bars had decision times but no trade cycle ran), other. A leg whose catch steps ran no
 * cycle on a stale bar (the replay served no new bar) is notServed: legTotals leaves it out of the default count.
 *
 *   REASONS, SETUP_OUTCOMES, LATE_KINDS
 *   readHome(home, { census, alignedOf })   one run home's facts: { home, name, runId, days, missingDays, legs, notRun,
 *                                           entries, entryCycles, setups, decisions: { times, ran, skipped, cycles,
 *                                           overran, lost, byDay }, late } (alignedOf(leg): an override of aligned, tests)
 *   readArm(paths, { census })               { homes: [readHome], skipped } (scanHomes)
 *   scanHomes(paths), homesOf(paths)        run homes, or folders of them, each once by its real path, sorted by name;
 *                                           scanHomes: { homes, skipped (a folder's children with no replay folder) }
 *   armProblems(arm)                         [{ kind, detail }]: what the arm's input lacks (see the function)
 *   armSummary(arm)                          { homes, errors, missingDays, problems, days: { day: totals }, totals: { all,
 *                                           aligned, notRun, entries, setups: { byKind, byPath }, decisions, late, entryPaths } }
 *   legTotals(legs)                          { legs, caught, rate, rCaught, rAvailable, share, reasons, notServed,
 *                                           withNotServed: { legs, caught, rate } }
 *   bankedR(caught)                          the caught legs' R, each entry once
 *   armLines(summary, name)                  the summary as text lines
 *   reasonOf(leg, ctx)                       the reason of one uncaught leg (pure; ctx: the span's facts)
 *   setupOutcome(setup, ctx)                 one listed or fired setup's outcome (pure)
 */

const fs = require('fs');
const path = require('path');
const tc = require('../replay/trend-capture');
const { readRun } = require('../replay/store');
const { readRecords } = require('../trading/trade-lifecycle');
const { parseRead, levelName } = require('../trading/composed-reads');
const { lateSkipReport } = require('../replay/late-skips');
const { pathKey } = require('../prepare-shadow-report');
const TA = require('../train/trend-align');
const { round4 } = require('../prop/stats');
const { tradingDayKey } = require('../trading/clock');

const dayOf = t => tradingDayKey(new Date(t));

const REASONS = Object.freeze([
  'late-chased', 'late-missed', 'late-beyond-stop', 'late-unknown', 'gate-refusal', 'execution', 'risk-veto', 'verdict-unread', 'min-contracts',
  'passed-by-head', 'compose-refused', 'position-open-own-side', 'position-open-opposite', 'position-open-unknown', 'account-blocked', 'rule',
  'cycle-overran', 'setup-passed', 'no-setup-listed', 'no-cycle', 'other',
]);
const SETUP_OUTCOMES = Object.freeze([
  'taken', 'late-chased', 'late-missed', 'late-beyond-stop', 'late-unknown', 'gate-refusal', 'execution', 'risk-veto', 'verdict-unread', 'min-contracts',
  'passed-by-head', 'compose-refused', 'passed', 'passed-no-reason', 'unrecorded', 'fired-not-composed',
]);
const LATE = Object.freeze({ 'chased-entry': 'late-chased', 'missed-entry': 'late-missed', 'beyond-stop': 'late-beyond-stop' });
const LATE_KINDS = Object.freeze(Object.keys(LATE));
const lateReason = kind => LATE[kind] || 'late-unknown';
// Phase 2's refusal by what it said (trend-capture.js classifyCycle's codes): the sizing floor, a veto, or an approval
// the runner could not read (not the risk manager saying no).
const PHASE2 = Object.freeze({ veto: 'risk-veto', 'verdict-unread': 'verdict-unread', 'min-contracts': 'min-contracts' });
const phase2Of = why => (/min[-_ ]contracts|floor/i.test(why) ? 'min-contracts' : /VERDICT:\s*VETO/i.test(why) ? 'risk-veto' : 'verdict-unread');

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_err) { return null; } };
const readLines = file => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch (_err) { return []; } }); } catch (_err) { return []; } };
const count = (o, k) => { o[k] = (o[k] || 0) + 1; return o; };
const sorted = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const sideOfDir = d => (d === 'up' || d === 'long' ? 'long' : d === 'down' || d === 'short' ? 'short' : null);
// A read with a level's bracketed qualifier ("VWAP (rth)") as the briefing's names spell it bare (levelName): parseRead
// takes brackets as ambiguous, and the model writes both spellings.
const bare = read => levelName(read);
const formOf = read => { const p = parseRead(bare(read)); return p.form || bare(read); };

/** A setup read's kind and side (parseRead): relation by its rel, cisd, compression, a fired setup by its name. */
function setupKind(read) {
  const p = parseRead(bare(read));
  if (p.kind === 'relation') return { kind: p.rel === 'rejected' ? 'rejection' : p.rel === 'broke' ? 'breakout' : p.rel, side: sideOfDir(p.value) };
  if (p.kind === 'fired') return { kind: p.name, side: sideOfDir(p.value) };
  if (p.kind === 'cisd' || p.kind === 'compression') return { kind: p.kind, side: sideOfDir(p.value) };
  return { kind: 'other', side: null };
}

/** The run's single replay folder under <home>/replay (refused when it holds several: their logs would mix). */
function runDirOf(home) {
  let ids = [];
  try { ids = fs.readdirSync(path.join(home, 'replay')).filter(id => fs.existsSync(path.join(home, 'replay', id, 'manifest.json'))).sort(); } catch (_err) { /* none */ }
  if (ids.length > 1) throw new Error(`${path.basename(home)}: ${ids.length} replay runs in one home; their logs mix: give each run its own home`);
  return ids.length ? path.join(home, 'replay', ids[0]) : null;
}

/** A home's cycle logs by bar close (ms): { trade (the trade cycles), any (trade or manage, the trade one first) }. */
function cycleLogs(home) {
  const trade = new Map();
  const any = new Map();
  for (const c of tc.cyclesOf(home)) {
    const k = Date.parse(c.timing.barClose);
    if (c.action === 'trade') { trade.set(k, c); any.set(k, c); } else if (!any.has(k)) any.set(k, c);
  }
  return { trade, any };
}

/**
 * The reason of an uncaught, covered leg (see the header). ctx: { blocker, lateKind, skipped, overran, listed, blocked,
 * positionSide ('own' | 'opposite' | null: the side of the position the span's cycles show) }.
 */
function reasonOf(leg, ctx = {}) {
  const b = isObj(ctx.blocker) ? ctx.blocker : isObj(leg.blocker) ? leg.blocker : null;
  const quiet = !b || b.code === 'no-plan' || b.code === 'outside-session';
  if (b && b.code === 'late-entry') return lateReason(ctx.lateKind);
  if (b && b.by === 'gate') return 'gate-refusal';
  if (b && (b.by === 'executor' || b.code === 'unfilled')) return 'execution';
  if (b && b.by === 'phase2') return PHASE2[b.code] || 'risk-veto';
  if (b && b.code === 'head-pass') return 'passed-by-head';
  if (b && b.by === 'compose_check') return 'compose-refused';
  if (b && b.code === 'position-open') return ctx.positionSide === 'own' ? 'position-open-own-side' : ctx.positionSide === 'opposite' ? 'position-open-opposite' : 'position-open-unknown';
  if (ctx.blocked && (quiet || b.by === 'rule')) return 'account-blocked';
  if (b && b.by === 'rule' && b.code !== 'outside-session') return 'rule';
  if (quiet && (ctx.skipped || ctx.overran)) return 'cycle-overran';
  if (b && b.code === 'no-plan') return ctx.listed ? 'setup-passed' : 'no-setup-listed';
  if (b && b.code === 'outside-session') return 'no-cycle';
  return 'other';
}

/**
 * One listed or fired setup's outcome on its cycle (see SETUP_OUTCOMES). ctx: { records (the compose records of the
 * cycle's bar), entry (the cycle's), refusedIds (records the gate refused), skipped (its setupSkips row: { reason }) }.
 */
function setupOutcome(setup, { records = [], entry = null, refusedIds = new Set(), lateKind = null, skip = null } = {}) {
  const form = formOf(setup.read);
  const mine = records.filter(r => r.side === setup.side && (r.reads || []).some(x => formOf(x.read) === form));
  const ids = new Set(mine.map(r => r.id));
  if (isObj(entry) && ids.has(entry.record)) {
    if (entry.outcome === 'executed') return 'taken';
    if (entry.outcome === 'late') return lateReason(lateKind || (isObj(entry.late) ? entry.late.kind : null));
    if (entry.outcome === 'vetoed') return phase2Of(String(entry.why || ''));
    return 'execution';
  }
  if (mine.some(r => refusedIds.has(r.id))) return 'gate-refusal';
  if (mine.some(r => r.ok)) return 'passed-by-head';
  if (mine.length) return 'compose-refused';
  // Never composed: a fired scan setup has no skip row (the setup skips list listed setups only); a listed one says why
  // (passed), says nothing (passed-no-reason), or has no row at all (unrecorded).
  if (setup.source === 'fired') return 'fired-not-composed';
  if (!isObj(skip)) return 'unrecorded';
  return skip.reason === null ? 'passed-no-reason' : 'passed';
}

// The attempt's entry block in a cycle's account, unless it only says a position is open (the position's, not the attempt's).
const blockedIn = c => isObj(c && c.context) && isObj(c.context.account) && (c.context.account.attempts || []).some(a => isObj(a) && a.entryBlock && !/position is open/i.test(String(a.entryBlock)));
const sidesHeld = c => (isObj(c && c.context) && isObj(c.context.account) && Array.isArray(c.context.account.positions) ? c.context.account.positions : []).map(p => isObj(p) && p.side).filter(Boolean);
const onOf = c => (isObj(c && c.prepare) && isObj(c.prepare.on) ? c.prepare.on : null);
const pathOf = c => (onOf(c) ? pathKey(onOf(c)) : null);

/** One run home's facts (see the header). */
function readHome(home, { census, alignedOf = null } = {}) {
  const runDir = runDirOf(home);
  const name = path.basename(home);
  if (!runDir) return { home, name, runId: null, error: 'no replay run in this home', days: [], missingDays: [], legs: [], notRun: [], entries: [], entryCycles: [], setups: [], decisions: { times: 0, ran: 0, skipped: 0, cycles: 0, overran: 0, lost: 0, byDay: {} }, late: { total: 0, byKind: {}, rows: [] } };
  const run = readRun(runDir);
  const cfg = readJson(path.join(runDir, 'autotrader.json')) || {};
  const minutes = Number(cfg.timeframe) || null;
  if (!minutes) throw new Error(`${name}: the run's autotrader.json has no timeframe (the base bars)`);
  const step = minutes * 60000;
  const share = require('../tunables').replay().trendCapture.catchShare;
  // A decision time's bar close (the runner decides a few seconds after the close).
  const closeOf = t => Math.floor(Date.parse(t) / step) * step;
  const days = Object.keys(run.days).sort();
  const order = Array.isArray(census && census.order) ? census.order : [];
  const censusDays = new Set(order.map(x => x.day));
  // The run's decision times by bar close: those it ran, and those that passed while a cycle ran (skipped).
  const ranAt = new Set();
  const skippedAt = new Set();
  // A step served its bar when it ran a cycle, or the runner's newest base bar was the one that just closed (a step
  // that ran nothing on a stale bar: the replay served no new bar). A record that names no bars: served (unknown).
  const servedAt = new Set();
  for (const d of days) for (const r of run.days[d]) {
    if (!isObj(r)) continue;
    if (r.kind === 'trade' && Number.isFinite(Date.parse(r.t))) {
      const t = closeOf(r.t);
      ranAt.add(t);
      const newest = Array.isArray(r.bars) ? r.bars.map(x => Date.parse(isObj(x) ? x.lastBarT : null)).filter(Number.isFinite) : [];
      if ((Array.isArray(r.ran) && r.ran.length) || !Array.isArray(r.bars) || newest.some(ms => ms >= t - step)) servedAt.add(t);
    }
    for (const t of Array.isArray(r.skipped) ? r.skipped : []) if (Number.isFinite(Date.parse(t))) { skippedAt.add(closeOf(t)); servedAt.add(closeOf(t)); }
  }
  const spanOf = g => {
    const t0 = Date.parse(g.start);
    const until = t0 + (Date.parse(g.end) + step - t0) * share;
    const bars = [];
    for (let t = t0 + step; t <= until; t += step) bars.push(t);
    return bars;
  };
  const dayLegs = order.filter(g => days.includes(g.day)).map(g => ({ id: g.id, day: g.day, side: g.side, start: g.start, end: g.end, points: g.points }));
  const inScope = dayLegs.filter(g => spanOf(g).some(t => ranAt.has(t) || skippedAt.has(t)));
  const scopeIds = new Set(inScope.map(g => g.id));
  const cap = tc.captureReport({ runDir, days: run.days, manifest: run.manifest, legs: inScope, context: dayLegs.filter(g => !scopeIds.has(g.id)) });
  const { trade: logs, any: anyLogs } = cycleLogs(home);
  const recs = readRecords(home);
  const onBar = new Map();
  for (const r of recs) { const k = Date.parse(r.bar) + step; if (!onBar.has(k)) onBar.set(k, []); onBar.get(k).push(r); }
  const refusals = readLines(path.join(home, 'logs', 'gate-log.jsonl')).filter(g => isObj(g) && g.tool === 'place_order' && g.decision !== 'allowed');
  const refusedIds = new Set(recs.filter(r => refusals.some(g => String(g.rationale || '').includes(r.id))).map(r => r.id));
  // The late refusals (lateSkipReport, its counterfactual on the run's served 1m bars, else the base bars).
  const m1 = tc.servedBars(runDir, 1);
  const bars = tc.servedBars(runDir, minutes);
  const late = lateSkipReport(home, { barsFor: () => (m1.length ? m1 : bars) });
  const lateOfRecord = new Map(late.rows.filter(x => x.record).map(x => [x.record, x.kind]));
  const series = TA.htfSeries(bars, minutes);
  // Too little history to read the 4h or 1h trend (the briefing's reader refuses): no agreement, as the loop's filter.
  const readable = g => { try { return TA.aligned(g.side, TA.trendsAt(series, g.start)); } catch (_err) { return false; } };
  const aligned = g => (typeof alignedOf === 'function' ? alignedOf(g) === true : readable(g));
  const listedSide = (c, side) => {
    if (!c) return false;
    const listed = (isObj(c.context) && Array.isArray(c.context.setupsListed) ? c.context.setupsListed : []).map(setupKind);
    const fired = (isObj(c.context) && Array.isArray(c.context.symbols) ? c.context.symbols : []).flatMap(s => (isObj(s) && Array.isArray(s.fired) ? s.fired : [])).map(f => ({ side: sideOfDir(f && f.direction) }));
    return [...listed, ...fired].some(s => s.side === side);
  };
  const legs = cap.legs.map(l => {
    const span = spanOf(l);
    const cs = span.map(t => logs.get(t)).filter(Boolean);
    const held = span.map(t => anyLogs.get(t)).filter(Boolean).flatMap(sidesHeld);
    const b = l.blocker;
    const last = b ? [...l.cycles].reverse().find(c => c.code === b.code) : null;
    const at = last ? Date.parse(last.bar) : NaN;
    const bc = Number.isFinite(at) ? logs.get(at) : null;
    const barRecs = Number.isFinite(at) ? (onBar.get(at) || []).filter(r => r.side === l.side) : [];
    const lateKind = b && b.code === 'late-entry' ? (bc && isObj(bc.entry) && isObj(bc.entry.late) && bc.entry.late.kind) || barRecs.map(r => lateOfRecord.get(r.id)).find(Boolean) || null : null;
    const ctx = { blocker: b, lateKind, skipped: span.some(t => skippedAt.has(t)), overran: cs.some(c => isObj(c.timing) && (c.timing.overran === true || c.timing.setupMissed === 'overran')), listed: cs.some(c => listedSide(c, l.side)), blocked: cs.some(blockedIn),
      positionSide: held.includes(l.side) ? 'own' : held.length ? 'opposite' : null };
    // Not served: every decision time on its catch bars came with no new bar (and none passed while a cycle ran).
    const covered = span.filter(t => ranAt.has(t) || skippedAt.has(t));
    const notServed = !l.captured && covered.length > 0 && covered.every(t => !servedAt.has(t));
    const entries = cap.entries.filter(e => e.kind === 'in-trend' && e.leg === l.id);
    const delayMin = l.captured && l.entry ? round4((Date.parse(l.entry.at) - Date.parse(l.start)) / 60000) : null;
    return {
      id: l.id, day: l.day, side: l.side, start: l.start, end: l.end, points: l.move.points, aligned: aligned(l), caught: l.captured === true,
      entry: l.entry ? { at: l.entry.at, filled: l.entry.filled, r: num(l.entry.r), delayMin } : null, availableR: num(l.availableR), estimated: l.estimated === true,
      inLegEntries: entries.length, reason: l.captured ? null : reasonOf(l, ctx), notServed, blocker: b ? { step: b.step, code: b.code, by: b.by } : null, lateKind, skippedInSpan: ctx.skipped,
      path: l.captured ? null : pathOf(bc),
    };
  }).sort((a, b) => (a.id < b.id ? -1 : 1));
  const notRun = dayLegs.filter(g => !scopeIds.has(g.id)).map(g => ({ id: g.id, day: g.day, side: g.side, aligned: aligned(g), reason: 'not-run' })).sort((a, b) => (a.id < b.id ? -1 : 1));
  // The setups each trade cycle's briefing listed and its scans fired, with their outcome.
  const setups = [];
  let overran = 0;
  // The bars lost to latency, each once: a decision time skipped while a cycle ran, and the next bar of a cycle that
  // overran its bar (the same bar when the overrun swallowed a decision time).
  const lost = new Set(skippedAt);
  for (const [ms, c] of [...logs.entries()].sort((a, b) => a[0] - b[0])) {
    if (isObj(c.timing) && (c.timing.overran === true || c.timing.setupMissed === 'overran')) {
      overran += 1;
      const next = Date.parse(c.timing.nextBarClose);
      lost.add(Number.isFinite(next) ? next : ms + step);
    }
    const ctxt = isObj(c.context) ? c.context : {};
    const skips = isObj(c.summary) && Array.isArray(c.summary.setupSkips) ? c.summary.setupSkips : [];
    const listed = (Array.isArray(ctxt.setupsListed) ? ctxt.setupsListed : []).map(read => ({ read, source: 'listed', ...setupKind(read) }));
    const fired = (Array.isArray(ctxt.symbols) ? ctxt.symbols : []).flatMap(s => (isObj(s) && Array.isArray(s.fired) ? s.fired : [])).filter(f => isObj(f) && f.name)
      .map(f => ({ read: `${f.name} fired ${f.direction === 'long' ? 'up' : f.direction === 'short' ? 'down' : f.direction}`, source: 'fired', kind: f.name, side: sideOfDir(f.direction) }));
    const records = onBar.get(ms) || [];
    const entry = isObj(c.entry) ? c.entry : null;
    const lateKind = entry && entry.outcome === 'late' ? (isObj(entry.late) && entry.late.kind) || lateOfRecord.get(entry.record) || null : null;
    for (const s of [...listed, ...fired]) {
      const skip = skips.find(x => isObj(x) && x.setup === String(s.read).toLowerCase().replace(/\s+/g, ' ').trim()) || null;
      setups.push({ bar: new Date(ms).toISOString(), day: dayOf(ms - 1), read: s.read, source: s.source, kind: s.kind, side: s.side, outcome: setupOutcome(s, { records, entry, refusedIds, lateKind, skip }), path: pathOf(c) });
    }
  }
  const entries = cap.entries.map(e => ({ at: e.at, side: e.side, record: e.record, kind: e.kind, leg: e.leg, r: num(e.r), caughtLeg: cap.legs.some(l => l.captured && l.entry && l.entry.at === e.at && l.side === e.side) }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const times = new Set([...ranAt, ...skippedAt]);
  const entryCycles = [...logs.values()].filter(c => isObj(c.entry) && c.entry.outcome === 'executed').map(c => ({ bar: c.timing.barClose, path: pathOf(c) })).sort((a, b) => (a.bar < b.bar ? -1 : 1));
  return {
    home, name, runId: run.manifest.runId || path.basename(runDir), days, missingDays: days.filter(d => !censusDays.has(d)),
    legs, notRun, entries, entryCycles, setups,
    // The trading days of its trade cycle logs, each with how many (a day with logs but no decision time is a problem).
    cycleDays: sorted([...logs.keys()].reduce((o, ms) => count(o, dayOf(ms - 1)), {})),
    decisions: { times: times.size, ran: ranAt.size, skipped: skippedAt.size, cycles: logs.size, overran, lost: lost.size, byDay: sorted([...times].reduce((o, t) => count(o, dayOf(t - 1)), {})) },
    late: { total: late.total, byKind: sorted(late.byKind), rows: late.rows.map(x => ({ at: x.at, side: x.side, kind: x.kind, record: x.record, first: x.first, from: x.from })) },
  };
}


/**
 * Homes given as run homes or folders of them (a folder whose children hold replay runs), each once by its real path,
 * sorted by name: { homes, skipped } (skipped: a folder's children that hold no replay folder, by name).
 */
function scanHomes(paths) {
  const out = new Map();
  const skipped = [];
  const add = p => { const real = fs.realpathSync(p); if (!out.has(real)) out.set(real, p.replace(/[\\/]+$/, '')); };
  for (const p of paths) {
    if (fs.existsSync(path.join(p, 'replay'))) { add(p); continue; }
    let names = [];
    try { names = fs.readdirSync(p).sort(); } catch (_err) { /* none */ }
    const kids = names.filter(n => fs.existsSync(path.join(p, n, 'replay')));
    if (!kids.length) throw new Error(`${p}: not a run home, nor a folder of run homes`);
    for (const n of names) if (!kids.includes(n) && fs.statSync(path.join(p, n)).isDirectory()) skipped.push(n);
    for (const n of kids) add(path.join(p, n));
  }
  return { homes: [...out.values()].sort((a, b) => (path.basename(a) < path.basename(b) ? -1 : 1)), skipped: [...new Set(skipped)].sort() };
}

const homesOf = paths => scanHomes(paths).homes;

function readArm(paths, { census, alignedOf = null } = {}) {
  const { homes, skipped } = scanHomes(paths);
  return { homes: homes.map(h => readHome(h, { census, alignedOf })), skipped };
}

/**
 * What an arm's input lacks, never dropped silently: [{ kind, detail }] sorted, kinds: error (a home with no replay run),
 * not-a-home (a folder's child with no replay folder), missing-census-day (a run day the census has no legs for),
 * no-cycle-logs (a home with decision times but no trade cycle log), no-decision-times (a day with trade cycle logs
 * but no decision time: its day file lost its records), duplicate-day (two homes on one session day). missing-census-day
 * can't tell a day the census lacks from a quiet session (the census lists only days with legs): it fails closed.
 */
function armProblems(arm) {
  const out = [];
  const homes = arm.homes || [];
  for (const h of homes) {
    if (h.error) out.push({ kind: 'error', detail: `${h.name}: ${h.error}` });
    else if (isObj(h.decisions) && h.decisions.cycles === 0) out.push({ kind: 'no-cycle-logs', detail: `${h.name}: ${h.decisions.times} decision time(s), no trade cycle log` });
    for (const [d, n] of Object.entries(h.cycleDays || {})) if (!((h.decisions && h.decisions.byDay) || {})[d]) out.push({ kind: 'no-decision-times', detail: `${h.name}: ${d}: ${n} trade cycle log(s), no decision time` });
    for (const d of h.missingDays || []) out.push({ kind: 'missing-census-day', detail: `${h.name}: ${d}` });
  }
  for (const n of arm.skipped || []) out.push({ kind: 'not-a-home', detail: `${n}: no replay folder` });
  const byDay = {};
  for (const h of homes) for (const d of h.days || []) (byDay[d] = byDay[d] || []).push(h.name);
  for (const [d, names] of Object.entries(byDay)) if (names.length > 1) out.push({ kind: 'duplicate-day', detail: `${d}: ${[...names].sort().join(', ')}` });
  return out.sort((a, b) => (`${a.kind}|${a.detail}` < `${b.kind}|${b.detail}` ? -1 : 1));
}

/**
 * The R the caught legs' entries banked, each entry once: one fill can catch two adjacent legs of its side (the
 * census's zigzag splits a move a pullback interrupts), and both count as caught, but its R is banked once.
 */
function bankedR(caught) {
  const seen = new Set();
  let r = 0;
  for (const l of caught) {
    const key = `${l.day}|${l.side}|${l.entry && l.entry.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    r += num(l.entry && l.entry.r) || 0;
  }
  return round4(r);
}

const rateOf = (k, n) => (n ? round4(k / n) : null);

/**
 * Counts of one list of legs, the not-served ones left out (their steps served no bar: no miss): covered, caught, R
 * caught over R available (bankedR), uncaught by reason; notServed, and the count and rate with them (withNotServed).
 */
function legTotals(legs) {
  const served = legs.filter(l => !l.notServed);
  const caught = served.filter(l => l.caught);
  const rCaught = bankedR(caught);
  const rAvailable = served.reduce((s, l) => s + (num(l.availableR) || 0), 0);
  const reasons = {};
  for (const l of served.filter(x => !x.caught)) count(reasons, l.reason);
  const all = legs.filter(l => l.caught).length;
  return {
    legs: served.length, caught: caught.length, rate: rateOf(caught.length, served.length), rCaught: round4(rCaught), rAvailable: round4(rAvailable), share: rAvailable > 0 ? round4(rCaught / rAvailable) : null, reasons: sorted(reasons),
    notServed: legs.length - served.length, withNotServed: { legs: legs.length, caught: all, rate: rateOf(all, legs.length) },
  };
}

/** An arm's summary: per day and in total, all legs and the aligned ones, setups by kind and outcome, entries, late. */
function armSummary(arm) {
  const homes = arm.homes;
  const legs = homes.flatMap(h => h.legs);
  const setupsBy = list => {
    const byKind = {};
    for (const s of list) { const k = (byKind[s.kind] = byKind[s.kind] || {}); count(k, s.outcome); }
    return sorted(Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, sorted(v)])));
  };
  const setups = homes.flatMap(h => h.setups);
  const byPath = {};
  for (const s of setups.filter(x => x.path)) { const k = (byPath[s.path] = byPath[s.path] || {}); count(k, s.outcome); }
  const entries = homes.flatMap(h => h.entries);
  const lateBy = {};
  const lateFirst = {};
  for (const r of homes.flatMap(h => h.late.rows)) { count(lateBy, r.kind || 'unknown'); const k = (lateFirst[r.kind || 'unknown'] = lateFirst[r.kind || 'unknown'] || {}); count(k, r.first); }
  const paths = {};
  for (const e of homes.flatMap(h => h.entryCycles)) count(paths, e.path || 'n/a');
  const dec = homes.reduce((s, h) => ({ times: s.times + h.decisions.times, skipped: s.skipped + h.decisions.skipped, cycles: s.cycles + h.decisions.cycles, overran: s.overran + h.decisions.overran, lost: s.lost + h.decisions.lost }), { times: 0, skipped: 0, cycles: 0, overran: 0, lost: 0 });
  const days = {};
  for (const d of [...new Set(homes.flatMap(h => h.days))].sort()) {
    const hs = homes.filter(h => h.days.includes(d));
    const late = {};
    for (const r of hs.flatMap(h => h.late.rows).filter(r => dayOf(r.at) === d)) count(late, r.kind || 'unknown');
    days[d] = { ...legTotals(legs.filter(l => l.day === d)), aligned: legTotals(legs.filter(l => l.day === d && l.aligned)), entries: entries.filter(e => dayOf(e.at) === d).length, late: sorted(late), homes: hs.map(h => h.name).sort() };
  }
  return {
    homes: homes.length, errors: homes.filter(h => h.error).map(h => `${h.name}: ${h.error}`), missingDays: [...new Set(homes.flatMap(h => h.missingDays))].sort(), problems: armProblems(arm),
    days,
    totals: {
      all: legTotals(legs), aligned: legTotals(legs.filter(l => l.aligned)), notRun: homes.reduce((s, h) => s + h.notRun.length, 0),
      entries: { filled: entries.length, onCaughtLeg: entries.filter(e => e.caughtLeg).length, inLeg: entries.filter(e => e.kind === 'in-trend').length, counter: entries.filter(e => e.kind === 'counter').length, none: entries.filter(e => e.kind === 'none').length },
      setups: { n: setups.length, byKind: setupsBy(setups), byPath: sorted(Object.fromEntries(Object.entries(byPath).map(([k, v]) => [k, sorted(v)]))) },
      decisions: { ...dec, overranShare: rateOf(dec.lost, dec.times) },
      late: { total: Object.values(lateBy).reduce((a, b) => a + b, 0), byKind: sorted(lateBy), firstByKind: sorted(Object.fromEntries(Object.entries(lateFirst).map(([k, v]) => [k, sorted(v)]))) },
      entryPaths: sorted(paths),
    },
  };
}

const totalText = t => `${t.caught}/${t.legs} caught (${t.rate === null ? '-' : t.rate}); R caught ${t.rCaught} of ${t.rAvailable} available (${t.share === null ? '-' : t.share}); uncaught by reason ${JSON.stringify(t.reasons)}; not served (no bar, not counted) ${t.notServed}: with them ${t.withNotServed.caught}/${t.withNotServed.legs} (${t.withNotServed.rate === null ? '-' : t.withNotServed.rate})`;

/** An arm's summary as text lines: its problems, totals, then one line per day. */
function armLines(s, name = 'arm') {
  const t = s.totals;
  const L = [
    `== ${name}: ${s.homes} home(s)`, ...s.problems.map(p => `problem: ${p.kind}: ${p.detail}`),
    `legs (all): ${totalText(t.all)}`, `legs (aligned 4h+1h): ${totalText(t.aligned)}`, `census legs the run never stepped (not-run, out of scope): ${t.notRun}`,
    `entries filled ${t.entries.filled}: caught a leg ${t.entries.onCaughtLeg}, in a leg its way ${t.entries.inLeg}, against a leg ${t.entries.counter}, in none ${t.entries.none}`,
    `decision times ${t.decisions.times}: skipped while a cycle ran ${t.decisions.skipped}, cycles that overran their bar ${t.decisions.overran}, bars lost ${t.decisions.lost} (share ${t.decisions.overranShare === null ? '-' : t.decisions.overranShare})`,
    `late refusals ${t.late.total}: ${JSON.stringify(t.late.byKind)}; then first (target / stop / neither / unknown): ${JSON.stringify(t.late.firstByKind)}`,
    `setups listed or fired ${t.setups.n}, by kind and outcome: ${JSON.stringify(t.setups.byKind)}`,
  ];
  if (Object.keys(t.setups.byPath).length) L.push(`setups by prepare path: ${JSON.stringify(t.setups.byPath)}`, `entries by prepare path: ${JSON.stringify(t.entryPaths)}`);
  for (const [d, x] of Object.entries(s.days)) L.push(`  ${d}${x.homes.length > 1 ? ` (${x.homes.length} homes: ${x.homes.join(', ')})` : ''}: ${x.caught}/${x.legs} legs (aligned ${x.aligned.caught}/${x.aligned.legs}), R ${x.rCaught}/${x.rAvailable}, entries ${x.entries}, late ${JSON.stringify(x.late)}`);
  return L;
}

module.exports = { REASONS, SETUP_OUTCOMES, LATE_KINDS, setupKind, reasonOf, setupOutcome, runDirOf, homesOf, scanHomes, readHome, readArm, armProblems, bankedR, legTotals, armSummary, armLines };
