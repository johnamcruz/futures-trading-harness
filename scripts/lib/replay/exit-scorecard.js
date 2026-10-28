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
 * The exit's class, from the exit price P on the bars from the exit on (at most horizonBars), in the trade's R:
 *   cut            price went cutR further the trade's way before going rightR against: the exit cut a trend; leftR the
 *                  most it went the trade's way before that adverse rightR (or the horizon's end)
 *   right          it went rightR against first: the exit was right; savedR the most it went against before cutR the
 *                  trade's way
 *   unclear        both on the same bar (its order inside the bar is unknown)
 *   unresolved     neither within the horizon (or no bars after the exit)
 * late: a hold that gave back more than lateGivebackR of open profit before the exit (peakR - max(r, 0): a loser that
 * never was in profit is not late), whoever exited; givebackR is peakR - r.
 * flip: the model's decision came with the HTF bias flipped against the trade (trade-read.js bias.flipAgainst at the
 * decision bar), tagged so a round can measure whether flip exits cut trends (a mechanical flip exit cost runners in
 * the model-free detection study).
 * The model's tightens: each modify_order of the stop; `stopped` when that stop (the last move before the exit) took the
 * trade out (its class is the exit's), else `held` (the trade went on: a later move, or another exit).
 *
 *   PARAMS                                   config/replay.json exitScore (frozen)
 *   barsClosedBy(bars, ms, stepMs)          the bars closed by ms: a decision's facts read only these (no look-ahead)
 *   classify({ side, price, risk, bars, from, params })   { cls, leftR, savedR } (pure; from: ms, bars sorted)
 *   scoreExits({ trips, moves, closes, bars, stepMs, factsAt, params })   { decisions, tightens } (pure; see the header)
 *   summarize(scored)                        { byExit: { exitBy: { n, cut, right, unclear, unresolved, late, leftR, savedR,
 *                                            givebackR } }, flip, tightens: { n, stopped, held, cut, right } }
 *   factsText(read)                          a decision's facts as words, no date, time or price (the proposer's view)
 *   exitLines(summary)                       the report's "Exit decisions" lines
 *   modelActions(cycles, { toolCalls })      { moves, closes } of the model from the run's cycle logs (their transcripts)
 *   runnerActions(events)                    { moves, closes } of the runner from its event log
 *   tripsOf(days)                            the closed round trips of the run's day records
 */

const PARAMS = require('../tunables').replay().exitScore; // config/replay.json

const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const r2 = x => (num(x) === null ? null : Math.round(x * 100) / 100);
const sign = side => (side === 'short' ? -1 : 1);
const CLASSES = Object.freeze(['cut', 'right', 'unclear', 'unresolved']);
const EXIT_BY = Object.freeze(['model-exit', 'model-stop', 'runner-trail', 'runner-exit', 'initial-stop', 'target']);

/** The class of an exit at `price` from `from` on (see the header). */
function classify({ side, price, risk, bars = [], from, params = PARAMS }) {
  if (num(price) === null || !(num(risk) > 0)) return { cls: 'unresolved', leftR: null, savedR: null };
  const s = sign(side);
  const after = bars.filter(b => Date.parse(b.t) >= from).slice(0, params.horizonBars);
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

/** The last of `list` (by ms) at or before `ms` and after `since`. */
const lastBefore = (list, since, ms) => list.filter(x => x.ms > since && x.ms <= ms).sort((a, b) => a.ms - b.ms).pop() || null;

function scoreExits({ trips = [], moves = [], closes = [], bars = [], stepMs = 0, factsAt = null, params = PARAMS }) {
  const near = params.matchBars * stepMs;
  const decisions = [];
  const tightens = [];
  for (const t of trips) {
    if (!isObj(t) || t.open || num(t.exitMs) === null || num(t.entryMs) === null || !(num(t.risk) > 0)) continue;
    const same = x => !x.contractId || !t.contractId || x.contractId === t.contractId;
    const close = closes.filter(same).filter(c => c.ms >= t.entryMs && Math.abs(c.ms - t.exitMs) <= near).sort((a, b) => Math.abs(a.ms - t.exitMs) - Math.abs(b.ms - t.exitMs))[0] || null;
    const move = lastBefore(moves.filter(same), t.entryMs, t.exitMs);
    const exitBy = close ? (close.by === 'model' ? 'model-exit' : 'runner-exit') : /target/i.test(String(t.reason || '')) ? 'target'
      : move && move.by !== 'plan' ? (move.by === 'model' ? 'model-stop' : 'runner-trail') : 'initial-stop';
    const { cls, leftR, savedR } = classify({ side: t.side, price: t.exitPrice, risk: t.risk, bars, from: t.exitMs, params });
    const peakR = num(t.mfeR);
    const givebackR = peakR !== null && num(t.r) !== null ? r2(peakR - t.r) : null;
    // The decision behind the exit: the model's close or its stop move (their bars), else the exit's own bar.
    const decision = exitBy === 'model-exit' ? close : exitBy === 'model-stop' ? move : null;
    // Its facts at the decision's bar (the exit's, when the model decided none): what the read had to go on.
    const facts = typeof factsAt === 'function' ? factsAt(t, decision ? decision.ms : t.exitMs) : null;
    decisions.push({
      trip: t.id ?? null, side: t.side, exitBy, cls, leftR, savedR, r: num(t.r), peakR, givebackR,
      late: peakR !== null && num(t.r) !== null && peakR - Math.max(t.r, 0) > params.lateGivebackR, at: new Date(t.exitMs).toISOString(),
      ...(decision ? { decidedAt: new Date(decision.ms).toISOString() } : {}),
      flip: decision && facts && isObj(facts.bias) ? facts.bias.flipAgainst === true : null, facts: facts || null,
    });
    for (const m of moves.filter(same).filter(x => x.by === 'model' && x.ms > t.entryMs && x.ms <= t.exitMs)) {
      const stopped = exitBy === 'model-stop' && move === m;
      const f = typeof factsAt === 'function' ? factsAt(t, m.ms) : null;
      tightens.push({ trip: t.id ?? null, side: t.side, at: new Date(m.ms).toISOString(), stopped, cls: stopped ? cls : null, leftR: stopped ? leftR : null, flip: f && isObj(f.bias) ? f.bias.flipAgainst === true : null, facts: f || null });
    }
  }
  return { decisions, tightens };
}

const blank = () => ({ n: 0, cut: 0, right: 0, unclear: 0, unresolved: 0, late: 0, leftR: 0, savedR: 0, givebackR: 0 });
function add(row, d, params = PARAMS) {
  row.n += 1;
  row[d.cls] += 1;
  if (d.cls === 'cut') row.leftR = r2(row.leftR + (d.leftR || 0));
  if (d.cls === 'right') row.savedR = r2(row.savedR + (d.savedR || 0));
  if (d.late) { row.late += 1; row.givebackR = r2(row.givebackR + (d.peakR - Math.max(d.r, 0) - params.lateGivebackR)); }
}

function summarize(scored) {
  const s = isObj(scored) ? scored : {};
  const byExit = {};
  for (const d of Array.isArray(s.decisions) ? s.decisions : []) add(byExit[d.exitBy] || (byExit[d.exitBy] = blank()), d);
  const flip = blank();
  for (const d of (s.decisions || []).filter(x => x.flip === true)) add(flip, d);
  const tl = Array.isArray(s.tightens) ? s.tightens : [];
  const tightens = { n: tl.length, stopped: tl.filter(x => x.stopped).length, held: tl.filter(x => !x.stopped).length, cut: tl.filter(x => x.cls === 'cut').length, right: tl.filter(x => x.cls === 'right').length, flip: tl.filter(x => x.flip === true).length };
  return { byExit, flip, tightens };
}

/** A decision's facts as words: what code read at the decision, no date, time or price. */
function factsText(t) {
  if (!isObj(t) || t.unavailable) return 'facts unavailable';
  const e = t.extreme || {};
  const against = Object.entries(t.against || {}).map(([tf, x]) => `${tf} ${x ? `${x.kind} against` : 'none against'}`).join(', ');
  const d = t.displacement;
  const comp = Object.entries(t.compression || {}).filter(([, x]) => x).map(([tf, x]) => `${tf} ${x.kind}`).join(', ') || 'none';
  const sa = x => (num(x) === null ? 'n/a' : `${x >= 0 ? '+' : ''}${x} ATR`);
  return [
    e.failed ? 'new extreme failed' : e.failed === false ? 'new extreme held' : 'no prior extreme',
    `${(t.pushes || []).length} push(es)${t.fading ? ' fading' : ''}`,
    t.pullback && num(t.pullback.depth) !== null ? `pullback ${Math.round(t.pullback.depth * 100)}% of the impulse` : 'pullback ?',
    `RTH VWAP ${sa(t.vwap && t.vwap.distAtr)}, EMA20 ${sa(t.ema20 && t.ema20.distAtr)}`,
    against,
    d ? `displacement against on ${d.tf}${d.throughSwing ? ' through the last swing' : ''}` : 'no displacement against',
    `compression against ${comp}`,
    t.bias && t.bias.flipAgainst ? 'HTF bias flipped against' : 'HTF bias not flipped against',
  ].join('; ');
}

function exitLines(sum) {
  if (!isObj(sum) || !isObj(sum.byExit)) return [];
  const row = (k, x) => `    ${k}: ${x.n} exit(s): cut a trend ${x.cut} (${x.leftR}R left), right ${x.right} (${x.savedR}R saved), unclear ${x.unclear}, unresolved ${x.unresolved}; late ${x.late} (${x.givebackR}R of open profit given back past the threshold)`;
  const keys = EXIT_BY.filter(k => sum.byExit[k]);
  if (!keys.length && !sum.tightens.n) return [];
  const t = sum.tightens;
  return [
    `  Exit decisions (what price did next: ${PARAMS.cutR}R the trade's way first = cut, ${PARAMS.rightR}R against first = right; late = gave back over ${PARAMS.lateGivebackR}R of open profit):`,
    ...keys.map(k => row(k, sum.byExit[k])),
    ...(sum.flip.n ? [row('with the HTF bias flipped against (model decisions)', sum.flip)] : []),
    `    model stop tightens: ${t.n}: stopped the trade ${t.stopped} (cut ${t.cut}, right ${t.right}), held ${t.held}; with the HTF bias flipped against ${t.flip}`,
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
      if (MODIFY.test(k.name) && num(Number(i.stopPrice)) !== null) moves.push({ ms, by: 'model', to: Number(i.stopPrice), contractId: i.contractId || null });
      else if (EXIT_CALL.test(k.name)) closes.push({ ms, by: 'model', contractId: i.contractId || null });
      else if (PLACE.test(k.name) && /^\s*\[exit\]/i.test(String(i.rationale || '')) && /market|^2$/i.test(String(i.type))) closes.push({ ms, by: 'model', contractId: i.contractId || null });
    }
  }
  return { moves, closes };
}

/** The runner's stop moves (by 'plan': its move to the plan's stop after the fill) and closes, from its event log. */
function runnerActions(events) {
  const list = (Array.isArray(events) ? events : []).filter(e => isObj(e) && Number.isFinite(Date.parse(e.at)));
  return {
    moves: list.filter(e => e.kind === 'stop_moved').map(e => ({ ms: Date.parse(e.at), by: e.why === 'plan stop' ? 'plan' : 'runner', to: num(e.to), contractId: null })),
    closes: list.filter(e => e.kind === 'position_closed').map(e => ({ ms: Date.parse(e.at), by: 'runner', contractId: null })),
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

module.exports = { PARAMS, CLASSES, EXIT_BY, barsClosedBy, classify, scoreExits, summarize, factsText, exitLines, modelActions, runnerActions, tripsOf };
