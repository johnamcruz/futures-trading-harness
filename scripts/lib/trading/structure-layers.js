'use strict';

/**
 * The Market state's structure layers (round 20, the owner's three layers: "1. Internal structure: Small swings inside
 * the larger market structure. These can change without invalidating the main trend. 2. Protected structure: The
 * meaningful swing level protecting the current directional trend. A break of this level carries greater structural
 * significance."), computed on the 3m bars from the RTH open, bar by bar, causal: a snapshot at bar z reads bars[0..z]
 * only. Pure: no files, no clock; every threshold is passed in (config/analysis.json marketState, through tunables).
 *
 *   rthBreaks(bars, from, atr, p, all?)      the k=2 breaks (structure-events.js breaksOf) whose candle closed at or
 *                     after 09:30 ET (index >= from: the bar opening 09:27), each with `strong` (cisd.js strongCandle the
 *                     break's way on ATR(14) of the bar before: the displacement candle). A break's follow-through is read
 *                     as of a bar: failedAt(bars, b, z, p) a close back through its level within followBars, by bar z.
 *   structureSeries(bars, breaks, from, atr, p)   the protected machine, one snapshot per bar index from `from` (an array
 *                     indexed by bar; null before the first RTH break). The leg's protected level is the origin of the
 *                     move that made its last break its way (protectedOf, decision 2); a close through it by more than
 *                     equalAtr x ATR(14) is the only invalidation of the leg (a tie is not a break, decision 8). Inside
 *                     an intact leg a k=2 break against followed by a second break the same way, the first not failed by
 *                     the second's bar (the owner's CHoCH then BOS), confirms a transition without invalidating the level:
 *                     the read moves to the new leg at the BOS bar (a flip, `byRule` 'choch-bos', the new leg intact from
 *                     it), the old level kept as `flip.oldLevel`, `flip.oldBroken` false until a close goes through it
 *                     (the owner's table: CHoCH then BOS, a confirmed transition). After a close-through the new side is `broken`
 *                     (unconfirmed) until a break its way confirms it; a break the old way, or a close back through the
 *                     old level within followBars, hands the leg back (the hand-back: the protected break failed and the
 *                     old side keeps the read; the machine's rule, not the owner's text, kept as D1 of swing-holds). The
 *                     handed-back level was closed through: `levelBroken` true until a break the leg's way sets a new
 *                     level, so no printer says it holds (protected-status.js R2). Every close-through and tie test is
 *                     protected-status.js through / tieAt. Snapshot: { side, level, origin, status, levelBroken, levelAgo
 *                     (bars since the level was set), legOK (intact and a break its way not failed), sinceProgress (bars
 *                     since a new extreme by close), internal, lastInternal (the last break against: { direction, level,
 *                     barsAgo }), lastWay (the last break its way: { kind, direction, level, barsAgo, strong }), resumed,
 *                     flip { barsAgo, strong, disp (its candle or one within dispBars strong the new way), held, oldSide,
 *                     oldLevel, byRule, oldBroken, extreme (a failed break's extreme, flip bar to the close back: fixed at
 *                     the hand-back; else null), inside (the latest close back on the old side of oldLevel past the tie) },
 *                     flipsIn }
 *   momentumAt(bars, breaks, snap, z, from, atr, p)   the momentum condition around an intact leg (the owner: "Displacement
 *                     detects emerging pressure. Failed continuation detects loss of directional control."):
 *                     dispAgainst (a strong candle against the leg in the last pressBars RTH bars), breakAgainst (a k=2
 *                     break against in that window), trigger (a break against that is itself strong, or a break against
 *                     with a displacement against: "a strong countertrend displacement that breaks meaningful internal
 *                     structure"), loss (no new extreme by close for lossStale bars, or the leg's last break its way
 *                     failed). Never an invalidation.
 */

const SE = require('./structure-events');
const PS = require('./protected-status');
const { strongCandle } = require('./cisd');

const opp = d => (d === 'up' ? 'down' : 'up');
const sgn = d => (d === 'up' ? 1 : -1);
const colour = k => (k.c >= k.o ? 1 : -1);
const need = (p, keys) => { for (const k of keys) if (!Number.isFinite(p[k])) throw new Error(`structure-layers: ${k} is required (config/analysis.json marketState)`); };

/** A bar's own displacement: strongCandle in its own colour on ATR(14) of the bar before. */
function barStrong(bars, z, atr) {
  return z > 0 ? strongCandle(bars[z], bars[z - 1], colour(bars[z]), atr[z - 1]).strong : false;
}

/** The RTH breaks with their displacement (causal at the break's bar). */
function rthBreaks(bars, from, atr, p, all = SE.breaksOf(bars)) {
  need(p, ['followBars']);
  const idx = new Map(bars.map((b, i) => [b.t, i]));
  return all.filter(b => b.i >= from && b.i > 0).map(b => ({
    kind: b.kind, direction: b.direction, level: b.level, at: b.at, i: b.i, swingI: idx.has(b.swingAt) ? idx.get(b.swingAt) : null,
    strong: strongCandle(bars[b.i], bars[b.i - 1], sgn(b.direction), atr[b.i - 1]).strong,
  }));
}

/** A close back through the break's level within followBars after it, by bar z. */
function failedAt(bars, b, z, p) {
  for (let j = b.i + 1; j <= Math.min(z, b.i + p.followBars); j += 1) if (sgn(b.direction) * (bars[j].c - b.level) < 0) return true;
  return false;
}

/** The break's protected level (structure-events.js protectedOf on the bars from its swing to it: the same level, read once). */
function levelOf(bars, b) {
  const pr = SE.protectedOf(b.swingI === null ? bars.slice(0, b.i + 1) : bars.slice(b.swingI, b.i + 1), { direction: b.direction, swingAt: b.swingI === null ? null : bars[b.swingI].t, at: b.at });
  return pr ? pr.level : null;
}

function structureSeries(bars, breaks, from, atr, p) {
  need(p, ['followBars', 'dispBars', 'equalAtr', 'structBars']);
  const n = bars.length;
  const out = new Array(n).fill(null);
  const byBar = new Map();
  for (const b of breaks) { if (!byBar.has(b.i)) byBar.set(b.i, []); byBar.get(b.i).push(b); }
  const levels = new Map(breaks.map(b => [b, levelOf(bars, b)]));
  const flips = [];
  const extremeOf = (side, a, z) => { let e = null; for (let k = a; k <= z; k += 1) e = e === null ? (side === 'up' ? bars[k].h : bars[k].l) : side === 'up' ? Math.max(e, bars[k].h) : Math.min(e, bars[k].l); return e; };
  const leg = (b, i, extra = {}) => ({ side: b.direction, level: levels.get(b), origin: levels.get(b), status: 'intact', lastProgress: i, legStart: i, internal: 0, lastInternal: null, ext: sgn(b.direction) * bars[i].c, legBreaks: [b], levelAt: i, levelBroken: false, ...extra });
  let P = null;
  let lastAgainst = null; // the last RTH break against the intact leg (the CHoCH-then-BOS rule)
  let lastWay = null;
  for (let i = Math.max(from, 1); i < n; i += 1) {
    for (const b of byBar.get(i) || []) {
      const lvl = levels.get(b);
      if (!P) { P = leg(b, i); lastAgainst = null; continue; }
      if (b.direction === P.side) {
        if (P.status === 'broken') P = { ...leg(b, i), origin: P.level, legStart: P.flipAt, flipAt: P.flipAt, flip: P.flip };
        else {
          // A break the leg's way sets the level to its protected swing: a new level, never closed through (levelBroken clears).
          if (lvl !== null && lvl !== P.level) { P.level = lvl; P.levelAt = i; P.levelBroken = false; }
          P.legBreaks.push(b);
        }
        lastAgainst = null;
      } else if (P.status === 'broken') {
        // The new leg never confirmed: the old side resumes with this break as its continuation.
        P = { ...leg(b, i), origin: P.flip ? P.flip.oldOrigin : lvl, resumed: true };
        if (flips.length) flips[flips.length - 1].failed = true;
        lastAgainst = null;
      } else if (lastAgainst && lastAgainst.direction === b.direction && !failedAt(bars, lastAgainst, i, p)) {
        // The owner's CHoCH then BOS the same way against the leg: a transition confirmed at the BOS bar (the level unbroken).
        const flip = { i, oldSide: P.side, oldLevel: P.level, oldOrigin: P.origin, strong: strongCandle(bars[i], bars[i - 1], sgn(b.direction), atr[i - 1]).strong, failed: false, old: P, byRule: 'choch-bos' };
        flips.push(flip);
        P = { ...leg(b, i), origin: extremeOf(P.side, P.legStart, i), legStart: lastAgainst.i, flipAt: i, flip };
        lastAgainst = null;
      } else { P.internal += 1; P.lastInternal = b; lastAgainst = b; }
      if (b.direction === (P && P.side)) lastWay = b;
    }
    if (P) {
      if (P.status === 'intact') { const v = sgn(P.side) * bars[i].c; if (v > P.ext) { P.ext = v; P.lastProgress = i; } }
      const tol = PS.tieAt(atr, i, p.equalAtr);
      if (P.status === 'intact' && PS.through(bars[i].c, P.level, P.side, tol)) {
        // The protected break: a close through the level against the leg by more than the tie tolerance.
        const flip = { i, oldSide: P.side, oldLevel: P.level, oldOrigin: P.origin, strong: strongCandle(bars[i], bars[i - 1], -sgn(P.side), atr[i - 1]).strong, failed: false, old: P, byRule: 'close' };
        flips.push(flip);
        const ext = extremeOf(P.side, P.legStart, i);
        P = { side: opp(P.side), level: ext, origin: ext, status: 'broken', lastProgress: null, legStart: null, internal: 0, lastInternal: null, flipAt: i, flip, ext: -sgn(P.side) * bars[i].c, legBreaks: [], levelAt: i, levelBroken: false };
        lastAgainst = null;
      } else if (P.status === 'broken' && P.flip && PS.through(bars[i].c, P.flip.oldLevel, opp(P.flip.oldSide), tol) && i > P.flipAt) {
        // A close back through the broken level the old way: the protected break failed; within followBars the old leg resumes
        // (the hand-back, D1 of swing-holds: the machine's rule, kept). Its level was closed through: levelBroken, so no line
        // says it holds, and the failed break's extreme (flip bar to this bar) is fixed as the swing the resumed move left.
        P.flip.failed = true;
        if (i - P.flipAt <= p.followBars) {
          const o = P.flip.old;
          P.flip.extreme = extremeOf(opp(o.side), P.flipAt, i);
          P = { ...o, status: 'intact', resumed: true, internal: o.internal + 1, lastInternal: o.lastInternal, ext: Math.max(o.ext, sgn(o.side) * bars[i].c), levelBroken: true };
        }
      }
    }
    if (i >= from && P) out[i] = snapshot(bars, P, flips, lastWay, i, atr, p);
  }
  return out;
}

function snapshot(bars, P, flips, lastWay, z, atr, p) {
  const f = flips[flips.length - 1] || null;
  let disp = false;
  if (f) for (let j = f.i; j <= Math.min(z, f.i + p.dispBars); j += 1) if (strongCandle(bars[j], bars[j - 1], -sgn(f.oldSide), atr[j - 1]).strong) disp = true;
  // The old protected level after a flip: broken once a close went through it past the tie (a close-through flip by
  // definition); a CHoCH-then-BOS flip leaves it unbroken until then (round 20c: a transition confirmed, not a reversal).
  let oldBroken = Boolean(f && f.byRule === 'close');
  if (f && !oldBroken) for (let j = f.i; j <= z && !oldBroken; j += 1) if (PS.through(bars[j].c, f.oldLevel, f.oldSide, PS.tieAt(atr, j, p.equalAtr))) oldBroken = true;
  const way = lastWay && lastWay.direction === P.side ? lastWay : null;
  return {
    side: P.side, level: P.level, origin: P.origin, status: P.status, levelBroken: Boolean(P.levelBroken),
    levelAgo: Number.isInteger(P.levelAt) ? z - P.levelAt : null,
    legOK: P.status === 'intact' && P.legBreaks.some(b => !failedAt(bars, b, z, p)),
    sinceProgress: Number.isInteger(P.lastProgress) ? z - P.lastProgress : null,
    internal: P.internal, resumed: Boolean(P.resumed),
    lastInternal: P.lastInternal ? { direction: P.lastInternal.direction, level: P.lastInternal.level, barsAgo: z - P.lastInternal.i } : null,
    lastWay: way ? { kind: way.kind, direction: way.direction, level: way.level, barsAgo: z - way.i, strong: way.strong, failed: failedAt(bars, way, z, p) } : null,
    flip: f ? { barsAgo: z - f.i, strong: f.strong, disp, held: !f.failed, oldSide: f.oldSide, oldLevel: f.oldLevel, byRule: f.byRule, oldBroken,
      extreme: Number.isFinite(f.extreme) ? f.extreme : null, inside: PS.through(bars[z].c, f.oldLevel, opp(f.oldSide), PS.tieAt(atr, z, p.equalAtr)) } : null,
    flipsIn: flips.filter(x => z - x.i < p.structBars).length,
  };
}

function momentumAt(bars, breaks, snap, z, from, atr, p) {
  need(p, ['pressBars', 'lossStale', 'followBars']);
  const intact = Boolean(snap && snap.status === 'intact');
  if (!intact) return { dispAgainst: null, breakAgainst: null, trigger: false, loss: false };
  let dispAgainst = null;
  for (let j = z; j > Math.max(from, z - p.pressBars); j -= 1) if (barStrong(bars, j, atr) && colour(bars[j]) === -sgn(snap.side)) { dispAgainst = { barsAgo: z - j }; break; }
  const against = breaks.filter(b => b.i <= z && b.direction !== snap.side && z - b.i < p.pressBars);
  const strongBreak = against.slice().reverse().find(b => b.strong) || null;
  const breakAgainst = against.length ? against[against.length - 1] : null;
  const trigger = Boolean(strongBreak || (breakAgainst && dispAgainst));
  const lastWay = breaks.filter(b => b.i <= z && b.direction === snap.side).pop() || null;
  const loss = (snap.sinceProgress !== null && snap.sinceProgress >= p.lossStale) || Boolean(lastWay && failedAt(bars, lastWay, z, p));
  const brk = strongBreak || breakAgainst;
  return { dispAgainst, breakAgainst: brk ? { direction: brk.direction, level: brk.level, barsAgo: z - brk.i, strong: brk.strong } : null, trigger, loss };
}

module.exports = { rthBreaks, failedAt, structureSeries, momentumAt, barStrong };
