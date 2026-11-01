'use strict';

/**
 * The exit-decision scorecard (the owner: "the model needs to learn when to ride trend and when to exit"): after a run,
 * every trade's exit and every stop the model tightened, scored by what price did next on the closed bars. Analysis after
 * the run only (post-hoc: the bars after each decision are read here, never in the live path), written into the run's
 * trend-capture document (`exits`) and its report; the round's findings (train/exit-findings.js) give the proposer the
 * classes with the facts code read AT the decision (trade-read.js on the bars closed by then: no look-ahead there).
 *
 * Who exited (exitBy), per round trip:
 *   model-exit     the model closed at market (close_position, partial_close_position, a market [exit]) on a bar within
 *                  matchBars (config) of the exit
 *   runner-exit    the runner closed it (its trail crossed, a time stop: position_closed)
 *   target         the round trip's reason is its target
 *   model-stop     its stop filled, last moved by the model (modify_order)
 *   runner-trail   its stop filled, last moved by the runner's trail (stop_moved)
 *   initial-stop   its stop filled, never moved (or only to the plan's stop after the fill: stop_moved why 'plan stop')
 * The exit's class, from the exit price P on the bars from the exit on (at most horizonBars, and never past the end of the
 * session it exited in: `sessionEnd`), in the trade's R:
 *   cut            price went cutR further the trade's way before going rightR against: the exit cut a trend; leftR the
 *                  most it went the trade's way before that adverse rightR (or the horizon's end)
 *   right          it went rightR against first: the exit was right; savedR the most it went against before cutR the
 *                  trade's way
 *   unclear        both on the same bar (its order inside the bar is unknown)
 *   unresolved     neither within the horizon (or no bars after the exit)
 * late: a hold that gave back more than lateGivebackR of open profit before the exit (peakR - max(r, 0): a loser that
 * never was in profit is not late), whoever exited; givebackR is peakR - r, lateR what it gave back past the threshold.
 * The threshold is never below the runner's own lock (lateThreshold: the active policies' lock_giveback_r, the
 * rulebook's), so the runner's trail giving back what it was built to give back is never late.
 * stop placement: the initial-stop exits that then went cutR the trade's way (summarize): the stop's placement, a row of
 * the report, never an exit decision.
 * flip: the model's decision came with the HTF bias flipped against the trade (trade-read.js bias.flipAgainst at the
 * decision bar), tagged so a round can measure whether flip exits cut trends (a mechanical flip exit cost runners in
 * the model-free detection study).
 * The model's tightens: each modify_order of the stop; `stopped` when that stop (the last move before the exit) took the
 * trade out (its class is the exit's), else `held` (the trade went on: a later move, or another exit).
 * fill (report only: the round report's losers past -1R, train/loss-diagnostics.js), in R on the stop the trade held
 * (trade-basis.js: the runner's move to the plan's stop after the fill, else the bracket's risk; `basis` says which), from
 * its entry: r the trade's R on that basis; stopR the stop working at a stop exit (the last move's price, else the held
 * stop), null for any other exit; openR the open of the bar the exit filled in (null when no bar holds it); priceR the
 * exit's price; tickR one tick (the trip's `tick`), null when its tick is unknown. Nothing scores or screens on them (the
 * decision's own `r` stays the broker's, as the exit screen reads it).
 *
 *   PARAMS                                   config/replay.json exitScore (frozen)
 *   barsClosedBy(bars, ms, stepMs)          the bars closed by ms: a decision's facts read only these (no look-ahead)
 *   classify({ side, price, risk, bars, from, until, params })   { cls, leftR, savedR } (pure; from, until: ms)
 *   sessionEnds(spec)                        ms => the end of the session window holding ms (the runner's sessions spec),
 *                                            ms itself outside every window
 *   lateThreshold(strategies, params)        the late threshold: config's, never below an active policy's lock_giveback_r
 *   scoreExits({ trips, moves, closes, bars, stepMs, factsAt, sessionEnd, orders, runnerKnown, params })   { decisions,
 *                                            tightens, thresholds } (a decision names its trip's root, side and entryAt: the
 *                                            probe screen pairs trades on them, train/screen.js exitTargetTest) (pure;
 *                                            sessionEnd(ms): the session's end, or null; orders:
 *                                            orderId -> contractId, for a move that names only its order; runnerKnown
 *                                            false: the runner's event log wasn't read, so an exit that isn't the model's
 *                                            close or the target is 'unattributed', never guessed an initial stop)
 *   resolveOrders(moves, orders)             the moves each with its order's contract (before two sources merge)
 *   summarize(scored)                        { byExit: { exitBy: { n, cut, right, unclear, unresolved, late, leftR, savedR,
 *                                            givebackR } }, flip, tightens, stopPlacement: { n, of, ranR }, thresholds }
 *   factsText(read)                          a decision's facts as words, no date, time or price (the proposer's view)
 *   exitLines(summary)                       the report's "Exit decisions" lines
 *   modelActions(cycles, { toolCalls })      { moves, closes } of the model from the run's cycle logs (their transcripts)
 *   gateActions(cycles, gateLog, { slackMs })   { moves, closes, orders } of the model from the gateway's records in each
 *                                            cycle's window (a trade-executor in a session of its own included)
 *   mergeActions(...lists)                   the actions once each (the same actor, bar, contract and price twice)
 *   runnerActions(events)                    { moves, closes } of the runner from its event log
 *   tripsOf(days)                            the closed round trips of the run's day records
 */

const PARAMS = require('../tunables').replay().exitScore; // config/replay.json
const { parseWindows, inWindow } = require('../trading/clock');
const { parseStandardName } = require('../broker/translator');
const { familyRoot } = require('../trading/contracts');

const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const r2 = x => (num(x) === null ? null : Math.round(x * 100) / 100);
const r4 = x => (num(x) === null ? null : Math.round(x * 10000) / 10000);
const sign = side => (side === 'short' ? -1 : 1);
const CLASSES = Object.freeze(['cut', 'right', 'unclear', 'unresolved']);
const EXIT_BY = Object.freeze(['model-exit', 'model-stop', 'runner-trail', 'runner-exit', 'initial-stop', 'target', 'unattributed']);
// The exits a stop order filled (fill.stopR known).
const STOP_EXITS = Object.freeze(['model-stop', 'runner-trail', 'initial-stop']);

/** A contract's family root (MNQ for MNQ, NQ, MNQ:2026-12): the one family however a record names the contract. */
const famOf = id => (id ? familyRoot((parseStandardName(String(id)) || { root: String(id).toUpperCase() }).root) : null);

/** The moves with a contract: one that names only its order (modify_order takes no contract) is its order's contract's. */
function resolveOrders(given, orders = new Map()) {
  return (Array.isArray(given) ? given : []).map(m => (m.contractId || m.orderId === undefined || m.orderId === null || !orders.has(String(m.orderId)) ? m : { ...m, contractId: orders.get(String(m.orderId)) }));
}

/** The class of an exit at `price` from `from` on (see the header). */
function classify({ side, price, risk, bars = [], from, until = null, params = PARAMS }) {
  if (num(price) === null || !(num(risk) > 0)) return { cls: 'unresolved', leftR: null, savedR: null };
  const s = sign(side);
  // From the exit on, the horizon's bars, none opening at or past the session's end (unresolved beyond it).
  const after = bars.filter(b => Date.parse(b.t) >= from && (until === null || Date.parse(b.t) < until)).slice(0, params.horizonBars);
  for (const b of after) {
    const f = (s > 0 ? b.h - price : price - b.l) / risk;
    const a = (s > 0 ? price - b.l : b.h - price) / risk;
    const cut = f >= params.cutR;
    const right = a >= params.rightR;
    if (cut && right) return { cls: 'unclear', leftR: null, savedR: null };
    if (cut) {
      // How far it went on the trade's way before the adverse move (or the horizon's end): the R left on the table.
      let best = f;
      for (const c of after.slice(after.indexOf(b))) {
        if ((s > 0 ? price - c.l : c.h - price) / risk >= params.rightR) break;
        best = Math.max(best, (s > 0 ? c.h - price : price - c.l) / risk);
      }
      return { cls: 'cut', leftR: r2(best), savedR: null };
    }
    if (right) {
      let worst = a;
      for (const c of after.slice(after.indexOf(b))) {
        if ((s > 0 ? c.h - price : price - c.l) / risk >= params.cutR) break;
        worst = Math.max(worst, (s > 0 ? price - c.l : c.h - price) / risk);
      }
      return { cls: 'right', leftR: null, savedR: r2(worst) };
    }
  }
  return { cls: 'unresolved', leftR: null, savedR: null };
}

/** The bars closed by `ms` (opened at least a bar before it): what a decision at `ms` could read, never a later one. */
const barsClosedBy = (bars, ms, stepMs) => (Array.isArray(bars) ? bars : []).filter(b => Date.parse(b.t) + stepMs <= ms);

/** The end of the session window holding each moment (a minute's resolution), from a runner sessions spec. */
function sessionEnds(spec) {
  const { windows } = parseWindows(spec);
  return ms => {
    const holds = t => windows.some(w => inWindow(new Date(t), w));
    if (!holds(ms)) return ms;
    // Minute by minute (the windows' resolution) to the first minute outside, within a day.
    const last = ms + 24 * 3600000;
    let t = ms - (ms % 60000);
    while (t < last && holds(t)) t += 60000;
    return t;
  };
}

/** The late threshold: the config's, never below an active policy's lock_giveback_r (its rulebook's exit). */
function lateThreshold(strategies, params = PARAMS) {
  const locks = (Array.isArray(strategies) ? strategies : []).filter(x => isObj(x) && x.valid && x.status === 'active' && isObj(x.exit))
    .map(x => num(x.exit.lock_giveback_r)).filter(x => x !== null);
  return Math.max(params.lateGivebackR, ...locks);
}

/**
 * A scored exit's fill facts in R (see the header): the stop working at a stop exit, the exit bar's open, the exit's
 * price, one tick. Pure; null where a price, the bar or the tick is unknown.
 */
function fillOf(t, { exitBy, move, bars, stepMs, plan = null }) {
  const s = sign(t.side);
  // The held stop's risk: the runner's move to the plan's stop after the fill (trade-basis.js onHeldStop), else the bracket's.
  const held = plan && num(plan.to) !== null && num(t.entry) !== null ? s * (t.entry - plan.to) : null;
  const unit = held !== null && held > 0 ? held : t.risk;
  const inR = px => (num(px) === null || num(t.entry) === null ? null : r4((s * (px - t.entry)) / unit));
  const stop = !STOP_EXITS.includes(exitBy) ? null : move ? num(move.to) : num(t.entry) === null ? null : t.entry - s * unit;
  const bar = stepMs > 0 ? (Array.isArray(bars) ? bars : []).find(b => { const bt = Date.parse(b.t); return bt <= t.exitMs && t.exitMs < bt + stepMs; }) : null;
  return {
    basis: unit === t.risk ? 'bracket stop' : 'held stop', r: num(t.r) === null ? null : r4((t.r * t.risk) / unit),
    stopR: inR(stop), openR: bar ? inR(bar.o) : null, priceR: inR(t.exitPrice), tickR: num(t.tick) > 0 ? r4(t.tick / unit) : null,
  };
}

/** The last of `list` (by ms) at or before `ms` and after `since`. */
const lastBefore = (list, since, ms) => list.filter(x => x.ms > since && x.ms <= ms).sort((a, b) => a.ms - b.ms).pop() || null;

function scoreExits({ trips = [], moves: given = [], closes = [], bars = [], stepMs = 0, factsAt = null, sessionEnd = null, orders = new Map(), runnerKnown = true, params = PARAMS }) {
  const near = params.matchBars * stepMs;
  const moves = resolveOrders(given, orders);
  const decisions = [];
  const tightens = [];
  for (const t of trips) {
    if (!isObj(t) || t.open || num(t.exitMs) === null || num(t.entryMs) === null || !(num(t.risk) > 0)) continue;
    const same = x => !x.contractId || !t.contractId || famOf(x.contractId) === famOf(t.contractId);
    const close = closes.filter(same).filter(c => c.ms >= t.entryMs && Math.abs(c.ms - t.exitMs) <= near).sort((a, b) => Math.abs(a.ms - t.exitMs) - Math.abs(b.ms - t.exitMs))[0] || null;
    const move = lastBefore(moves.filter(same), t.entryMs, t.exitMs);
    const exitBy = close ? (close.by === 'model' ? 'model-exit' : 'runner-exit') : /target/i.test(String(t.reason || '')) ? 'target'
      : !runnerKnown ? 'unattributed' : move && move.by !== 'plan' ? (move.by === 'model' ? 'model-stop' : 'runner-trail') : 'initial-stop';
    const until = typeof sessionEnd === 'function' ? sessionEnd(t.exitMs) : null;
    const { cls, leftR, savedR } = classify({ side: t.side, price: t.exitPrice, risk: t.risk, bars, from: t.exitMs, until, params });
    const peakR = num(t.mfeR);
    const givebackR = peakR !== null && num(t.r) !== null ? r2(peakR - t.r) : null;
    // The decision behind the exit: the model's close or its stop move (their bars), else the exit's own bar.
    const decision = exitBy === 'model-exit' ? close : exitBy === 'model-stop' ? move : null;
    // Its facts at the decision's bar (the exit's, when the model decided none): what the read had to go on.
    const facts = typeof factsAt === 'function' ? factsAt(t, decision ? decision.ms : t.exitMs) : null;
    const handed = peakR !== null && num(t.r) !== null ? peakR - Math.max(t.r, 0) : null;
    const late = handed !== null && handed > params.lateGivebackR;
    decisions.push({
      trip: t.id ?? null, root: famOf(t.contractId), side: t.side, entryAt: new Date(t.entryMs).toISOString(), exitBy, cls, leftR, savedR, r: num(t.r), peakR, givebackR,
      late, ...(late ? { lateR: r2(handed - params.lateGivebackR) } : {}), at: new Date(t.exitMs).toISOString(),
      fill: fillOf(t, { exitBy, move, bars, stepMs, plan: moves.filter(same).filter(m => m.by === 'plan' && m.ms >= t.entryMs && m.ms <= t.exitMs).sort((a, b) => a.ms - b.ms)[0] || null }),
      ...(decision ? { decidedAt: new Date(decision.ms).toISOString() } : {}),
      flip: decision && facts && isObj(facts.bias) ? facts.bias.flipAgainst === true : null, facts: facts || null,
    });
    for (const m of moves.filter(same).filter(x => x.by === 'model' && x.ms > t.entryMs && x.ms <= t.exitMs)) {
      const stopped = exitBy === 'model-stop' && move === m;
      const f = typeof factsAt === 'function' ? factsAt(t, m.ms) : null;
      tightens.push({ trip: t.id ?? null, side: t.side, at: new Date(m.ms).toISOString(), stopped, cls: stopped ? cls : null, leftR: stopped ? leftR : null, flip: f && isObj(f.bias) ? f.bias.flipAgainst === true : null, facts: f || null });
    }
  }
  return { decisions, tightens, thresholds: { cutR: params.cutR, rightR: params.rightR, lateGivebackR: params.lateGivebackR, horizonBars: params.horizonBars } };
}

const blank = () => ({ n: 0, cut: 0, right: 0, unclear: 0, unresolved: 0, late: 0, leftR: 0, savedR: 0, givebackR: 0 });
function add(row, d) {
  row.n += 1;
  row[d.cls] += 1;
  if (d.cls === 'cut') row.leftR = r2(row.leftR + (d.leftR || 0));
  if (d.cls === 'right') row.savedR = r2(row.savedR + (d.savedR || 0));
  if (d.late) { row.late += 1; row.givebackR = r2(row.givebackR + (d.lateR || 0)); }
}

function summarize(scored) {
  const s = isObj(scored) ? scored : {};
  const byExit = {};
  for (const d of Array.isArray(s.decisions) ? s.decisions : []) add(byExit[d.exitBy] || (byExit[d.exitBy] = blank()), d);
  const flip = blank();
  for (const d of (s.decisions || []).filter(x => x.flip === true)) add(flip, d);
  const tl = Array.isArray(s.tightens) ? s.tightens : [];
  const tightens = { n: tl.length, stopped: tl.filter(x => x.stopped).length, held: tl.filter(x => !x.stopped).length, cut: tl.filter(x => x.cls === 'cut').length, right: tl.filter(x => x.cls === 'right').length, flip: tl.filter(x => x.flip === true).length };
  // The initial stops that then ran the trade's way: the stop's placement, never an exit decision.
  const init = byExit['initial-stop'] || blank();
  const stopPlacement = { n: init.cut, of: init.n, ranR: init.leftR };
  return { byExit, flip, tightens, stopPlacement, thresholds: isObj(s.thresholds) ? s.thresholds : null };
}

/** A decision's facts as words: what code read at the decision, no date, time or price. */
function factsText(t) {
  if (!isObj(t) || t.unavailable) return 'facts unavailable';
  const against = Object.entries(t.against || {}).map(([tf, x]) => `${tf} ${x ? `${x.kind} against` : 'none against'}`).join(', ');
  const d = t.displacement;
  const comp = Object.entries(t.compression || {}).filter(([, x]) => x).map(([tf, x]) => `${tf} ${x.kind}`).join(', ') || 'none';
  const sa = x => (num(x) === null ? 'n/a' : `${x >= 0 ? '+' : ''}${x} ATR`);
  return [
    t.failed ? 'the last push failed (a lower high or higher low)' : t.failed === false ? 'the last push made a new extreme' : 'under two pushes',
    `${(t.pushes || []).length} push(es)${t.fading ? ' fading' : ''}`,
    t.pullback && num(t.pullback.depth) !== null ? `pullback ${Math.round(t.pullback.depth * 100)}% of the impulse` : 'pullback ?',
    `RTH VWAP ${sa(t.vwap && t.vwap.distAtr)}, EMA20 ${sa(t.ema20 && t.ema20.distAtr)}`,
    against,
    d ? `displacement against on ${d.tf} through the last swing` : 'no displacement against',
    `compression against ${comp}`,
    t.bias && t.bias.flipAgainst ? 'HTF bias flipped against' : 'HTF bias not flipped against',
    `weakening signs ${(t.signs || []).length}${(t.signs || []).length ? ` (${t.signs.join(', ')})` : ''}`,
    `reversal ${t.reversal || 'none'}`,
  ].join('; ');
}

function exitLines(sum) {
  if (!isObj(sum) || !isObj(sum.byExit)) return [];
  const row = (k, x) => `    ${k}: ${x.n} exit(s): cut a trend ${x.cut} (${x.leftR}R left), right ${x.right} (${x.savedR}R saved), unclear ${x.unclear}, unresolved ${x.unresolved}; late ${x.late} (${x.givebackR}R of open profit given back past the threshold)`;
  const keys = EXIT_BY.filter(k => sum.byExit[k]);
  if (!keys.length && !sum.tightens.n) return [];
  const t = sum.tightens;
  const th = sum.thresholds || PARAMS;
  const sp = sum.stopPlacement;
  return [
    `  Exit decisions (what price did next, to the session's end: ${th.cutR}R the trade's way first = cut, ${th.rightR}R against first = right; late = gave back over ${th.lateGivebackR}R of open profit):`,
    ...keys.map(k => row(k, sum.byExit[k])),
    ...(sum.flip.n ? [row('with the HTF bias flipped against (model decisions)', sum.flip)] : []),
    `    model stop tightens: ${t.n}: stopped the trade ${t.stopped} (cut ${t.cut}, right ${t.right}), held ${t.held}; with the HTF bias flipped against ${t.flip}`,
    ...(sp && sp.of ? [`    stop placement (the initial stop, not an exit decision): ${sp.n} of ${sp.of} initial-stop exits then ran ${th.cutR}R the trade's way (${sp.ranR}R)`] : []),
  ];
}

const EXIT_CALL = /__(close_position|partial_close_position)$/;
const MODIFY = /__modify_order$/;
const PLACE = /__place_order$/;

/** The model's stop moves and market exits, from each cycle's transcript, at its bar's close. */
function modelActions(cycles, { toolCalls }) {
  const moves = [];
  const closes = [];
  for (const c of Array.isArray(cycles) ? cycles : []) {
    const ms = isObj(c) && isObj(c.timing) ? Date.parse(c.timing.barClose) : NaN;
    if (!Number.isFinite(ms) || typeof c.transcript !== 'string') continue;
    let calls;
    try { calls = toolCalls(c.transcript); } catch (_err) { continue; }
    for (const k of calls.filter(x => !x.failed && !x.stopped)) {
      const i = k.input || {};
      if (MODIFY.test(k.name) && num(Number(i.stopPrice)) !== null) moves.push({ ms, by: 'model', to: Number(i.stopPrice), contractId: i.contractId || null, orderId: i.orderId ?? null });
      else if (EXIT_CALL.test(k.name)) closes.push({ ms, by: 'model', contractId: i.contractId || null });
      else if (PLACE.test(k.name) && /^\s*\[exit\]/i.test(String(i.rationale || '')) && /market|^2$/i.test(String(i.type))) closes.push({ ms, by: 'model', contractId: i.contractId || null });
    }
  }
  return { moves, closes };
}

/**
 * The model's stop moves and market exits from the gateway's records (the gate log: every order call it passed), in each
 * cycle's wall-clock window (its start to its end plus slackMs), at the cycle's bar close: the trade-executor's calls in a
 * session of its own too, which the head trader's transcript never shows. A window ends at the next cycle's start (a
 * record there is that cycle's). `toolCalls`: a cycle's transcript tells a close the broker refused (the gateway logs a
 * close before forwarding it): such a logged close is not an exit. `orders`: each order id the records name, with
 * its contract (the gateway resolves a modify_order's contract from the open orders).
 */
function gateActions(cycles, gateLog, { slackMs = 0, toolCalls = null } = {}) {
  const moves = [];
  const closes = [];
  const orders = new Map();
  const recs = (Array.isArray(gateLog) ? gateLog : []).filter(e => isObj(e) && e.source === 'gateway' && e.decision === 'allowed').map(e => ({ ...e, ms: Date.parse(e.ts) }));
  for (const e of recs) if (e.orderId !== undefined && e.orderId !== null && e.contractId) orders.set(String(e.orderId), e.contractId);
  const starts = (Array.isArray(cycles) ? cycles : []).map(c => (isObj(c) ? Date.parse(c.at) : NaN)).filter(Number.isFinite).sort((a, b) => a - b);
  for (const c of Array.isArray(cycles) ? cycles : []) {
    const ms = isObj(c) && isObj(c.timing) ? Date.parse(c.timing.barClose) : NaN;
    const from = isObj(c) ? Date.parse(c.at) : NaN;
    if (!Number.isFinite(ms) || !Number.isFinite(from)) continue;
    const to = from + (num(c.durationMs) || 0) + slackMs;
    const nextAt = starts.find(x => x > from);
    // The close calls this cycle's transcript shows failed: one logged close each is dropped (same contract family).
    let refused = [];
    if (typeof toolCalls === 'function' && typeof c.transcript === 'string') {
      try { refused = toolCalls(c.transcript).filter(k => k.failed && EXIT_CALL.test(k.name)).map(k => (k.input || {}).contractId || null); } catch (_err) { refused = []; }
    }
    for (const e of recs.filter(x => x.ms >= from && x.ms <= to && (nextAt === undefined || x.ms < nextAt))) {
      const tool = String(e.tool || '');
      if (/(?:^|__)(close_position|partial_close_position)$/.test(tool)) {
        const j = refused.findIndex(id => !id || !e.contractId || famOf(id) === famOf(e.contractId));
        if (j >= 0) { refused.splice(j, 1); continue; }
      }
      if (/modify_order$/.test(tool) && num(Number(e.stopPrice)) !== null) moves.push({ ms, by: 'model', to: Number(e.stopPrice), contractId: e.contractId || null, orderId: e.orderId ?? null });
      else if (/(?:^|__)(close_position|partial_close_position)$/.test(tool)) closes.push({ ms, by: 'model', contractId: e.contractId || null });
      else if (/place_order$/.test(tool) && /^\s*\[exit\]/i.test(String(e.rationale || '')) && /market|^2$/i.test(String(e.type))) closes.push({ ms, by: 'model', contractId: e.contractId || null });
    }
  }
  return { moves, closes, orders };
}

/** The actions once each: the same actor, bar, contract and price from two sources (a transcript and the gate log). */
function mergeActions(...lists) {
  const seen = new Set();
  return lists.flat().filter(a => {
    const k = [a.by, a.ms, famOf(a.contractId) || '', a.to ?? ''].join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The runner's stop moves (by 'plan': its move to the plan's stop after the fill) and closes, from its event log. */
function runnerActions(events) {
  const list = (Array.isArray(events) ? events : []).filter(e => isObj(e) && Number.isFinite(Date.parse(e.at)));
  return {
    moves: list.filter(e => e.kind === 'stop_moved').map(e => ({ ms: Date.parse(e.at), by: e.why === 'plan stop' ? 'plan' : 'runner', to: num(e.to), contractId: e.contractId || null })),
    closes: list.filter(e => e.kind === 'position_closed').map(e => ({ ms: Date.parse(e.at), by: 'runner', contractId: e.contractId || null })),
  };
}

/** The closed round trips of the run's day records ({ day: [record] }), once each. */
function tripsOf(days) {
  const seen = new Map();
  for (const recs of Object.values(isObj(days) ? days : {})) {
    for (const rec of Array.isArray(recs) ? recs : []) {
      for (const f of isObj(rec) && Array.isArray(rec.trades) ? rec.trades : []) {
        const rt = isObj(f.roundTrip) ? f.roundTrip : null;
        if (!rt || seen.has(rt.id)) continue;
        seen.set(rt.id, {
          id: rt.id, contractId: rt.contractId || null, side: rt.direction === 'short' ? 'short' : 'long', open: rt.open === true,
          entry: num(rt.averageEntryPrice) ?? num(rt.entryPrice), entryMs: Date.parse(rt.entryTime), exitMs: Date.parse(rt.exitTime),
          exitPrice: num(rt.averageExitPrice) ?? num(rt.exitPrice), risk: num(rt.risk), r: num(rt.r), mfeR: num(rt.mfeR), reason: rt.reason || null,
        });
      }
    }
  }
  return [...seen.values()];
}

module.exports = { PARAMS, CLASSES, EXIT_BY, STOP_EXITS, famOf, fillOf, resolveOrders, barsClosedBy, classify, sessionEnds, lateThreshold, scoreExits, summarize, factsText, exitLines, modelActions, gateActions, mergeActions, runnerActions, tripsOf };
