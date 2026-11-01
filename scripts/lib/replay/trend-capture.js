'use strict';

/**
 * Trend capture (the owner: "when the trend runs we know why it was missed"): after a run, every intraday trend leg in
 * its sessions and whether the model caught it, and for every leg it didn't, the blocker chain: one line per decision
 * cycle in the leg's first part, with the first blocker by flow step. Analysis after the run only: built from the run's
 * served bars, cycle logs, compose records, entry records, gate log and fills, written to the run's folder
 * (trend-capture.json, and a section of report.md); never shown to the model (it reads outcomes: what the market did).
 *
 * The legs (legsOf, the detector DETECTOR): a zigzag on the base bars inside the run's sessions, day by day; a leg ends
 * when price turns back by the threshold from its extreme, and counts when its move is the threshold or more. The
 * threshold is minMoveAtr (config/replay.json trendCapture) times the session's own scale: the mean true range of its
 * in-session base bars. A leg is caught when an entry the leg's way placed in its first catchShare (config) of time
 * filled, or one placed before the leg's start filled in that span (the fill, not the order, is what caught it). A trade's
 * R, peak and risk are on the stop it held (trade-basis.js: the runner's move to the plan's stop after the fill), and a
 * leg's available R on that stop when a trade was taken in it (else the planned stop; else the run's, estimated).
 *
 * Each cycle's first blocker (classifyCycle), by: compose_check | gate | phase2 | executor | head | rule; step one of
 * FLOW_STEPS (composed-reads.js, shared with the refusal hints), null when nothing was planned:
 *   no-plan          no compose call the leg's way; the cycle result's reason
 *   compose refused  the failing step(s) of the leg's way's records (compose-hints.js failingSteps) and the check's message
 *   phase-2 veto     its VERDICT line (risk); min-contracts: the sizing floor (risk)
 *   late-entry       the plan's entry missed, with movedR (execution)
 *   gate refusal     the gate's tag (execution); executor abort (execution); an order not filled (execution)
 *   rule             opening print, a loss streak, the soft daily stop, news, the trend rule (the cycle result says so)
 *   position-open    a position already held; head-pass: an OK record the head trader passed on
 *   outside-session  no trade cycle on that bar
 * records: the compose records of the cycle's bar (any side; the leg's way's are read). The leg's blocker: the cycle that came closest to an entry (the furthest stage: no plan, rule, compose, risk,
 * execution), the latest among equals, with how many cycles it blocked.
 *
 * The exit decisions (exit-scorecard.js, `exits`): each round trip's exit (who exited) and each stop the model tightened,
 * scored by what price did next (cut a trend, right, unclear, unresolved; late), with the facts at each model decision.
 *
 * The catch and the ride (trend-ride.js): each leg's size (its points over its threshold, bucketed), each caught leg's
 * ride (entry lag, capture and ride share, peak and giveback R), the run's filled entries (in-trend, counter or none,
 * with their R: `entries`), and totals.ride, the run's catch & ride totals.
 *
 *   FLOW_STEPS, DETECTOR, FILE
 *   legsOf(bars, { session, minMoveAtr })    [{ day, side, start, end, from, to, points, pct, scale }] (pure; session:
 *                                            a runner session spec, '09:30-12:00@America/New_York'; bars sorted, base tf)
 *   classifyCycle(cycle, { side, records, gate })   { bar, planned, side, step, by, code, message, reads, role }
 *   captureReport({ runDir, home, days, manifest, legs, context })   the trend-capture document (see writeCapture); legs: given
 *                                            ones (the census's, for a stepped-windows run) instead of the detector's
 *   cyclesOf(home)                            the run home's trade and manage cycle logs (the trend facts read them too)
 *   writeCapture(runDir, doc), readCapture(runDir)   trend-capture.json in the run's folder
 *   reportLines(doc)                          its text lines, for the replay report
 * The follow-up for training (the learning loop's findings): a census of these legs over practice-train, split by
 * session date, read with readCapture; not built here.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FLOW_STEPS } = require('../trading/composed-reads');
const { failingSteps } = require('../trading/compose-hints');
const { parseWindows, inWindow, tradingDayKey, SESSION_DEFAULTS, MARKET_TZ } = require('../trading/clock');
const TR = require('./trend-ride');
const ES = require('./exit-scorecard');
const TB = require('./trade-basis');

const TUN = require('../tunables').replay().trendCapture; // config/replay.json
const DETECTOR = 'zigzag-session-tr-v1';
const FILE = 'trend-capture.json';
const STAGE = ['outside-session', 'no-plan', 'rule', 'position-open', 'compose', 'risk', 'execution'];
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const round2 = x => (num(x) === null ? null : Math.round(x * 100) / 100);
const readLines = file => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch (_err) { return []; } }); } catch (_err) { return []; } };
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_err) { return null; } };
const ET = new Intl.DateTimeFormat('en-US', { timeZone: MARKET_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const hhmm = t => ET.format(new Date(t));
const median = xs => { const s = xs.filter(x => num(x) !== null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

/** The legs of the base bars inside the session (see the header). Pure. */
function legsOf(bars, { session, minMoveAtr = TUN.minMoveAtr } = {}) {
  const { windows } = parseWindows(session);
  const list = (Array.isArray(bars) ? bars : []).filter(b => isObj(b) && Number.isFinite(Date.parse(b.t)) && [b.h, b.l, b.c].every(x => num(x) !== null));
  const byDay = new Map();
  list.forEach((b, i) => {
    const at = new Date(Date.parse(b.t));
    if (!windows.length || !windows.some(w => inWindow(at, w))) return;
    const prev = list[i - 1];
    const tr = prev ? Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c)) : b.h - b.l;
    const day = tradingDayKey(at);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ ...b, tr });
  });
  const out = [];
  for (const [day, bs] of [...byDay.entries()].sort()) {
    const scale = bs.reduce((a, b) => a + b.tr, 0) / bs.length;
    const min = minMoveAtr * scale;
    if (!(min > 0) || bs.length <= 1) continue;
    const legs = [];
    let dir = 0;
    let start = 0;
    let ext = 0;
    const push = (d, s, e, open) => legs.push({ dir: d, s, e, from: d > 0 ? bs[s].l : bs[s].h, to: d > 0 ? bs[e].h : bs[e].l, open });
    for (let i = 1; i < bs.length; i += 1) {
      if (dir >= 0 && bs[i].h > bs[dir ? ext : start].h) { dir = dir || 1; ext = i; }
      if (dir <= 0 && bs[i].l < bs[dir ? ext : start].l) { dir = dir || -1; ext = i; }
      if (dir > 0 && bs[ext].h - bs[i].l >= min) { push(1, start, ext, false); start = ext; ext = i; dir = -1; } else if (dir < 0 && bs[i].h - bs[ext].l >= min) { push(-1, start, ext, false); start = ext; ext = i; dir = 1; }
    }
    if (dir) push(dir, start, ext, true);
    for (const g of legs.filter(x => x.e > x.s && Math.abs(x.to - x.from) >= min)) {
      const points = Math.abs(g.to - g.from);
      out.push({ day, side: g.dir > 0 ? 'long' : 'short', start: bs[g.s].t, end: bs[g.e].t, from: g.from, to: g.to, points: round2(points), pct: round2((points / g.from) * 100), scale: round2(scale), open: g.open });
    }
  }
  return out;
}

// The rules that block an entry by name in the cycle result (the gate's clock and the account's stops, as the head says).
const RULES = [
  ['news', /news blackout|in blackout/i], ['loss-streak', /loss streak|consecutive loss|cooldown/i], ['daily-stop', /daily (loss )?stop|soft (daily )?stop|stopped for the day/i],
  ['opening-print', /opening[- ]print/i], ['window', /entries not allowed|no entries in the|window allows no entries/i],
];

/** One cycle's first blocker the leg's way (see the header). */
function classifyCycle(cycle, { side, records = [], gate = [] } = {}) {
  const bar = isObj(cycle.timing) ? cycle.timing.barClose || null : null;
  const result = String(cycle.result || '').replace(/^CYCLE RESULT:\s*/i, '');
  // The compose records on this cycle's bar the leg's way, in the order written (the cycle log's list can miss some).
  const mine = (Array.isArray(records) ? records : []).filter(r => isObj(r) && r.side === side);
  const ok = mine.filter(c => c.ok);
  const line = (step, by, code, message, extra = {}) => ({ bar, planned: mine.length > 0, side, step, by, code, message: String(message || '').slice(0, TUN.messageChars), reads: [], role: null, ...extra });
  const entry = isObj(cycle.entry) && ok.some(c => c.id === cycle.entry.record) ? cycle.entry : null;
  if (/^managed\b/i.test(result) || cycle.action === 'manage') return line(null, 'head', 'position-open', result);
  if (entry) {
    const why = String(entry.why || '');
    if (entry.outcome === 'executed') return line('execution', 'executor', 'entered', `order placed: ${entry.record}`, { role: 'trade-executor', record: entry.record });
    if (entry.outcome === 'late') return line('execution', 'gate', 'late-entry', why, { movedR: isObj(entry.late) ? num(entry.late.movedR) : null, role: null });
    if (entry.outcome === 'vetoed') return line('risk', 'phase2', /min[-_ ]contracts|floor/i.test(why) ? 'min-contracts' : /VERDICT:\s*VETO/i.test(why) ? 'veto' : 'verdict-unread', why, { role: 'risk-manager' });
    if (entry.outcome === 'blocked') return line('execution', 'executor', /ABORTED/.test(why) ? 'executor-abort' : 'blocked', why, { role: 'trade-executor' });
  }
  const refused = gate.find(g => ok.some(c => String(g.rationale || '').includes(c.id)));
  if (refused) return line('execution', 'gate', ((refused.violations || [])[0] || {}).check || 'refused', (refused.violations || []).map(v => v.message || v.check).join('; '));
  if (ok.length) return line('risk', 'head', 'head-pass', result, { role: 'head trader' });
  if (mine.length) {
    // The leg's way's refused records this cycle: the first failing flow step of the last one, its message and reads.
    const rec = mine[mine.length - 1];
    const fail = rec ? failingSteps({ reads: rec.reads || [], missingSteps: (rec.problems || []).flatMap(p => ((/^steps not stated: ([a-z, ]+)/.exec(p) || [])[1] || '').split(', ').filter(Boolean)), problems: rec.problems || [] }, { problems: rec.problems || [] }) : {};
    const step = FLOW_STEPS.find(s => fail[s]) || null;
    const reads = rec ? (rec.reads || []).map(r => ({ step: r.step, read: r.read, skill: r.skill, verified: r.check === true })) : [];
    const bad = rec ? (rec.reads || []).find(r => r.step === step && r.check !== true) : null;
    const message = rec ? (bad ? `${bad.read}: ${bad.fact}` : (rec.problems || [])[0] || 'refused') : 'refused';
    return line(step, 'compose_check', step ? `${step}:${fail[step].join('+')}` : 'refused', message, { reads, role: 'head trader' });
  }
  const rule = RULES.find(([, re]) => re.test(result));
  if (rule) return line(null, 'rule', rule[0], result);
  return line(null, 'head', 'no-plan', result, { role: 'head trader' });
}

/** The cycle logs of a run home: [{ ...cycle }] for trade cycles, by bar close. */
function cyclesOf(home) {
  const dir = path.join(home, 'logs', 'cycles');
  let days = [];
  try { days = fs.readdirSync(dir).sort(); } catch (_err) { /* none */ }
  return days.flatMap(d => { let fs2 = []; try { fs2 = fs.readdirSync(path.join(dir, d)).filter(f => f.endsWith('.json')).sort(); } catch (_err) { /* none */ } return fs2.map(f => readJson(path.join(dir, d, f))).filter(c => isObj(c) && isObj(c.timing) && c.timing.barClose); });
}

/** The run's served base bars (the record dir's bars archive), by time. */
function servedBars(runDir, minutes) {
  const { readArchive } = require('../session/bars-archive');
  const byT = new Map();
  let names = [];
  try { names = fs.readdirSync(runDir).filter(n => /^bars-\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(n)).sort(); } catch (_err) { /* none */ }
  for (const n of names) for (const x of readArchive(path.join(runDir, n))) if (x && x.minutes === minutes && isObj(x.bar) && !byT.has(x.bar.t)) byT.set(x.bar.t, x.bar);
  return [...byT.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

/**
 * A given leg ({ day, side, start, end, points }, the census's) as legsOf's: from the start bar's low (a long) or high
 * (a short) when that bar was served, its other end the move's points away; else no prices (its available R unknown).
 */
function givenLeg(g, bars) {
  const b = bars.find(x => x.t === g.start);
  const from = num(g.from) !== null ? g.from : b ? (g.side === 'long' ? b.l : b.h) : null;
  const to = num(g.to) !== null ? g.to : from !== null && num(g.points) !== null ? from + (g.side === 'long' ? g.points : -g.points) : null;
  return { day: g.day, side: g.side, start: g.start, end: g.end, from, to, points: num(g.points), pct: from ? round2((Math.abs(to - from) / from) * 100) : null, scale: num(g.scale) };
}

/**
 * The run's exit decisions (exit-scorecard.js): every round trip's exit and every stop the model tightened, scored by
 * what price did next, each model decision with the facts code read at its bar (trade-read.js on the bars closed by then).
 * The model's actions from the cycle logs' transcripts, the runner's from its event log (<home>/logs/events-*.jsonl).
 */
function exitsOf({ home, days, bars, minutes, cycles, session, broker = '' }) {
  const { toolCalls } = require('../cycle-log');
  const { tradeRead } = require('../trading/trade-read');
  const { loadStrategies } = require('../trading/strategies');
  const logs = path.join(home, 'logs');
  let names = [];
  try { names = fs.readdirSync(logs).filter(n => /^events-.*\.jsonl$/.test(n)).sort(); } catch (_err) { /* unreadable: the runner's events are unknown */ }
  const events = names.flatMap(n => readLines(path.join(logs, n)));
  // With no runner events read (an unreadable logs folder too), a trail's moves and closes are unseen: an exit that isn't
  // the model's close or the target can't be told from the initial stop (scoreExits runnerKnown).
  const runnerKnown = events.length > 0;
  // One contract name across the records: a broker's own id (the gateway logs the client's) as its standard root.
  const { standardRoot } = require('../broker/translator');
  const cacheFiles = broker ? require('../broker/config').contractsCacheFiles(broker, { FTH_HOME: home }) : [];
  const canon = id => (id ? cacheFiles.map(f => standardRoot(id, f)).find(Boolean) || id : id);
  const canonAll = list => list.map(a => (a.contractId ? { ...a, contractId: canon(a.contractId) } : a));
  // The model's actions from its transcripts and from the gateway's records (a trade-executor's own session too).
  const raw = ES.gateActions(cycles, readLines(path.join(logs, 'gate-log.jsonl')), { slackMs: require('../tunables').runner().session.gateSlackMs, toolCalls });
  const gated = { moves: canonAll(raw.moves), closes: canonAll(raw.closes), orders: new Map([...raw.orders].map(([k, v]) => [k, canon(v)])) };
  const fromCalls = { ...ES.modelActions(cycles, { toolCalls }) };
  fromCalls.moves = canonAll(fromCalls.moves);
  fromCalls.closes = canonAll(fromCalls.closes);
  // A transcript's modify_order names only its order: its contract first (the gateway's record names it), then merged once.
  const model = { moves: ES.mergeActions(gated.moves, ES.resolveOrders(fromCalls.moves, gated.orders)), closes: ES.mergeActions(gated.closes, fromCalls.closes) };
  const runner = ES.runnerActions(events);
  // The late threshold is never below the runner's own lock (the active policies' rulebook lock_giveback_r).
  let strategies = [];
  try { strategies = loadStrategies(path.resolve(__dirname, '..', '..', '..'), {}).strategies; } catch (_err) { /* the config's alone */ }
  const params = { ...ES.PARAMS, lateGivebackR: ES.lateThreshold(strategies) };
  const stepMs = (minutes || 0) * 60000;
  const factsAt = (t, ms) => {
    try {
      return tradeRead({ side: t.side, entry: t.entry, openedAt: new Date(t.entryMs).toISOString(), bars: ES.barsClosedBy(bars, ms, stepMs), base: minutes, tick: require('../trading/contracts').tickOf(t.contractId) });
    } catch (err) {
      return { unavailable: err.message };
    }
  };
  // Each trip's tick (its contract's), for the fill facts in R (report only); unknown: none.
  const tickOf = id => { try { return require('../trading/contracts').tickOf(id); } catch (_err) { return null; } };
  const scored = ES.scoreExits({ trips: ES.tripsOf(days).map(t => ({ ...t, contractId: canon(t.contractId), tick: tickOf(canon(t.contractId)) })), moves: [...model.moves, ...canonAll(runner.moves)], closes: [...model.closes, ...canonAll(runner.closes)], bars, stepMs, factsAt, sessionEnd: ES.sessionEnds(session), orders: gated.orders, runnerKnown, params });
  return { ...scored, totals: ES.summarize(scored) };
}

const stageOf = c => STAGE.indexOf(c.code === 'outside-session' ? 'outside-session' : c.by === 'rule' ? 'rule' : c.code === 'position-open' ? 'position-open' : c.by === 'compose_check' ? 'compose' : c.step === 'risk' ? 'risk' : c.step === 'execution' ? 'execution' : 'no-plan');

/**
 * The trend-capture document for a run (see the header): { v, runId, treeDigest, barsDigest, detector, legs, totals,
 * noLegDays }. runDir: the run's folder (its served bars, autotrader.json, day records); home: the run home.
 */
function captureReport({ runDir, home = path.resolve(runDir, '..', '..'), days = {}, manifest = {}, legs: given = null, context = [] }) {
  const cfg = readJson(path.join(runDir, 'autotrader.json')) || {};
  const minutes = Number(cfg.timeframe) || null;
  const session = (Array.isArray(cfg.sessions) && cfg.sessions.length ? cfg.sessions : SESSION_DEFAULTS.sessions).join(',');
  const bars = minutes ? servedBars(runDir, minutes) : [];
  const stepMs = (minutes || 0) * 60000;
  // Given legs (the training loop's stepped windows: the census's legs, found on the whole session's bars, which a
  // windowed run never serves in full): their move's ends from the start bar when it was served.
  const legs = Array.isArray(given) ? given.map(g => givenLeg(g, bars)) : legsOf(bars, { session, minMoveAtr: TUN.minMoveAtr });
  const records = new Map(require('../trading/trade-lifecycle').readRecords(home).map(r => [r.id, r]));
  const onBar = new Map();
  for (const r of records.values()) { const k = Date.parse(r.bar) + stepMs; if (!onBar.has(k)) onBar.set(k, []); onBar.get(k).push(r); }
  const gate = readLines(path.join(home, 'logs', 'gate-log.jsonl')).filter(g => isObj(g) && g.tool === 'place_order' && g.decision !== 'allowed');
  const cycles = cyclesOf(home).filter(c => c.action === 'trade' || c.action === 'manage');
  const byBar = new Map(cycles.map(c => [Date.parse(c.timing.barClose), c]));
  // The entries placed (the runner's entry records) and their fills (the day records' round trips).
  const orders = readJson(path.join(home, 'entry-orders.json')) || [];
  const fills = Object.values(days).flat().flatMap(r => (Array.isArray(r.trades) ? r.trades : []));
  const filled = id => fills.find(f => f.orderId === id && f.profitAndLoss === null);
  const tripOf = f => (f ? fills.find(x => x.roundTripId === f.roundTripId && isObj(x.roundTrip)) : null);
  // An entry's fill time: its round trip's entry, else its opening fill's.
  const filledAt = o => { const f = filled(o.orderId); if (!f) return NaN; const t = tripOf(f); const ms = t ? Date.parse(t.roundTrip.entryTime) : NaN; return Number.isFinite(ms) ? ms : Date.parse(f.creationTimestamp); };
  // A trade's round trip on the stop it held (trade-basis.js: the runner's move to the plan's stop after the fill).
  const moves = TB.readPlanStops(home);
  const heldOf = (o, t) => {
    if (!t) return null;
    const rt = t.roundTrip;
    const stop = TB.heldStop(moves, { fam: o.contractId || rt.contractId, fromMs: Date.parse(rt.entryTime), toMs: Date.parse(rt.exitTime || t.creationTimestamp) });
    let tick = null;
    try { tick = require('../trading/contracts').tickOf(o.contractId || rt.contractId); } catch (_err) { /* unknown: no tolerance */ }
    return TB.onHeldStop(rt, { stop, tick });
  };
  const stops = [...records.values()].filter(r => r.plan && r.plan.stop && num(r.plan.stop.ticks) !== null).map(r => r.plan.stop.ticks * r.plan.tick);
  const runStop = median(stops);
  const out = legs.map(g => {
    const t0 = Date.parse(g.start);
    const t1 = Date.parse(g.end) + stepMs;
    const until = t0 + (t1 - t0) * TUN.catchShare;
    const legCycles = [];
    for (let t = t0 + stepMs; t <= until; t += stepMs) {
      const c = byBar.get(t);
      legCycles.push(c ? classifyCycle(c, { side: g.side, records: onBar.get(t) || [], gate }) : { bar: new Date(t).toISOString(), planned: false, side: g.side, step: null, by: 'rule', code: 'outside-session', message: 'no trade cycle on this bar', reads: [], role: null });
    }
    // The stop the model planned the leg's way in that span (the median of its records' plans), else the run's.
    const plannedStopPts = median([...records.values()].filter(r => r.side === g.side && isObj(r.plan) && isObj(r.plan.stop) && Date.parse(r.bar) >= t0 - stepMs && Date.parse(r.bar) <= until)
      .map(r => r.plan.stop.ticks * r.plan.tick));
    const stop = plannedStopPts ?? runStop;
    // From the first bar an entry could be on (two closes into the leg: the setup's, then its confirmation) to the end.
    const firstEntry = bars.find(b => Date.parse(b.t) === t0 + stepMs);
    const availPts = firstEntry && num(g.to) !== null ? Math.abs(g.to - firstEntry.c) : null;
    // An entry the leg's way placed in its first catchShare, or placed before the leg's start and filled in it (an order
    // placed on the bar before the turn and filled at the leg's first bar caught it: 2021-06-28, placed 75 s early).
    const entered = orders.filter(o => isObj(o.composed) && o.composed.side === g.side && Date.parse(o.at) <= until
      && (Date.parse(o.at) >= t0 || (filledAt(o) >= t0 && filledAt(o) <= until)));
    const fill = entered.map(o => ({ o, f: filled(o.orderId) })).find(x => x.f) || (entered[0] ? { o: entered[0], f: null } : null);
    const trip = fill && fill.f ? tripOf(fill.f) : null;
    const captured = Boolean(fill && fill.f);
    // Its ride (trend-ride.js): the fills' prices, the round trip's R and peak on the stop it held (trade-basis.js), the
    // trade's risk (that stop's, else its record's planned stop, else the leg's).
    const rt = trip ? trip.roundTrip : null;
    const held = trip ? heldOf(fill.o, trip) : null;
    const plan = captured ? records.get(fill.o.composed.record) : null;
    const riskPts = held && num(held.risk) > 0 ? held.risk : plan && isObj(plan.plan) && isObj(plan.plan.stop) && num(plan.plan.stop.ticks) !== null ? plan.plan.stop.ticks * plan.plan.tick : stop;
    const entryPx = rt ? num(rt.averageEntryPrice) ?? num(rt.entryPrice) ?? num(Number(fill.f.price)) : captured ? num(Number(fill.f.price)) : null;
    const exitPx = rt && rt.open !== true ? num(rt.averageExitPrice) ?? num(rt.exitPrice) : null;
    const ride = captured ? TR.rideOf(g, { entry: entryPx, exit: exitPx, r: held ? held.r : null, peakR: held ? held.mfeR : null, riskPts, bars, from: Date.parse(fill.f.creationTimestamp), to: trip ? Date.parse(rt.exitTime || trip.creationTimestamp) : null, stepMs }) : null;
    const legStop = held && num(held.risk) > 0 ? held.risk : stop;
    const threshold = num(g.scale) !== null ? TUN.minMoveAtr * g.scale : null;
    const sizeX = threshold && num(g.points) !== null ? round2(g.points / threshold) : null;
    // An entry placed that never filled blocked the leg at execution: its limit went unfilled.
    for (const c of legCycles) if (c.code === 'entered' && !(captured && fill.o.composed.record === c.record)) c.code = entered.some(o => o.composed.record === c.record && filled(o.orderId)) ? 'entered' : 'unfilled';
    const blocking = legCycles.filter(c => c.code !== 'entered' || !captured);
    const best = blocking.reduce((a, c) => (!a || stageOf(c) >= stageOf(a) ? c : a), null);
    return {
      id: `${g.day}|${g.side}|${g.start}`, day: g.day, side: g.side, start: g.start, end: g.end, move: { points: g.points, pct: g.pct, from: g.from, to: g.to },
      // Available R on the leg's trade's own stop when one was taken in it, else the planned stop, else the run's (estimated).
      plannedStopPts: round2(plannedStopPts), availableR: legStop && availPts !== null ? round2(availPts / legStop) : null, estimated: !(held && num(held.risk) > 0) && plannedStopPts === null,
      size: { x: sizeX, bucket: TR.sizeBucket(sizeX) }, ride,
      captured, entry: fill ? { at: fill.o.at, price: fill.o.composed.entry, filled: Boolean(fill.f), r: held ? held.r : null, outcome: trip ? (held && held.reason === 'stop' && trip.exitReason === 'trail' ? 'stop' : trip.exitReason || null) : null, ...(held ? { rBasis: held.rBasis } : {}) } : null,
      cycles: legCycles,
      blocker: captured || !best ? null : { step: best.step, code: best.code, by: best.by, role: best.role, skills: [...new Set(best.reads.map(r => r.skill).filter(Boolean))], cycles: legCycles.filter(c => c.code === best.code).length },
    };
  });
  const missed = out.filter(l => !l.captured);
  const byStep = {};
  for (const l of missed) {
    const s = (l.blocker && l.blocker.step) || 'none';
    byStep[s] = byStep[s] || { legs: 0, missedR: 0 };
    byStep[s].legs += 1;
    byStep[s].missedR = round2(byStep[s].missedR + (l.availableR || 0));
  }
  // The day's other known legs (a windowed run's undrawn census legs): they classify entries only, never a leg here.
  const kindLegs = (Array.isArray(context) ? context : []).filter(g => isObj(g) && g.start && g.end && g.side).map(g => ({ id: g.id || `${g.day}|${g.side}|${g.start}`, side: g.side, start: g.start, end: g.end }));
  // The run's filled entries, each in a leg its way, against one, or in none (trend-ride.js entryKind), with its R.
  // Classified at the fill (an order placed before a leg's start and filled in it is in that leg), with its R on the held
  // stop, and its peak R on the same basis (the round report's false starts).
  const entries = orders.filter(o => isObj(o.composed) && filled(o.orderId)).map(o => {
    const t = tripOf(filled(o.orderId));
    const at = Number.isFinite(filledAt(o)) ? new Date(filledAt(o)).toISOString() : o.at;
    const h = heldOf(o, t);
    return { at: o.at, side: o.composed.side, record: o.composed.record || null, ...TR.entryKind({ side: o.composed.side, at }, [...out, ...kindLegs], stepMs), r: h ? h.r : null, peakR: h ? num(h.mfeR) : null };
  });
  const legDays = new Set(out.map(l => l.day));
  const noLegDays = [...new Set(cycles.map(c => tradingDayKey(new Date(Date.parse(c.timing.barClose) - 1))))].filter(d => !legDays.has(d)).sort().map(day => {
    const placed = orders.filter(o => tradingDayKey(new Date(o.at)) === day);
    const rs = placed.map(o => heldOf(o, tripOf(filled(o.orderId)))).filter(Boolean).map(h => h.r).filter(r => r !== null);
    return { day, entries: placed.length, netR: round2(rs.reduce((a, b) => a + b, 0)) };
  });
  const hash = crypto.createHash('sha256').update(JSON.stringify(bars.map(b => [b.t, b.o, b.h, b.l, b.c]))).digest('hex');
  return {
    v: 1, runId: manifest.runId || path.basename(runDir), treeDigest: isObj(manifest.fingerprints) ? manifest.fingerprints.harness || null : null, barsDigest: hash,
    detector: { version: DETECTOR, minMove: { atr: TUN.minMoveAtr, scale: 'the session\'s mean true range of its base bars' }, session, catchShare: TUN.catchShare },
    legs: out,
    entries,
    totals: { legs: out.length, captured: out.filter(l => l.captured).length, captureRate: out.length ? round2(out.filter(l => l.captured).length / out.length) : null, missedR: round2(missed.reduce((a, l) => a + (l.availableR || 0), 0)), byStep, ride: TR.summarize({ legs: out, entries }) },
    noLegDays,
    exits: minutes ? exitsOf({ home, days, bars, minutes, cycles, session, broker: manifest.broker || '' }) : null,
  };
}

const writeCapture = (runDir, doc) => { fs.writeFileSync(path.join(runDir, FILE), `${JSON.stringify(doc, null, 1)}\n`); return path.join(runDir, FILE); };
const readCapture = runDir => readJson(path.join(runDir, FILE));

/** The report's lines: the totals, one line per leg (its blocker), the blocker counts by step and code. */
function reportLines(doc) {
  if (!isObj(doc) || !Array.isArray(doc.legs)) return [];
  const t = doc.totals;
  const lines = [`${t.legs} trend leg(s) (${doc.detector.minMove.atr} x the session's mean true range), ${t.captured} caught (${t.captureRate === null ? '-' : `${Math.round(t.captureRate * 100)}%`}), ${t.missedR} R missed`];
  for (const l of doc.legs) {
    const b = l.blocker;
    lines.push(`  ${l.day} ${l.side} ${hhmm(l.start)}-${hhmm(l.end)} ET ${l.move.points} pts (${l.availableR ?? '?'}R${l.estimated ? ' est.' : ''}): ${l.captured ? 'CAUGHT' : `missed: ${b ? `${b.step || 'no step'} ${b.code} (${b.by}, ${b.cycles} cycle(s))` : 'no cycle'}`}`);
  }
  const codes = {};
  for (const l of doc.legs) for (const c of l.cycles) codes[`${c.step || '-'} ${c.code}`] = (codes[`${c.step || '-'} ${c.code}`] || 0) + 1;
  lines.push(`  blockers by cycle: ${Object.entries(codes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  lines.push(`  by step: ${Object.entries(t.byStep).map(([s, x]) => `${s} ${x.legs} leg(s) ${x.missedR}R`).join(', ') || 'none'}`);
  if (isObj(t.ride)) lines.push(...TR.rideLines(t.ride));
  if (isObj(doc.exits) && isObj(doc.exits.totals)) lines.push(...ES.exitLines(doc.exits.totals));
  if (doc.noLegDays.length) lines.push(`  days with no leg: ${doc.noLegDays.map(d => `${d.day} ${d.entries} entr${d.entries === 1 ? 'y' : 'ies'} ${d.netR}R`).join(', ')}`);
  return lines;
}

module.exports = { FLOW_STEPS, DETECTOR, FILE, legsOf, classifyCycle, cyclesOf, captureReport, writeCapture, readCapture, reportLines };
