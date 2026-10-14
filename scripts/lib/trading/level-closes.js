'use strict';

/**
 * The closes against the session's levels: whether this bar's close crossed a level, and how many closes in a row sit
 * beyond (or back inside) the prior RTH day's value area. Primitives the briefing places with their owners (the VWAP,
 * today's opening range, the location against value); each reads bars 0..i only, and the series the rules language
 * reads, compared the same way (strictly: a close on an edge is neither beyond nor inside).
 *
 *   crossed(bars, level, i, resets)      'up' when the close crossed above `level` (a series) this bar, the previous
 *                                        close at or below it; 'down' the mirror; null otherwise, or a level missing at
 *                                        either bar, or one that started over between them (`resets(i)`: a jump)
 *   valueSide(c, va)                     'above' (c > vah), 'below' (c < val), 'inside' (strictly between) or 'at' (on
 *                                        an edge)
 *   closesInARow(bars, va, i, side, keep)   the closes in a row ending at bar i on `side` of `va`, while keep(k) holds
 *                                        (at most MAX_CLOSES)
 *   levelCloses(bars, i, { levels })     { vwapCrossed, openingRangeCrossed, closesBeyondValue, backInsideValue }: each
 *                                        only when it happened (an empty object when nothing did); levels:
 *                                        rules.causalLevels(bars) (its rth_open)
 *     vwapCrossed          { rth?, session? }: the close crossed that VWAP this bar ('up' | 'down')
 *     openingRangeCrossed  'up' (above its high) | 'down' (below its low), the range complete at both bars
 *     closesBeyondValue    { side: 'above' | 'below', closes }: this close and those before it beyond the prior value area
 *                          as it stands now (the rules compare close[1] with today's prior_vah)
 *     backInsideValue      { opened: 'above' | 'below', closes }: today's RTH open was beyond the prior value area and
 *                          this close and those before it today (RTH only) are back inside it
 */

const ind = require('./indicators');
const vp = require('./volume-profile');

const RTH_OPEN = 9 * 60 + 30;
const RTH_CLOSE = 16 * 60;
const GLOBEX_OPEN = 18 * 60;
const ORB_MINUTES = 15; // market-snapshot PARAMS.orbMinutes: the opening range the briefing shows
const MAX_CLOSES = 20;

const MEMO = new WeakMap();
const memo = (bars, key, make) => {
  if (!MEMO.has(bars)) MEMO.set(bars, new Map());
  const m = MEMO.get(bars);
  if (!m.has(key)) m.set(key, make());
  return m.get(key);
};

function crossed(bars, level, i, resets = () => false) {
  if (i < 1 || !Number.isFinite(level[i]) || !Number.isFinite(level[i - 1]) || resets(i)) return null;
  const [p, c] = [bars[i - 1].c, bars[i].c];
  if (p <= level[i - 1] && c > level[i]) return 'up';
  if (p >= level[i - 1] && c < level[i]) return 'down';
  return null;
}

const valueSide = (c, va) => (c > va.vah ? 'above' : c < va.val ? 'below' : c > va.val && c < va.vah ? 'inside' : 'at');

function closesInARow(bars, va, i, side, keep = () => true) {
  let n = 0;
  for (let k = i; k >= 0 && n < MAX_CLOSES && keep(k) && valueSide(bars[k].c, va) === side; k -= 1) n += 1;
  return n;
}

function levelCloses(bars, i, { levels = null } = {}) {
  const out = {};
  if (!(i >= 0 && i < bars.length)) return out;
  const vw = memo(bars, 'vwap', () => ({ rth: ind.anchoredVwap(bars, RTH_OPEN, RTH_CLOSE), session: ind.anchoredVwap(bars, GLOBEX_OPEN) }));
  const newSession = k => ind.sessionKey(bars[k].t, GLOBEX_OPEN) !== ind.sessionKey(bars[k - 1].t, GLOBEX_OPEN);
  const vwap = { rth: crossed(bars, vw.rth, i), session: crossed(bars, vw.session, i, newSession) };
  const v = Object.fromEntries(Object.entries(vwap).filter(([, x]) => x));
  if (Object.keys(v).length) out.vwapCrossed = v;
  const or = memo(bars, 'or', () => ind.openingRange(bars, ORB_MINUTES));
  const orDir = crossed(bars, or.high, i) === 'up' ? 'up' : crossed(bars, or.low, i) === 'down' ? 'down' : null;
  if (orDir) out.openingRangeCrossed = orDir;
  const prior = memo(bars, 'prior', () => vp.profileSeries(bars, 'prior_rth', { options: vp.DEFAULTS }));
  const va = { vah: prior.vah[i], val: prior.val[i] };
  if (!Number.isFinite(va.vah) || !Number.isFinite(va.val)) return out;
  const side = valueSide(bars[i].c, va);
  if (side === 'above' || side === 'below') out.closesBeyondValue = { side, closes: closesInARow(bars, va, i, side) };
  const open = levels && levels.rth_open ? levels.rth_open[i] : NaN;
  const today = ind.sessionKey(bars[i].t, RTH_OPEN);
  const inRth = k => { const m = ind.etInfo(bars[k].t).minute; return m >= RTH_OPEN && m < RTH_CLOSE && ind.sessionKey(bars[k].t, RTH_OPEN) === today; };
  if (side === 'inside' && Number.isFinite(open) && inRth(i)) {
    const opened = open > va.vah ? 'above' : open < va.val ? 'below' : null;
    if (opened) out.backInsideValue = { opened, closes: closesInARow(bars, va, i, 'inside', inRth) };
  }
  return out;
}

module.exports = { MAX_CLOSES, crossed, valueSide, closesInARow, levelCloses };
