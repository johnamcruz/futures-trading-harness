'use strict';

/**
 * The open trade's manage read: the levels a managed cycle sets its stop from, computed by code from closed bars, for
 * the line the model answers every cycle with `STOP <price|hold>: <reason>` (manage-position; stop-line.js parses it).
 * Facts only, no advice (the decision is the skill's): the code floor's early lock (the rulebook's
 * lock_at_r / lock_to_ticks, exit-trail.js: the runner moves it); the 15m BOS the trade's way since entry and its
 * protected swing (structure-events.js protectedOf: the swing the owner's rule names, known at the break; not the code
 * floor's fractal swing, which confirms two candles later), held or broken by a 15m close past the tie (protected-status.js,
 * the Break quality line's rule: a tie holds), and the stop a tick beyond it;
 * a 15m CHoCH against since entry; the warning giveback level (warning_giveback_r behind the best price). Each level
 * says whether it is tighter than the working stop (by a tick or more), or past the price (a stop there would fill at
 * once). The working stop and the best price in R are the Position line's (position-read.js), not repeated here. One
 * basis with it: `from` the first bar counted (the runner's bar rule, open-trades.js), `best` the held trade's best price
 * when the runner holds the trade. Pure; only bars closed by the last are read.
 *
 *   manageRead({ side, entry, risk, stop, openedAt, bars, base, tick, exit, from, best })   the facts, or { unavailable }
 *   manageReadLine(read, { level })                                             one line for the prompt
 */

const { breaksOf, protectedOf } = require('./structure-events');
const PS = require('./protected-status');
const ind = require('./indicators');
const { completedCandlesAt } = require('./candle-facts');
const { snapStop } = require('./trail');
const { label } = require('./mtf');

const AN = require('../tunables').analysis(); // config/analysis.json: the swing confirmation, the structure frames
const K = AN.indicators.swingK;
const EQUAL_ATR = AN.marketState.equalAtr; // the protected swing's tie (protected-status.js), the Break quality line's
const FRAME = Math.max(...AN.tradeRead.frames); // the structure frame (15m), as the trade read's

const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

function manageRead({ side, entry, risk, stop, openedAt, bars, base, tick, exit = null, from = null, best: heldBest = null }) {
  const s = side === 'long' ? 1 : side === 'short' ? -1 : 0;
  const opened = Date.parse(openedAt);
  if (!s || !Number.isFinite(entry) || !(risk > 0) || !(tick > 0) || !Number.isFinite(opened)) return { unavailable: 'no side, entry, risk, tick or fill time' };
  const list = (Array.isArray(bars) ? bars : []).filter(b => b && Number.isFinite(Date.parse(b.t)) && [b.o, b.h, b.l, b.c].every(Number.isFinite));
  const start = Number.isFinite(Date.parse(from)) ? Date.parse(from) : opened;
  const since = list.filter(b => Date.parse(b.t) >= start);
  if (!since.length) return { unavailable: 'no closed bar since the fill yet' };
  const R = x => (Number.isFinite(x) ? r2((s * (x - entry)) / risk) : null);
  const best = Number.isFinite(heldBest) ? heldBest : s > 0 ? Math.max(...since.map(b => b.h)) : Math.min(...since.map(b => b.l));
  const working = Number.isFinite(stop) ? stop : null;
  const tighter = x => working === null || s * (x - working) > 0; // both on the tick grid: by a tick or more
  // A level at or past the last close is no stop to rest: a modify there would fill at once (or be refused).
  const lastClose = since[since.length - 1].c;
  const past = x => s * (lastClose - x) <= 0;
  const bestR = R(best);

  const a = exit || {};
  const lockOn = Number.isFinite(a.lockAtR) && Number.isInteger(a.lockToTicks);
  const lockStop = lockOn ? snapStop(entry + s * a.lockToTicks * tick, s, tick) : null;
  const lock = lockOn ? { atR: a.lockAtR, stop: lockStop, reached: bestR >= a.lockAtR } : null;

  const c = completedCandlesAt({ bars: list, base, minutes: FRAME });
  const cs = c.unavailable ? [] : c.candles.slice(0, c.j + 1);
  const way = s > 0 ? 'up' : 'down';
  const breaks = breaksOf(cs, K).filter(x => Date.parse(cs[x.i].closedAt) > opened);
  const last = breaks[breaks.length - 1] || null;
  let bos = null;
  const lastWay = [...breaks].reverse().find(x => x.direction === way && x.kind === 'BOS');
  if (lastWay) {
    // Broken by the one predicate (swing-holds D2): a 15m close past the swing by more than the tie at that candle.
    const band = { atr: ind.atr(cs), equalAtr: EQUAL_ATR };
    const p = protectedOf(cs, lastWay, band);
    if (p) {
      const broken = Boolean(p.brokenAt);
      // A close past the swing inside the tie: it holds, and the line names the tie, as the Break quality line does.
      const tied = !broken && PS.statusOf(cs, { level: p.level, legSide: way, after: lastWay.i, ...band }).tied;
      const at = snapStop(p.level - s * tick, s, tick);
      bos = { level: p.level, broken, tied, stop: at, tighter: !broken && tighter(at) && !past(at), past: past(at) };
    }
  }
  const choch = last && last.kind === 'CHoCH' && last.direction !== way ? { level: last.level, at: last.at } : null;
  const give = Number.isFinite(a.warningGivebackR) ? snapStop(best - s * a.warningGivebackR * risk, s, tick) : null;
  const warning = give !== null ? { r: a.warningGivebackR, stop: give, tighter: tighter(give) && !past(give), past: past(give) } : null;
  return { side, tf: label(FRAME), working, workingR: R(working), best, bestR, lock, bos, choch, warning, unavailable: c.unavailable ? `${label(FRAME)}: ${c.unavailable}` : null };
}

const sR = x => (x === null ? '?' : `${x >= 0 ? '+' : ''}${x}R`);

function manageReadLine(m, { level = r2 } = {}) {
  if (!m || (m.unavailable && m.best === undefined)) return `Manage read: unavailable (${m ? m.unavailable : 'not computed'}).`;
  const t = (x, past) => (past ? 'past the price: a stop there would fill at once' : x ? 'tighter than the working stop' : 'not tighter');
  const lock = m.lock ? `code floor: from ${sR(m.lock.atR)} the runner holds the stop at ${level(m.lock.stop)} (${m.lock.reached ? 'reached' : 'not reached yet'})` : 'code floor: no early lock';
  const bos = m.bos ? `${m.tf} BOS ${m.side === 'long' ? 'up' : 'down'} since entry: protected swing ${level(m.bos.level)} ${m.bos.broken ? 'BROKEN by a close' : `holds${m.bos.tied ? ' (tested, a tie)' : ''}, stop beyond it ${level(m.bos.stop)} (${t(m.bos.tighter, m.bos.past)})`}` : `${m.tf} BOS the trade's way since entry: none`;
  const choch = m.choch ? `${m.tf} CHoCH against since entry: through ${level(m.choch.level)}` : `${m.tf} CHoCH against since entry: none`;
  const warn = m.warning ? `warning giveback (${m.warning.r}R behind the best): ${level(m.warning.stop)} (${t(m.warning.tighter, m.warning.past)})` : 'warning giveback: none set';
  return `Manage read (answer every cycle with one line "STOP <price|hold>: <reason>"; modify_order only when tighter): ${lock}; ${bos}; ${choch}; ${warn}${m.unavailable ? `; ${m.unavailable}` : ''}.`;
}

module.exports = { manageRead, manageReadLine };
