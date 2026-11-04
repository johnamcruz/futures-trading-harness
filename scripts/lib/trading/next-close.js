'use strict';

/**
 * "Possible at the next close": the prepare briefing's section (docs/PREPARE-AHEAD.md, the owner-approved prepare-ahead
 * design). Built from CLOSED bars only (the bars the briefing for bar T was built from, never the bar forming), for the
 * base bar that closes next (T+1, opening at T's close): every entry candidate that could fire at that close, its
 * trigger written as conditions on the closing candle, and the plan as a function of the trigger. A read for the head's
 * bar plan, never a verdict: at the close the closed candle decides, on the at-close briefing (the gate checks the
 * compose record built then, never this).
 *
 * When: only for a flat account (no position, no working order: `flat` true) and entries; otherwise null (no section).
 * No entries at the next close (its session window or a news blackout, briefing.js sessionWindow and newsState at that
 * close), no candidate, or none that can be computed: the NONE marker with the reasons (the prepare is skipped then).
 *
 * The candidates, each from the code the at-close briefing runs, never a restated rule:
 *   momentum   each rules strategy trade_lifecycle may cite (strategies.js citedSetups) on the base timeframe whose side
 *              holds exactly one `htfd_momentum(<base>) > 0` (`< 0` short) condition: its trigger is the momentum read
 *              (momentum.js momentumRead) of the closing candle on the basis it will be read on (candle-facts.js
 *              nextBasisOf: the ATR(14) as of the candle before it and the average volume of up to the 20 candles
 *              before it; NEITHER includes the closing candle's own range or volume), so the range and volume
 *              thresholds are numbers known now: the least range in ticks and the least whole volume that read as
 *              momentum (found by asking momentumRead itself, unrounded, as the rules engine reads it), and the close
 *              in the far third (candle-facts.js closeLocation). It is listed when the strategy's scan (strategies.js
 *              scan, the evaluator) fires its side on the closed bars plus the threshold candle (the least such candle,
 *              opening at the last close): its other rules (the entry rule's side, the window) and the evaluator's
 *              checks (session, trend rule, filters) hold for it. They are PRECONDITIONS: code evaluates them again at
 *              the close, and the side (chain_side) can move with the closing candle (the declared trend reads its
 *              close; a 15m or 1h close updates the frames).
 *   reaction   at a close that completes a setup-frame candle (setup-moments.js DEFAULTS.setupTf, the 15m): each
 *              rejection or break of a FIXED key level (setup-moments.js KEY_LEVEL, read as it stood at the candle's
 *              open: briefing.js candleLevelsAt) in reach (the levels inside the candle's range so far, and the nearest
 *              one beyond its high and beyond its low), as candle-facts.js relation defines them on the completed
 *              candle (its open and range so far are known; the closing bar adds its high, low and close). relation
 *              is the oracle: the thresholds are the least tick closes (and highs or lows) it reads as the reaction.
 *              Not listed in v1: the moving levels (the VWAP, the session profile: their value at the close moves
 *              with the closing bar) and the fair value gaps' edges (read through the gap's side); one of them
 *              reacting at the close is outside the plan. Only the sides the trend rule allows (as standardPlans).
 *
 * The plan, per candidate, as a function of the trigger: the rule in words from the strategies' own numbers, and the
 * plan code makes for the threshold candle (the at-close briefing built on the closed bars plus that candle): a momentum
 * candidate's is compose_check's of its cited reads (composed-reads.js checkReads, then trade-lifecycle.js planOf), a
 * reaction's is the Standard plan's (setup-library.js composeAt, as standardPlans calls it). The size: with the
 * account's sizing facts (`sizing`, the caller's: { capUsd, floor, tickValue, slipTicks, feePerSide, stretchUsd }),
 * size-translate.js floorFit at the plan's stop, and the widest stop the floor fits; without them, not stated.
 * Every read is the briefing's read name, so a bar plan's reads parse in compose_check.
 *
 *   possibleAtNextClose({ symbol, bars, minutes, briefing, flat, registry, sizing, blackouts, clock, roundSteps })
 *       null (not flat) | { asOf, closedAt, next: { t, closedAt }, none: reason | null, candidates, skipped }
 *   triggerMet(candidate, bar)   whether the closing bar meets the candidate's trigger (the same code the at-close
 *                                read runs); preconditions aside
 *   possibleLines(section, et)   the section as briefing lines
 *   renderPrepareBriefing(b, section, { now })   the prepare briefing: the briefing's text with the section after its
 *                                summary (the at-close briefing never has it)
 *   NONE   the marker of a section with no candidate ("Possible at the next close: NONE")
 */

const path = require('path');
const { buildBriefing, renderBriefing, candleLevelsAt, sessionWindow, newsState } = require('./briefing');
const CF = require('./candle-facts');
const { momentumRead, RANGE_ATR, VOL_RATIO } = require('./momentum');
const { normalizeBars } = require('./indicators');
const { tickOf, levelOnTick } = require('./contracts');
const { MARKET_TZ } = require('./clock');
const { checkReads, levelName } = require('./composed-reads');
const { STRATEGY: LIFECYCLE, planOf, stopRuleOf } = require('./trade-lifecycle');
const { trendRuleOf } = require('./reasons');
const SM = require('../learning/setup-moments');
const { floorFit } = require('../prop/size-translate');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
const NONE = 'NONE';
const SECTION = 'Possible at the next close';
const SIDES = ['long', 'short'];
const MOMENTUM_RULE = /^htfd_momentum\((\d+)\)\s*(>|<)\s*0$/;
const MINUTE_RULE = /^minute_et\s*(>=|<=|>|<)\s*(\d+)$/;

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const r2 = x => Math.round(x * 100) / 100;
const tfLabel = CF.label;
const dirOf = side => (side === 'long' ? 'up' : 'down');
const sideOf = dir => (dir === 'up' ? 'long' : dir === 'down' ? 'short' : null);
const etClock = at => new Intl.DateTimeFormat('en-US', { timeZone: MARKET_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
const hhmm = m => `${String(100 + Math.floor(m / 60)).slice(1)}:${String(100 + (m % 60)).slice(1)}`;
const ruleText = r => (typeof r === 'string' ? r : JSON.stringify(r));

let shipped = null;
const shippedRegistry = () => {
  if (!shipped) shipped = require('./strategies').loadStrategies(PLUGIN_ROOT, {}).strategies;
  return shipped;
};

/** The least whole k from `start` (k >= lo) for which `meets(k)` holds, `meets` growing with k; null past `max`. */
function least(meets, start, lo, max) {
  let k = Math.max(lo, start);
  while (k > lo && meets(k - 1)) k -= 1;
  while (!meets(k)) { k += 1; if (k > max) return null; }
  return k;
}

/** A side's momentum condition on the base timeframe ({ dir, rule }) and its other rules, or null (no single one). */
function momentumRuleOf(s, side, minutes) {
  const rules = isObj(s.rules) && Array.isArray(s.rules[side]) ? s.rules[side] : [];
  const hits = rules.map(r => (typeof r === 'string' ? MOMENTUM_RULE.exec(r.trim()) : null));
  const at = hits.map((m, i) => (m && Number(m[1]) === minutes ? i : -1)).filter(i => i >= 0);
  if (at.length !== 1) return null;
  const dir = hits[at[0]][2] === '>' ? 'up' : 'down';
  if (dir !== dirOf(side)) return null;
  return { dir, rule: rules[at[0]], others: rules.filter((_r, i) => i !== at[0]).map(ruleText) };
}

/** A rule as words with its ET time (minute_et is the candle's open, minutes after midnight ET). */
const preconditionText = r => {
  const m = MINUTE_RULE.exec(r.trim());
  return m ? `${r} (opened ${m[1]} ${hhmm(Number(m[2]))} ET)` : r;
};

/**
 * The momentum trigger's thresholds on a basis (candle-facts.js nextBasisOf), for `dir`: the least range (ticks) and
 * the least whole volume momentumRead reads as momentum that way, the close in the far third; or { reason }.
 */
function momentumThresholds(basis, dir, tick, open) {
  if (!(basis.atrPrev > 0)) return { reason: 'the ATR(14) of the candles before it is unknown' };
  if (!(basis.avg > 0)) return { reason: 'the average volume of the candles before it is unknown (too few)' };
  const up = dir === 'up';
  const candle = (k, v) => {
    const far = levelOnTick(open + (up ? k : -k) * tick, tick);
    return up ? { o: open, h: far, l: open, c: far, v } : { o: open, h: open, l: far, c: far, v };
  };
  const reads = (k, v) => momentumRead(CF.factOf(candle(k, v), basis)) === dir;
  const huge = Number.MAX_SAFE_INTEGER;
  const startK = Math.floor((RANGE_ATR * basis.atrPrev) / tick);
  const ticks = least(k => reads(k, huge), startK, 1, (startK + 1) * 2);
  if (ticks === null) return { reason: 'no range reads as momentum' };
  const startV = Math.floor(VOL_RATIO * basis.avg);
  const volume = least(v => reads(ticks, v), startV, 0, (startV + 1) * 2);
  if (volume === null) return { reason: 'no volume reads as momentum' };
  return { ticks, range: levelOnTick(ticks * tick, tick), volume, candle: candle(ticks, volume) };
}

/** The least candle meeting a momentum trigger, as the closing bar (opening at `t`, from the last close). */
const barOf = (t, c) => ({ t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });

/** The account's sizing at a plan's stop (size-translate.js floorFit), or null without the facts. */
function sizeAt(sizing, stopTicks) {
  if (!isObj(sizing) || !Number.isInteger(stopTicks)) return null;
  const fit = floorFit({ capUsd: sizing.capUsd, floor: sizing.floor, stopTicks, tickValue: sizing.tickValue, slipTicks: sizing.slipTicks, feePerSide: sizing.feePerSide, stretchUsd: sizing.stretchUsd });
  return fit ? { ...fit, capUsd: sizing.capUsd, stretchUsd: num(sizing.stretchUsd) } : null;
}

/** The plan's numbers as stored and shown: { status, why?, entry, stop, target, rr, size? }. */
function planFacts(plan, problems, sizing) {
  if (!plan) return { status: 'refused', why: (problems || [])[0] || 'no plan' };
  const size = sizeAt(sizing, plan.stop.ticks);
  return {
    status: problems && problems.length ? 'refused' : 'ok', ...(problems && problems.length ? { why: problems[0] } : {}),
    entry: { type: plan.entry.type, price: plan.entry.price }, stop: { price: plan.stop.price, ticks: plan.stop.ticks, floorTicks: plan.stop.floorTicks },
    target: { price: plan.target.price, ticks: plan.target.ticks, ...(plan.target.mark ? { mark: true } : {}) }, rr: plan.rr,
    ...(size ? { size } : {}),
  };
}

/** The momentum candidates (see the header). */
function momentumCandidates(x) {
  const { bars, minutes, symbol, registry, tick, next, sizing, blackouts, clock, roundSteps, skipped } = x;
  const tf = tfLabel(minutes);
  const cited = require('./strategies').citedSetups(registry, LIFECYCLE);
  const lifecycle = registry.find(s => s && s.name === LIFECYCLE && s.valid);
  const own = registry.filter(s => s && s.valid && cited.has(s.name) && s.signal === 'rules' && s.timeframe === tf);
  if (!own.length) return [];
  const cs = CF.completedSeries(bars, minutes, minutes).candles;
  if (!cs.length) { skipped.push(`momentum: no completed ${tf} candle`); return []; }
  const basis = CF.nextBasisOf(cs);
  const last = bars[bars.length - 1];
  const out = [];
  for (const s of own) {
    for (const side of SIDES) {
      const rule = momentumRuleOf(s, side, minutes);
      if (!rule) continue;
      const t = momentumThresholds(basis, rule.dir, tick, last.c);
      if (t.reason) { skipped.push(`${s.name} ${side}: ${t.reason}`); continue; }
      const probe = barOf(next.t, t.candle);
      const withProbe = [...bars, probe];
      const results = require('./strategies').scan(registry, withProbe, { symbol });
      const r = results.find(y => y && y.name === s.name);
      if (!r || !r.candidate || r.direction !== side) {
        const why = !r ? 'not scanned for this contract' : r.direction !== side ? `its rules don't fire ${side} with the threshold candle (${(r.rules && r.rules[side] ? r.rules[side] : []).filter(y => !y.ok).map(y => y.rule).join(', ') || 'both sides fire'})`
          : `the scan refuses it (${(r.filtersFailed || []).join('; ') || (r.inSession ? 'out of its regimes' : 'out of its sessions')})`;
        skipped.push(`${s.name} ${side}: ${why}`);
        continue;
      }
      const pb = buildBriefing({ symbol, bars: withProbe, minutes, scan: results, blackouts, clock, roundSteps });
      const word = rule.dir;
      const reads = [
        { step: 'setup', skill: 'trade-lifecycle', read: `${s.name} fired ${word}` },
        { step: 'entry', skill: 'candle-reading', read: `${tf} momentum ${word}` },
        { step: 'stop', skill: 'invalidation', read: `stop ${tf} ${side === 'long' ? 'low' : 'high'} ${side === 'long' ? probe.l : probe.h}` },
        { step: 'target', skill: 'take-profit', read: 'target 2r' },
      ];
      const checked = checkReads({ reads, side, briefing: pb, tick, cited });
      const untrue = checked.reads.find(y => y.check !== true);
      const risk = lifecycle ? lifecycle.risk : null;
      const planned = untrue || !risk ? { plan: null, problems: [untrue ? `"${untrue.read}" is not true for the threshold candle: ${untrue.fact}` : `the ${LIFECYCLE} strategy can't be read`] }
        : planOf({ checked, briefing: pb, side, size: isObj(sizing) && Number.isInteger(sizing.floor) ? sizing.floor : 1, tick, tickValue: isObj(sizing) && num(sizing.tickValue) ? sizing.tickValue : tick, minRR: risk.min_rr, maxRiskUsd: risk.max_risk_usd, stopRule: stopRuleOf(risk), suggestion: true });
      const stop = s.risk && s.risk.stop ? (isObj(s.risk.stop) ? s.risk.stop[side] : s.risk.stop) : null;
      out.push({
        kind: 'momentum', name: s.name, side, dir: word, read: reads[0].read, tf,
        trigger: { dir: word, ticks: t.ticks, range: t.range, volume: t.volume, third: word === 'up' ? 'top' : 'bottom', basis: { prev: basis.prev ? { o: basis.prev.o, h: basis.prev.h, l: basis.prev.l, c: basis.prev.c, v: basis.prev.v } : null, atrPrev: basis.atrPrev, avg: basis.avg, n: basis.n } },
        preconditions: rule.others,
        rule: { entry: 'market from the close', stop: stop ? `${stop}${num(s.risk.stop_min) ? `, at least ${s.risk.stop_min} pts` : ''} (${s.name}'s risk.stop), ceil to ticks` : `${s.name}'s risk.stop`, target: s.exit && num(s.exit.target_r) ? `${s.exit.target_r}R (its exit.target_r; past it the policy's exit trails)` : 'its own' },
        threshold: { bar: probe, reads: reads.map(y => y.read), plan: planFacts(planned.plan, planned.problems, sizing) },
      });
    }
  }
  return out;
}

/** The final setup-frame candle once the closing bar is in: open known, range so far, the bar's high, low and close. */
const finalCandle = (f, bar) => ({ o: f.o, h: Math.max(f.h, bar.h), l: Math.min(f.l, bar.l), c: bar.c });

/** A tick price `k` ticks from `p` on the tick grid (p's tick floor or ceiling first). */
const ticksFrom = (p, k, tick, up) => levelOnTick((up ? Math.floor(p / tick + 1e-9) + k : Math.ceil(p / tick - 1e-9) - k) * tick, tick);

/** The reaction candidates (see the header). */
function reactionCandidates(x) {
  const { bars, minutes, symbol, tick, next, sizing, blackouts, clock, roundSteps, skipped, briefing, setupTf } = x;
  const stf = tfLabel(setupTf);
  const n = bars.length;
  const last = bars[n - 1];
  const flat = { t: next.t, o: last.c, h: last.c, l: last.c, c: last.c, v: last.v };
  const s = CF.completedSeries([...bars, flat], setupTf, minutes);
  if (!s.available) return [];
  const j = s.lastAt[n];
  const cand = j >= 0 ? s.candles[j] : null;
  // Only at a close that completes a setup-frame candle, with at least one of its bars closed already.
  if (!cand || cand.last !== n || Date.parse(cand.closedAt) !== Date.parse(next.closedAt)) return [];
  if (cand.first >= n) { skipped.push(`${stf}: none of its bars has closed yet`); return []; }
  const subs = bars.slice(cand.first, n);
  const f = { t: cand.t, o: bars[cand.first].o, h: Math.max(...subs.map(b => b.h)), l: Math.min(...subs.map(b => b.l)) };
  const prev = j > 0 ? s.candles[j - 1] : null;
  const prevClose = prev ? prev.c : NaN;
  const closeOf = k => Date.parse(bars[k].t) + minutes * 60000;
  let openIdx = n - 1;
  while (openIdx >= 0 && closeOf(openIdx) > Date.parse(cand.t)) openIdx -= 1;
  const seen = new Set();
  const levels = candleLevelsAt(bars, minutes, [])(n - 1, openIdx, cand.first)
    .filter(([name, p]) => Number.isFinite(p) && SM.KEY_LEVEL.test(name) && !CF.MOVING_LEVEL.test(name) && !seen.has(name) && seen.add(name));
  // In reach: inside the range so far, and the nearest beyond its high and beyond its low (every level at that price).
  const above = levels.filter(([, p]) => p > f.h).map(([, p]) => p);
  const below = levels.filter(([, p]) => p < f.l).map(([, p]) => p);
  const nearUp = above.length ? Math.min(...above) : null;
  const nearDown = below.length ? Math.max(...below) : null;
  const reach = levels.filter(([, p]) => (p >= f.l && p <= f.h) || p === nearUp || p === nearDown);
  const rule = trendRuleOf(((briefing.sections.m3 || {}).data || {}).trendRule);
  const out = [];
  for (const [name, L] of reach) {
    for (const kind of reactionKinds(f, L, prevClose, tick)) {
      const side = sideOf(kind.dir);
      if (rule[side] === false) { skipped.push(`${stf} ${kind.rel} ${name} ${kind.dir}: against the trend rule`); continue; }
      const bar = { t: next.t, ...kind.bar(last.c), v: last.v };
      const withProbe = [...bars, bar];
      const pb = buildBriefing({ symbol, bars: withProbe, minutes, scan: [], blackouts, clock, roundSteps });
      const m3 = pb.sections.m3.data;
      const mo = SM.setupMoment(m3.candles, { setupTf, barClose: Date.parse(next.closedAt) });
      const reaction = mo.reactions.find(r => r.name === name && r.rel === kind.rel && r.dir === kind.dir);
      const read = `${stf} ${kind.rel} ${levelName(name)} ${kind.dir}`;
      if (!reaction) { skipped.push(`${read}: the at-close read doesn't list it for the threshold candle`); continue; }
      const composed = require('../learning/setup-library').composeAt(pb, reaction, { side, tick, setupTf, mark: true });
      const plan = composed.plan ? planFacts(composed.plan, [], sizing) : { status: composed.status, why: composed.why };
      out.push({
        kind: 'reaction', name, price: L, side, dir: kind.dir, read, tf: stf, rel: kind.rel,
        trigger: { rel: kind.rel, dir: kind.dir, level: L, candle: f, prevClose: Number.isFinite(prevClose) ? prevClose : null, ...kind.facts },
        // The side as the trend rule allows it now; the close's own trend rule decides (a 15m close can move it).
        preconditions: [`the trend rule allows a ${side} (${rule[side] === true ? 'it does now' : 'unknown now'})`],
        rule: { entry: 'a limit at the close (it fills if a later bar trades to it within the record\'s valid_bars)',
          stop: side === 'long' ? `the ${LIFECYCLE} stop buffer beyond the ${stf} candle's low (the lower of its low so far ${f.l} and the closing bar's low), never under compose's floor`
            : `the ${LIFECYCLE} stop buffer beyond the ${stf} candle's high (the higher of its high so far ${f.h} and the closing bar's high), never under compose's floor`,
          target: `the first named level ahead at ${require('../learning/setup-library').MIN_RR}:1 or more from the close (the Standard plan's), else the 2R mark` },
        threshold: { bar, reads: (composed.reads || []).map(y => y.read), plan },
      });
    }
  }
  return out;
}

/**
 * The reactions candle-facts.js relation can give level L on the final candle (finalCandle) once the closing bar is in,
 * each with its threshold: [{ rel, dir, facts, bar(open) }] (bar: the least closing bar, opening at `open`, that gives
 * it). relation decides every one: a break by its close alone, a rejection by its close and its high (or low).
 */
function reactionKinds(f, L, prevClose, tick) {
  const rel = c => CF.relation(c, L, prevClose);
  const out = [];
  // A break's close is at most |L - open| beyond L (most of the body beyond): the search never needs more ticks.
  const span = (Math.ceil(Math.abs(L - f.o) / tick) + 1) * 2;
  for (const up of [true, false]) {
    // A break: the least close beyond L (from L outward) that relation reads as broke that way.
    const closeAt = k => ticksFrom(L, k, tick, up);
    const broke = k => { const c = closeAt(k); const r = rel(finalCandle(f, { h: c, l: c, c })); return r.relation === 'broke' && r.dir === (up ? 'up' : 'down'); };
    const kb = least(broke, 1, 1, span);
    if (kb !== null) {
      const c = closeAt(kb);
      out.push({ rel: 'broke', dir: up ? 'up' : 'down', facts: { close: c, closeOp: up ? '>=' : '<=' }, bar: open => ({ o: open, h: Math.max(open, c), l: Math.min(open, c), c }) });
    }
    // A rejection the other way: traded beyond L (the first tick beyond, or already) and closed back on the near side.
    const beyond = ticksFrom(L, 1, tick, up);
    const back = ticksFrom(L, 1, tick, !up);
    const dir = up ? 'down' : 'up';
    const extreme = up ? Math.max(f.h, beyond) : Math.min(f.l, beyond);
    const c = { h: up ? extreme : back, l: up ? back : extreme, c: back };
    const r = rel(finalCandle(f, c));
    if (r.relation === 'rejected' && r.dir === dir) {
      const done = up ? f.h > L : f.l < L;
      out.push({ rel: 'rejected', dir, facts: { close: back, closeOp: up ? '<=' : '>=', extreme: done ? null : beyond, extremeOp: up ? '>=' : '<=', tradedBeyond: done },
        bar: open => ({ o: open, h: Math.max(open, back, done ? back : beyond), l: Math.min(open, back, done ? back : beyond), c: back }) });
    }
  }
  return out;
}

/** Whether the closing bar meets the candidate's trigger, by the code the at-close read runs (preconditions aside). */
function triggerMet(cand, bar) {
  if (!isObj(cand) || !isObj(cand.trigger) || !isObj(bar)) return false;
  const t = cand.trigger;
  if (cand.kind === 'momentum') return momentumRead(CF.factOf(bar, t.basis)) === t.dir;
  if (cand.kind === 'reaction') {
    const r = CF.relation(finalCandle(t.candle, bar), t.level, num(t.prevClose) === null ? NaN : t.prevClose);
    return Boolean(r) && r.relation === t.rel && r.dir === t.dir;
  }
  return false;
}

/** The section (see the header), or null when the account isn't flat. */
function possibleAtNextClose({ symbol, bars: raw, minutes, briefing, flat = false, registry = null, sizing = null, blackouts = null, clock = null, roundSteps = null, setupTf = SM.DEFAULTS.setupTf }) {
  if (flat !== true) return null;
  const bars = normalizeBars(raw);
  const last = bars[bars.length - 1];
  if (!last || !isObj(briefing) || briefing.asOf !== last.t || briefing.minutes !== minutes) throw new Error('possibleAtNextClose: the briefing must be the one built from these closed bars (its asOf the last bar)');
  const step = minutes * 60000;
  const nextOpen = Date.parse(last.t) + step;
  const next = { t: new Date(nextOpen).toISOString(), closedAt: new Date(nextOpen + step).toISOString() };
  const head = { symbol, minutes, asOf: last.t, closedAt: briefing.closedAt, next };
  const none = reasons => ({ ...head, none: reasons.join('; ') || 'no candidate', candidates: [], skipped: reasons });
  const win = sessionWindow(new Date(next.closedAt), clock);
  if (win.entries !== 'allowed') return none([`no entries at the next close: ${win.text}`]);
  const news = newsState(blackouts, new Date(next.closedAt));
  if (news.inBlackout !== false) return none([news.inBlackout ? `a news blackout at the next close (${news.reason || 'event'})` : news.error]);
  const tick = tickOf(symbol);
  if (!tick) return none(['the contract\'s tick is unknown']);
  const skipped = [];
  const x = { bars, minutes, symbol, registry: Array.isArray(registry) ? registry : shippedRegistry(), tick, next, sizing, blackouts, clock, roundSteps, skipped, briefing, setupTf };
  const candidates = [...momentumCandidates(x), ...reactionCandidates(x)].map((c, i) => ({ id: `P${i + 1}`, ...c }));
  if (!candidates.length) return none(skipped.length ? skipped : ['nothing in reach can fire']);
  return { ...head, none: null, candidates, skipped };
}

const usd = v => `$${r2(v)}`;
/** A plan's numbers as words. */
function planText(p, root) {
  if (!p || p.status !== 'ok') return `refused (${p ? p.why || p.status : 'no plan'})`;
  const size = p.size ? `; size: ${p.size.capSize} ${root} fit under ${usd(p.size.capUsd)} all in at ${usd(p.size.perContract)} a contract (${p.size.fits ? `the floor ${p.size.floor} fits` : `under the floor ${p.size.floor}: skip${p.size.stretchFits ? `, or exactly ${p.size.floor} by the floor stretch up to ${usd(p.size.stretchUsd)} while the attempt is healthy` : ''}`}); the floor fits with a stop of at most ${p.size.maxStopTicks} ticks` : '';
  return `entry ${p.entry.type} ${p.entry.price}, stop ${p.stop.price} (${p.stop.ticks}t, floor ${p.stop.floorTicks ?? '?'}t), target ${p.target.price}${p.target.mark ? ' (the 2R mark)' : ''}, R:R ${p.rr}${size}`;
}

const op = o => (o === '>=' ? 'at or above' : 'at or below');
/** One candidate's trigger as conditions on the closing candle. */
function triggerText(c) {
  const t = c.trigger;
  if (c.kind === 'momentum') {
    const b = t.basis;
    return `the closing ${c.tf} candle has range >= ${t.range} pts (${t.ticks} ticks; ${RANGE_ATR} x ATR(14) ${r2(b.atrPrev)} as of the candle before it), volume >= ${t.volume} (${VOL_RATIO} x the average ${r2(b.avg)} of the ${b.n} candles before it; whole contracts), and closes in its ${t.third} third (candle-facts closeLocation)`;
  }
  const f = t.candle;
  const so = `the ${c.tf} candle (opened ${etClock(f.t)}, open ${f.o}, so far high ${f.h} low ${f.l})`;
  if (t.rel === 'broke') return `${so} closes ${op(t.closeOp)} ${t.close}: beyond ${c.name}${String(c.name).endsWith(String(c.price)) ? '' : ` ${c.price}`} with most of its body beyond`;
  const beyond = t.tradedBeyond ? `has traded ${t.extremeOp === '>=' ? 'above' : 'below'} it already` : `trades ${op(t.extremeOp)} ${t.extreme}`;
  return `${so} ${beyond} and closes ${op(t.closeOp)} ${t.close}: back ${t.closeOp === '<=' ? 'below' : 'above'} ${c.name}${String(c.name).endsWith(String(c.price)) ? '' : ` ${c.price}`}`;
}

/** The section as briefing lines (et: a time formatter, the briefing's). */
function possibleLines(section, et = etClock) {
  if (!section) return [];
  const when = `the ${tfLabel(section.minutes)} bar ${et(section.next.t)}-${et(section.next.closedAt)} ET, from the bars closed by ${et(section.closedAt)} ET`;
  if (section.none) return [`- ${SECTION}: ${NONE} (${when}): ${section.none}.`];
  const root = String(section.symbol || '').split(':')[0];
  const out = [`- ${SECTION} (${when}; code's list for a bar plan: at the close the closed candle decides, on the at-close briefing):`];
  for (const c of section.candidates) {
    const pre = c.preconditions.length ? `; preconditions (code evaluates them again at the close): ${c.preconditions.map(preconditionText).join(', ')}` : '';
    out.push(`  - ${c.id} ${c.kind === 'momentum' ? c.name : c.tf} ${c.side} "${c.read}": fires if ${triggerText(c)}${pre}. Plan (code): ${c.rule.entry}; stop ${c.rule.stop}; target ${c.rule.target}. At the threshold candle (O ${c.threshold.bar.o} H ${c.threshold.bar.h} L ${c.threshold.bar.l} C ${c.threshold.bar.c}): ${planText(c.threshold.plan, root)}${c.threshold.reads.length ? `; reads ${c.threshold.reads.map(r => `"${r}"`).join(', ')}` : ''}.`);
  }
  return out;
}

/** The prepare briefing: the briefing's text with the section after its summary. */
function renderPrepareBriefing(b, section, { now = new Date() } = {}) {
  const text = renderBriefing(b, { now });
  const lines = possibleLines(section);
  if (!lines.length) return text;
  const cut = text.indexOf('\n\nDetail by timeframe:');
  return cut < 0 ? `${text}${lines.join('\n')}\n` : `${text.slice(0, cut)}\n${lines.join('\n')}${text.slice(cut)}`;
}

module.exports = { NONE, SECTION, possibleAtNextClose, triggerMet, possibleLines, renderPrepareBriefing, momentumThresholds, reactionKinds };
