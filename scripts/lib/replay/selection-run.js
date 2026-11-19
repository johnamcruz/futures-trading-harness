'use strict';

/**
 * P1: the selection scorecard's inputs read from a replay run (selection-score.js scores them): the run home
 * (`home`: its cycle logs, entry orders and events) and its replay folder (`runDir`: its served bars). Read only.
 *
 *   picksFrom(cycles)              each trade cycle's chosen MTF candidate line(s) the 1h's way, from the cycle's prompt
 *                                  ("- MTF candidate LONG (chosen): <model> at stage ..., pullback #N of this 1h leg"):
 *                                  [{ at (the cycle's bar close), side, model, rank }]
 *   entriesFrom(orders, events)    the run's MTF entries (an entry order with the gate's mtf stamp) with their exit (the
 *                                  runner's position_closed after it: its price, R and who closed it; none: a bracket's
 *                                  own stop or target, or still open)
 *   tookAt(picks, entries, stepMs) marks each pick taken when an MTF entry its way was placed in its cycle's bar
 *   refRiskOf(entries, picks)      the run's reference 1R: the median entry's structural stop distance, else the median
 *                                  candidate line's stop points; null when neither is known
 *   readRun({ home, runDir, session, minutes, symbol })   { legs, entries, picks, refRiskPts, rows } (legs: goal-metrics.js
 *                                  trendLegs on the served bars of the run's days, legsFrom; rows: candidateRows on the
 *                                  ruler, the symbol's tick)
 *   candidateRows(picks, ruler, { lastBar })   the selection rows (selection-score.js pickTable)
 */

const fs = require('fs');
const path = require('path');
const FP = require('./selection-score');

const CAND = /^- MTF candidate (LONG|SHORT) \(chosen\): (aggressive|balanced|conservative) at stage [^,]+, trigger (\S+ \S+ \S+ \S+)[^;]*; .*?context: .*?(?:pullback #(\d+) of this 1h leg|its rank in the 1h leg not known).*?structural stop ([\d.]+)(?:: ([\d.]+) pts)?/;
// The model's decision (the mtf-entry skill): one labelled line, at a line's start, case-sensitive, in the cycle's
// output; the LAST such line wins; none: 'unlabelled' (counted apart, never read as a pass).
const DECISION = /^SELECTION: (ENTER|WAIT|PASS)(?: - |$)/;
const decisionOf = text => { let d = null; for (const l of String(text || '').split('\n')) { const m = DECISION.exec(l.trim()); if (m) d = m[1]; } return d || 'unlabelled'; };

function picksFrom(cycles) {
  const out = [];
  for (const c of cycles || []) {
    for (const line of String(c.prompt || '').split('\n')) {
      const m = CAND.exec(line);
      if (m) out.push({ at: c.bar, side: m[1].toLowerCase(), model: m[2], trigger: m[3], rank: m[4] ? Number(m[4]) : null, stop: Number(m[5]), stopPts: m[6] ? Number(m[6]) : null, decision: decisionOf(c.output) });
    }
  }
  // One per cycle bar and side (the prompt may hold the line twice: the briefing and a role's report).
  const seen = new Set();
  return out.filter(p => { const k = `${p.at}|${p.side}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

function entriesFrom(orders, events) {
  const closes = (events || []).filter(e => e && e.kind === 'position_closed').sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return (orders || []).filter(o => o && o.composed && o.composed.mtf).map(o => {
    const side = /^(buy|long)$/i.test(o.side) ? 'long' : 'short';
    const c = closes.find(e => Date.parse(e.at) > Date.parse(o.at) && (!e.side || e.side === side));
    const why = c ? String(c.why || '') : '';
    return {
      at: o.at, side, rank: o.composed.mtf.rank ?? null, record: o.composed.record || null, entry: o.composed.entry ?? null, stop: o.composed.stop ?? null,
      exit: c ? c.lastClose ?? null : null, exitAt: c ? c.at : null, r: c && Number.isFinite(c.rNow) ? Math.round(c.rNow * 100) / 100 : null,
      exitBy: !c ? 'open' : /previous (high|low)/.test(why) ? 'runner' : /trail|time stop/.test(why) ? 'trail' : /\[exit\]|model/.test(why) ? 'model' : 'runner',
    };
  });
}

function tookAt(picks, entries, stepMs) {
  return picks.map(p => ({ ...p, took: entries.some(e => e.side === p.side && Date.parse(e.at) >= Date.parse(p.at) && Date.parse(e.at) < Date.parse(p.at) + stepMs) }));
}

// The candidate's trading session (clock.js tradingDayKey, the 18:00 ET rollover).
const dayOf = at => require('../trading/clock').tradingDayKey(new Date(at));

/**
 * The selection rows (pickTable's): one per candidate (side, model and trigger: printed on consecutive bars it is one
 * candidate), its state from the model's decisions (took: an entry its way placed while it printed; waited: a WAIT still
 * open at its last print; passed: a PASS, or a WAIT the candidate outlived to void or expire), and its outcome on the ruler
 * (`ruler(pick)`, the first print's: { R, points } or null).
 */
function candidateRows(picks, ruler, { lastBar = null } = {}) {
  const groups = new Map();
  for (const p of picks) { const k = `${p.side}|${p.model}|${p.trigger}|${dayOf(p.at)}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
  return [...groups.entries()].map(([key, ps]) => {
    const list = ps.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const last = list[list.length - 1];
    const state = list.some(p => p.took || p.decision === 'ENTER') ? 'took'
      : list.some(p => p.decision === 'PASS') ? 'passed'
        : last.decision === 'WAIT' ? (lastBar && Date.parse(last.at) >= Date.parse(lastBar) ? 'waited' : 'passed') : 'unlabelled';
    return { key, day: dayOf(list[0].at), side: list[0].side, model: list[0].model, first: list[0].at, state, outcome: ruler(list[0]) };
  });
}

const median = xs => { const a = xs.filter(x => Number.isFinite(x) && x > 0).sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : null; };
const refRiskOf = (entries, picks) => median(entries.map(e => (Number.isFinite(e.entry) && Number.isFinite(e.stop) ? Math.abs(e.entry - e.stop) : NaN))) ?? median(picks.map(p => p.stopPts));

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
const jsonl = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean) : []);

function readRun({ home, runDir, session, minutes, symbol = null }) {
  const days = fs.existsSync(path.join(home, 'logs', 'cycles')) ? fs.readdirSync(path.join(home, 'logs', 'cycles')).sort() : [];
  const cycles = days.flatMap(d => fs.readdirSync(path.join(home, 'logs', 'cycles', d)).filter(f => f.endsWith('-trade.json')).map(f => readJson(path.join(home, 'logs', 'cycles', d, f), null)).filter(Boolean)
    .map(c => ({ bar: c.cycleAt || c.at, prompt: c.prompt, output: finalText(c) })));
  const orders = readJson(path.join(home, 'entry-orders.json'), []);
  const events = days.flatMap(d => jsonl(path.join(home, 'logs', `events-${d}.jsonl`)));
  const entries = entriesFrom(Array.isArray(orders) ? orders : [], events);
  const picks = tookAt(picksFrom(cycles), entries, minutes * 60000);
  const bars = require('./trend-capture').servedBars(runDir, minutes);
  const legs = bars.length ? FP.legsFrom(require('../eval/goal-metrics').trendLegs(bars, days, { session, minutes })) : [];
  return { legs, entries, picks, refRiskPts: refRiskOf(entries, picks), rows: candidateRows(picks, rulerOf(bars, minutes, symbol), { lastBar: cycles.length ? cycles[cycles.length - 1].bar : null }) };
}

/**
 * The ruler (one for every candidate, taken or not): the shipped exit (experience-log.js limitOutcome with the policy's
 * composed exit: the 2R mark arms the trail) from the first print's close, a limit at that close with its structural stop
 * (never moved), flat at the end of day. null when it can't be measured (no bars, the stop on the wrong side, unfilled).
 */
function rulerOf(bars, minutes, symbol) {
  if (!bars.length) return () => null;
  const { limitOutcome } = require('../learning/experience-log');
  const GT = require('../eval/goal-trades');
  const P = GT.shippedOf(require('path').resolve(__dirname, '..', '..', '..'), {});
  const tfMs = minutes * 60000;
  const list = bars.map(b => ({ ...b, ms: Date.parse(b.t) }));
  const { tickOf } = require('../trading/contracts');
  const tick = tickOf(symbol);
  if (!(tick > 0)) return () => null;
  const days = [...new Set(list.map(b => require('../trading/clock').tradingDayKey(new Date(b.ms))))].sort();
  const clock = require('../learning/setup-library').runnerClock({ from: days[0], to: days[days.length - 1] });
  return p => {
    const at = Date.parse(p.at);
    const bar = list.find(b => b.ms + tfMs === at);
    if (!bar || !Number.isFinite(p.stop)) return null;
    const s = p.side === 'long' ? 1 : -1;
    const risk = s * (bar.c - p.stop);
    if (!(risk > 0)) return null;
    const o = limitOutcome({ bars: list, tfMs, side: p.side, entry: bar.c, stop: p.stop, target: bar.c + s * P.minRR * risk, fromMs: at, expiresMs: at + tfMs, eodMs: clock.eodOf(at), tick, plan: P.exit.plan });
    return o.filled && Number.isFinite(o.R) ? { R: o.R, points: Math.round(o.R * risk * 100) / 100 } : null;
  };
}

module.exports = { decisionOf, picksFrom, entriesFrom, tookAt, refRiskOf, candidateRows, readRun };
