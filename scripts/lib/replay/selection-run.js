'use strict';

/**
 * P1: the selection scorecard's rows read from a replay run (selection-score.js pickTable scores them): the run home
 * (`home`: its cycle records and entry orders) and its replay folder (`runDir`: its served bars). Read only.
 *
 *   selectionOf(text)              the model's decision line (the mtf-entry skill): { decision: ENTER | WAIT | PASS |
 *                                  UNLABELLED, reason }. A labelled line (label-line.js, the quiz's rule: the label at the
 *                                  line's start, its colon or a dash, markdown bold around them), the label and the
 *                                  decision word case-sensitive; the LAST such line wins; none: UNLABELLED
 *   decisionOf(text)               selectionOf(text).decision
 *   barOf(cycle, tfMs)             the bar a cycle decided on: its prompt's bar briefing ("as of <time>"), else its
 *                                  cycleAt floored to the bar grid (cycleAt is the replay clock at the cycle's start: the
 *                                  bar's close plus the runner's seconds)
 *   picksFrom(cycles, tfMs)        each cycle's chosen MTF candidate line(s) the 1h's way ("- MTF candidate LONG (chosen):
 *                                  <model> at stage ..."): [{ at (the bar), side, model, trigger, rank, stop, stopPts,
 *                                  decision, reason }], one per bar and side
 *   ordersFrom(orders)             the run's MTF entry orders (entry-orders.json with the gate's mtf stamp): [{ at, bar
 *                                  (the stamp's: the bar the gate judged), side, model, instanceId, entry, stop }]
 *   candidateRows(picks, orders, ruler, { lastBar })   pickTable's rows (one per candidate)
 *   rulerOf(bars, minutes, symbol, { validBars, minRR, plan })   the ruler (below)
 *   readRun({ home, runDir, minutes, symbol })   { orders, picks, rows }
 */

const fs = require('fs');
const path = require('path');
const { labelLines } = require('../label-line');

const CAND = /^- MTF candidate (LONG|SHORT) \(chosen\): (aggressive|balanced|conservative) at stage [^,]+, trigger (\S+ \S+ \S+ \S+)[^;]*; .*?context: .*?(?:pullback #(\d+) of this 1h leg|its rank in the 1h leg not known).*?structural stop ([\d.]+)(?:: ([\d.]+) pts)?/;
const WORD = /^\**\s*(ENTER|WAIT|PASS)\b\**\s*(?:[-–—:.,]\s*)?(.*)$/;
function selectionOf(text) {
  let out = { decision: 'UNLABELLED', reason: '' };
  for (const l of labelLines(text, 'SELECTION')) { const m = WORD.exec(l); if (m) out = { decision: m[1], reason: m[2].replace(/^[-–—:\s]+/, '').trim() }; }
  return out;
}
const decisionOf = text => selectionOf(text).decision;

const ASOF = /^--- bar_briefing \{[^}]*\} as of (\S+) ---$/m;
function barOf(c, tfMs) {
  const m = ASOF.exec(String((c && c.prompt) || ''));
  if (m && Number.isFinite(Date.parse(m[1]))) return new Date(Date.parse(m[1])).toISOString();
  const at = Date.parse(c && (c.cycleAt || c.at));
  return Number.isFinite(at) && tfMs > 0 ? new Date(Math.floor(at / tfMs) * tfMs).toISOString() : null;
}

function picksFrom(cycles, tfMs) {
  const out = [];
  for (const c of cycles || []) {
    const at = barOf(c, tfMs);
    if (!at) continue;
    const { decision, reason } = selectionOf(c.output);
    for (const line of String(c.prompt || '').split('\n')) {
      const m = CAND.exec(line);
      if (m) out.push({ at, side: m[1].toLowerCase(), model: m[2], trigger: m[3], rank: m[4] ? Number(m[4]) : null, stop: Number(m[5]), stopPts: m[6] ? Number(m[6]) : null, decision, reason });
    }
  }
  // One per bar and side (the prompt may hold the line twice: the briefing and a role's report).
  const seen = new Set();
  return out.filter(p => { const k = `${p.at}|${p.side}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

const sideOf = s => (/^(0|buy|long)$/i.test(String(s)) ? 'long' : /^(1|sell|short)$/i.test(String(s)) ? 'short' : null);
function ordersFrom(orders) {
  return (orders || []).filter(o => o && o.composed && o.composed.mtf && Number.isFinite(Date.parse(o.composed.mtf.bar))).map(o => ({
    at: o.at, bar: new Date(Date.parse(o.composed.mtf.bar)).toISOString(), side: sideOf(o.composed.side || o.side), model: o.composed.mtf.model || null,
    instanceId: o.composed.mtf.instanceId || null, entry: o.composed.entry ?? null, stop: o.composed.stop ?? null,
  }));
}

// The candidate's trading session (clock.js tradingDayKey, the 18:00 ET rollover).
const dayOf = at => require('../trading/clock').tradingDayKey(new Date(at));

/**
 * The selection rows: one per candidate (side, model and trigger in a session: printed on consecutive bars it is one
 * candidate). Its state (selection-score.js pickTable): took when an MTF entry order was placed for it (its side and
 * model, on a bar it printed on: the gate's stamp), scored at that bar; else enterNoOrder (an ENTER and no order), scored
 * at its first ENTER; else passed (a PASS, or a WAIT it outlived), waited (a WAIT still open at the run's last bar) or
 * unlabelled, scored at its first print. `outcome` is the ruler's at the scored bar; `firstOutcome` the first print's.
 */
function candidateRows(picks, orders, ruler, { lastBar = null } = {}) {
  const groups = new Map();
  for (const p of picks) { const k = `${p.side}|${p.model}|${p.trigger}|${dayOf(p.at)}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
  return [...groups.entries()].map(([key, ps]) => {
    const list = ps.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const last = list[list.length - 1];
    const order = (orders || []).find(o => o.side === list[0].side && o.model === list[0].model && list.some(p => p.at === o.bar)) || null;
    const enter = list.find(p => p.decision === 'ENTER') || null;
    const state = order ? 'took' : enter ? 'enterNoOrder'
      : list.some(p => p.decision === 'PASS') ? 'passed'
        : last.decision === 'WAIT' ? (lastBar && Date.parse(last.at) >= Date.parse(lastBar) ? 'waited' : 'passed') : 'unlabelled';
    const scored = order ? list.find(p => p.at === order.bar) : enter || list[0];
    return { key, day: dayOf(list[0].at), side: list[0].side, model: list[0].model, first: list[0].at, at: scored.at, state, order, outcome: ruler(scored), firstOutcome: ruler(list[0]) };
  });
}

// The head trader's final text (its result: the SELECTION line stands before the CYCLE RESULT line), by its harness;
// a record without a transcript: its result line. Read only.
function finalText(c) {
  if (!c || !c.transcript) return c && c.result ? String(c.result) : null;
  try {
    if (c.harness === 'claude') return require('../transcript').claudeRunResult(c.transcript).text;
    if (c.harness === 'opencode') return require('../opencode').runResult(c.transcript).text;
  } catch (_err) { /* unreadable: the raw text */ }
  return String(c.transcript);
}

const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_e) { return dflt; } };

/**
 * The ruler (one for every candidate, taken or not): a limit at the scored bar's close, good for the composed record's
 * `validBars` base bars (trade_lifecycle valid_bars), with the printed structural stop. A fill at a better open (a gap
 * through the limit) keeps the structural stop, as the runner's fillGuard re-anchors it, and the R is on the fill to that
 * stop (the runner's basis). The exit is the shipped one (experience-log.js limitOutcome with the policy's composed exit
 * plan: the minRR mark arms the trail), flat at the end of day. A limit that never fills: no trade, { R: 0, points: 0,
 * filled: false }. null when it can't be measured (no bars, no bar at the time, the stop on the wrong side).
 */
function rulerOf(bars, minutes, symbol, { validBars, minRR, plan } = {}) {
  if (!bars.length) return () => null;
  if (!(validBars >= 1) || !(minRR > 0)) throw new Error('rulerOf: validBars and minRR are required (the shipped trade_lifecycle\'s)');
  const { limitOutcome } = require('../learning/experience-log');
  const tfMs = minutes * 60000;
  const list = bars.map(b => ({ ...b, ms: Date.parse(b.t) }));
  const tick = require('../trading/contracts').tickOf(symbol);
  if (!(tick > 0)) return () => null;
  const days = [...new Set(list.map(b => dayOf(b.ms)))].sort();
  const clock = require('../learning/setup-library').runnerClock({ from: days[0], to: days[days.length - 1] });
  const r2 = x => Math.round(x * 100) / 100;
  return p => {
    const at = Date.parse(p.at);
    const bar = list.find(b => b.ms + tfMs === at);
    if (!bar || !Number.isFinite(p.stop)) return null;
    const s = p.side === 'long' ? 1 : -1;
    if (!(s * (bar.c - p.stop) > 0)) return null;
    const run = entry => limitOutcome({ bars: list, tfMs, side: p.side, entry, stop: p.stop, target: entry + minRR * (entry - p.stop), fromMs: at, expiresMs: at + validBars * tfMs, eodMs: clock.eodOf(at), tick, plan });
    let o = run(bar.c);
    if (o.filled === false) return { R: 0, points: 0, filled: false };
    // A better fill: the same limit at the fill price fills on the same bar, its brackets from the structural stop.
    if (o.filled && Number.isFinite(o.entryPrice) && Math.abs(o.entryPrice - bar.c) >= tick / 2) o = run(o.entryPrice);
    if (!o.filled || !Number.isFinite(o.R)) return null;
    return { R: o.R, points: r2(o.R * s * (o.entryPrice - p.stop)), filled: true, fill: o.entryPrice };
  };
}

function readRun({ home, runDir, minutes, symbol = null }) {
  const tfMs = minutes * 60000;
  const dir = path.join(home, 'logs', 'cycles');
  const days = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  const cycles = days.flatMap(d => fs.readdirSync(path.join(dir, d)).filter(f => f.endsWith('-trade.json')).sort().map(f => readJson(path.join(dir, d, f), null)).filter(Boolean)
    .map(c => ({ prompt: c.prompt, cycleAt: c.cycleAt || c.at, output: finalText(c) })));
  const orders = ordersFrom(readJson(path.join(home, 'entry-orders.json'), []));
  const picks = picksFrom(cycles, tfMs);
  const bars = require('./trend-capture').servedBars(runDir, minutes);
  const P = bars.length ? require('../eval/goal-trades').shippedOf(path.resolve(__dirname, '..', '..', '..'), {}) : null;
  const ruler = P ? rulerOf(bars, minutes, symbol, { validBars: P.validBars, minRR: P.minRR, plan: P.exit.plan }) : () => null;
  const lastBar = cycles.length ? barOf(cycles[cycles.length - 1], tfMs) : null;
  return { orders, picks, rows: candidateRows(picks, orders, ruler, { lastBar }) };
}

module.exports = { selectionOf, decisionOf, barOf, picksFrom, ordersFrom, candidateRows, rulerOf, readRun };
