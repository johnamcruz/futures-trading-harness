'use strict';

/**
 * The goal regression's mechanical trades (docs/TRAINING.md, "The goal regression"): on real bars, every setup the
 * shipped code finds on the entry rule's side, entered and exited by the shipped rules, one position at a time. The
 * harness's own modules detect, time, stop, size and exit each trade; what is this module's own is the choice of
 * setups (the 15m structure, compression and CISD primitives the studies measured, not the briefing's key-level
 * reactions) and the 2R mark as every target (the trail's arming point; compose's
 * nearest named target and its bias and location reads are not modelled):
 *
 *   side      the policy's entry rule (its RULEBOOK `entry`, entry-rule.js) per bar: chain-side.js chainSideSeries
 *   setups    on the chain's setup frame (the 15m), the side's way only, closed in the curation session
 *             (config/replay.json trendCapture.curationSessions): a CHoCH or BOS (structure-events.js breaksOf), a
 *             compression break (compression.js compressionAt, its expanding break on that candle), and a strong CISD
 *             (cisd.js: its displacement strong) when price first trades into its OTE zone; the stop one
 *             risk.stop_buffer_ticks beyond the setup candle's far side (a CISD: beyond the leg's origin), D3. And every
 *             rules strategy the composed strategy cites (strategies.js citedSetups: momentum_continuation), its scan
 *             (evaluator.js) firing on the bar, its own stop and R target, entered at market (trade-lifecycle.js planOf)
 *   entry     as compose_check plans it (setup-library.js, the standard; the setup is the entry, no confirming read):
 *             the first base close from the one the setup is known at (a CISD: its touch bar) within the setup frame's
 *             span, the entry rule still giving the side on that bar, entries allowed (briefing.js sessionWindow: the gate's clock; the runner's sessions and
 *             holidays), the stop not traded through since the setup; a limit at that close for the strategy's
 *             valid_bars; the target the 2R mark (risk.min_rr; the policy's exit trails past it); D13's floor
 *             (trade-lifecycle.js stopFloorTicks): a closer stop is refused, never widened
 *   exit      experience-log.js limitOutcome with the policy's exit (evaluator.js composedExit(trade_lifecycle).plan),
 *             out at the runner's end of day (setup-library.js runnerClock)
 *   one       one position at a time, as live: decided after sizing, at each attempt's own account state (goal-metrics.js,
 *             runAttempt's onePosition), so a plan the account can't size never holds the slot; the candidates are
 *             every fill, in entry order (entryOrder); oneAtATime is the same rule before sizing (tier 2's first entries)
 *
 *   shippedOf(root, env)       the shipped pieces the trades read: { strategies, life, policy, entryRule, exit, stopRule,
 *                              validBars, minRR, cited, setupMinutes, baseMinutes, session }
 *   blockTrades(bars, sessions, shipped, { symbol })   { candidates, trades, setups, refused }: candidates every fill in
 *                              entry order, trades oneAtATime of them; bars normalized ({ t, o, h, l, c, v }),
 *                              sessions the dates traded (the warm-up before them is read, never traded); refused counts
 *                              each setup that made no trade by why
 */

const ind = require('../trading/indicators');
const CF = require('../trading/candle-facts');
const SE = require('../trading/structure-events');
const CI = require('../trading/cisd');
const CMP = require('../trading/compression');
const { causalLevels } = require('../trading/rules');
const { chainSideSeries } = require('../trading/chain-side');
const { loadStrategies, citedSetups, composedOf } = require('../trading/strategies');
const { composedExit, createEvaluator } = require('../trading/evaluator');
const { entryRuleOf } = require('../trading/entry-rule');
const { STRATEGY: LIFE, stopRuleOf, stopFloorTicks } = require('../trading/trade-lifecycle');
const { TF_MIN } = require('../trading/composed-reads');
const { runnerClock } = require('../learning/setup-library');
const { limitOutcome } = require('../learning/experience-log');
const { sessionWindow } = require('../trading/briefing');
const { parseWindows, inWindow, tradingDayKey } = require('../trading/clock');
const { tickOf } = require('../trading/contracts');

const msOf = minutes => minutes * 60000;
const AN = require('../tunables').analysis();
const fin = x => typeof x === 'number' && Number.isFinite(x);
const r4 = x => (fin(x) ? Math.round(x * 1e4) / 1e4 : x);
const { label } = require('../trading/mtf');

function shippedOf(root, env = {}) {
  const strategies = loadStrategies(root, env).strategies;
  const life = strategies.find(s => s.name === LIFE);
  if (!life || !life.valid) throw new Error(`strategies/${LIFE} is missing or invalid`);
  const policies = strategies.filter(s => s.valid && s.signal === 'policy' && composedOf(s, strategies).includes(LIFE));
  if (policies.length !== 1) throw new Error(`exactly one policy must trade ${LIFE} (found ${policies.map(p => p.name).join(', ') || 'none'})`);
  const policy = policies[0];
  const entryRule = entryRuleOf(policy.entry);
  if (!entryRule) throw new Error(`${policy.name}: no entry rule (its RULEBOOK entry)`);
  const stopRule = stopRuleOf(life.risk);
  if (!stopRule) throw new Error(`${LIFE}: no whole stop rule`);
  const cited = [...citedSetups(strategies, LIFE)].map(n => strategies.find(s => s.name === n));
  const setupMinutes = TF_MIN[entryRule.chain.setup];
  const baseMinutes = TF_MIN[entryRule.chain.entry];
  const session = require('../tunables').replay().trendCapture.curationSessions.join(',');
  return { strategies, life, policy, entryRule, exit: composedExit(life, strategies), stopRule, validBars: life.valid_bars, minRR: life.risk.min_rr, cited, setupMinutes, baseMinutes, session };
}

/** The setup-frame candles with the base bar each is known at (its last bar when it closes the boundary, else the next). */
function knownCandles(bars, minutes, base) {
  const stepMs = msOf(base);
  return CF.completedSeries(bars, minutes, base).candles.map(c => ({ ...c, known: Date.parse(bars[c.last].t) + stepMs === Date.parse(c.closedAt) ? c.last : c.last + 1 }));
}

/** Every setup on the setup frame, any side: [{ type, k, side, stop }] (k: the base bar it is known at). */
function frameSetups(bars, P, tick) {
  const out = [];
  const buf = P.stopRule.bufferTicks * tick;
  const M = P.setupMinutes;
  const cs = knownCandles(bars, M, P.baseMinutes);
  const beyond = (c, s) => (s > 0 ? c.l - buf : c.h + buf);
  for (const x of SE.breaksOf(cs)) {
    const c = cs[x.i];
    const s = x.direction === 'up' ? 1 : -1;
    out.push({ type: `${label(M)} ${x.kind}`, k: c.known, side: s, stop: beyond(c, s), from: c.known });
  }
  const ser = CMP.seriesOf(cs);
  for (let j = 1; j < cs.length; j += 1) {
    const x = CMP.compressionAt(cs, j, { series: ser });
    if (x.state === 'expanding' && x.break && x.break.barsAgo === 0) {
      const s = x.break.dir === 'up' ? 1 : -1;
      out.push({ type: `${label(M)} compression break`, k: cs[j].known, side: s, stop: beyond(cs[j], s), from: cs[j].known });
    }
  }
  // A strong CISD, at the first base bar trading into its OTE zone while it stands (cisd.js cisdSeries: the same CISD).
  const cc = CI.candlesOf(bars, M, P.baseMinutes).candles || [];
  const atrTf = ind.atr(cc, ind.ATR_PERIOD);
  const sr = CI.cisdSeries(bars, M, { levels: causalLevels(bars), atr: ind.atr(bars, ind.STOP_ATR_PERIOD), barMinutes: P.baseMinutes });
  for (const ev of CI.findCisds(cc)) {
    const kn = CI.knownAt(bars, cc[ev.confirm], M, P.baseMinutes);
    if (kn < 0 || !CI.displacementOf(cc, ev.confirm, ev.dir, atrTf).strong) continue;
    const bull = ev.dir === 1;
    let origin = bull ? Infinity : -Infinity;
    for (let i = cc[ev.runStart].start; i <= cc[ev.confirm].end; i += 1) origin = bull ? Math.min(origin, bars[i].l) : Math.max(origin, bars[i].h);
    for (let i = kn > cc[ev.confirm].end ? kn : kn + 1; i < bars.length; i += 1) {
      if (sr.dir[i] !== ev.dir || sr.level[i] !== ev.level) break;
      const edge = bull ? sr.top[i - 1] : sr.bottom[i - 1];
      if (!fin(edge) || sr.dir[i - 1] !== ev.dir) continue;
      if (bull ? bars[i].l <= edge : bars[i].h >= edge) {
        out.push({ type: `${label(M)} cisd ote`, k: i, side: ev.dir, stop: bull ? origin - buf : origin + buf, from: i });
        break;
      }
    }
  }
  return out;
}

function blockTrades(bars, sessions, P, { symbol }) {
  const tick = tickOf(symbol);
  if (!tick) throw new Error(`${symbol}: no tick`);
  const n = bars.length;
  const base = P.baseMinutes;
  const tfMs = msOf(base);
  const ms = bars.map(b => Date.parse(b.t));
  const list = bars.map((b, i) => ({ ...b, ms: ms[i] }));
  const days = new Set(sessions);
  const dayOf = ms.map(x => tradingDayKey(new Date(x)));
  const { windows } = parseWindows(P.session);
  const clock = runnerClock({ from: sessions[0], to: sessions[sessions.length - 1] });
  // A decision at bar i's close: a traded session's, inside the curation session.
  const decides = i => i >= 0 && i < n && days.has(dayOf[i]) && windows.some(w => inWindow(new Date(ms[i] + tfMs - 1), w));
  const entersAt = i => decides(i) && clock.inSession(ms[i] + tfMs) && sessionWindow(new Date(ms[i] + tfMs)).entries === 'allowed';
  const side = chainSideSeries(bars, { rule: P.entryRule, minutes: base });
  const atr20 = ind.atr(bars, ind.STOP_ATR_PERIOD);
  const floorAt = j => stopFloorTicks({ sections: { m3: { data: { referenceStop: { distance: r4(AN.snapshot.stopAtrMult * atr20[j]) } } } } }, tick, P.stopRule);
  const span = Math.round(P.setupMinutes / base);
  const up = x => Math.ceil(x / tick - 1e-9) * tick;
  const down = x => Math.floor(x / tick + 1e-9) * tick;
  const refused = {};
  const no = why => { refused[why] = (refused[why] || 0) + 1; return null; };
  const run = (s, entry, stop, target, j, market) => limitOutcome({
    bars: list, tfMs, side: s > 0 ? 'long' : 'short', entry, stop, target, fromMs: ms[j] + tfMs,
    expiresMs: ms[j] + tfMs + (market ? 1 : P.validBars) * tfMs, eodMs: clock.eodOf(ms[j] + tfMs), tick, plan: P.exit.plan, market,
  });
  const pack = (st, j, o, stopTicks) => (o.filled && o.R !== null
    ? { type: st.type, side: st.side > 0 ? 'long' : 'short', day: dayOf[j], setupAt: bars[st.k].t, decidedAt: bars[j].t, entryTime: o.entryTime, exitTime: o.exitTime, entry: o.entryPrice, stopTicks, R: o.R, mfeR: o.mfeR, maeR: o.maeR, reason: o.exitReason }
    : no(`unfilled (${o.exitReason})`));
  const composed = st => {
    const s = st.side;
    for (let j = st.from; j < st.from + span - (st.from > st.k ? 1 : 0) && j < n; j += 1) {
      if (dayOf[j] !== dayOf[st.k]) break;
      if (s > 0 ? bars[j].l <= st.stop : bars[j].h >= st.stop) return no('stop traded first');
      if (!entersAt(j) || side[j] !== s) continue;
      const ref = bars[j].c;
      const stopTicks = Math.ceil(Math.abs(ref - st.stop) / tick - 1e-9);
      const floor = floorAt(j);
      if (floor === null || stopTicks < floor) return no('stop under the D13 floor');
      const target = s > 0 ? up(ref + P.minRR * (ref - st.stop)) : down(ref - P.minRR * (st.stop - ref));
      return pack(st, j, run(s, ref, st.stop, target, j, false), stopTicks);
    }
    return no('no entry bar');
  };
  const setups = [];
  for (const st of frameSetups(bars, P, tick)) if (decides(st.k) && side[st.k] === st.side) setups.push(st);
  const trades = [];
  for (const st of setups) { const t = composed(st); if (t) trades.push(t); }
  // The cited rules strategies: their scan's fire on the bar, at market from its close (planOf's cited setup).
  const ev = createEvaluator(bars);
  for (const strat of P.cited) {
    for (let i = 0; i < n; i += 1) {
      if (!entersAt(i)) continue;
      const r = ev.at(strat, i, { describe: false });
      if (!r.candidate) continue;
      const s = r.direction === 'long' ? 1 : -1;
      const st = { type: strat.name, k: i, side: s };
      setups.push(st);
      if (side[i] !== s) { no('cited fire off the side'); continue; }
      const ref = bars[i].c;
      const ticks = Math.ceil(r.stopDistance / tick - 1e-9);
      const floor = floorAt(i);
      if (floor === null || ticks < floor) { no('stop under the D13 floor'); continue; }
      const targetR = strat.exit && fin(strat.exit.target_r) ? strat.exit.target_r : P.minRR;
      const t = pack(st, i, run(s, ref, ref - s * ticks * tick, ref + s * Math.round(targetR * ticks) * tick, i, true), ticks);
      if (t) trades.push(t);
    }
  }
  return { trades: oneAtATime(trades), candidates: [...trades].sort(entryOrder), setups: setups.length, refused };
}

/** The order trades meet the account: by entry time, then the setup bar, then the type. */
const entryOrder = (a, b) => Date.parse(a.entryTime) - Date.parse(b.entryTime) || a.setupAt.localeCompare(b.setupAt) || a.type.localeCompare(b.type);

/**
 * One position at a time before any sizing: by entryOrder, a fill while one is open is dropped. Tier 2's mechanical
 * first entries read it (a day's first is its first candidate either way); the attempts decide the slot after sizing
 * (goal-metrics.js: runAttempt's onePosition), so a plan no account sizes never holds it.
 */
function oneAtATime(trades) {
  const sorted = [...trades].sort(entryOrder);
  const out = [];
  let free = -Infinity;
  for (const t of sorted) {
    if (Date.parse(t.entryTime) < free) continue;
    out.push(t);
    free = Date.parse(t.exitTime);
  }
  return out;
}

module.exports = { shippedOf, blockTrades, frameSetups, oneAtATime, entryOrder };
