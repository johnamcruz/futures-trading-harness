'use strict';

// SYNTHETIC worlds for the MTF structure tests. Prices are piecewise linear in SETUP-candle units and constant inside a
// setup candle (its first base bar jumps from the last close; the rest are flat), so a setup candle's close is the same at
// any timeframe scale. The breaks and CISDs are INJECTED per frame through `prims` (the module's primitives), placed in
// candle units: parent and setup by candle index, timing as [setup candle, base bar inside it]. A level is (parent, setup,
// timing) = (base x per x 4, base x per, base): per 5 on 3m bars is 60/15/3, per 4 on 15m bars is 240/60/15.

const T0 = Date.parse('2022-01-04T03:00:00Z'); // 22:00 ET: on a 4h, 1h and 15m boundary from the 18:00 ET open
const SETUPS = 48;
const PARENT_PER = 4;

const q = x => Math.round(x * 4) / 4;
function pathAt(keys, s) {
  for (let i = 1; i < keys.length; i += 1) {
    const [s0, p0] = keys[i - 1];
    const [s1, p1] = keys[i];
    if (s <= s1) return q(p0 + ((p1 - p0) * (s - s0)) / (s1 - s0));
  }
  return keys[keys.length - 1][1];
}

/** The world: { bars, base, level, prims, at(s, off), end(s), endP(p) }. events: [{ f, at, kind, dir, swing, cisd, level }]. */
function world({ per = 5, base = 3, keys, events = [], atr = {}, overrides = {}, mirror = false, pivot = 300 }) {
  const n = SETUPS * per;
  const bars = [];
  for (let b = 0; b < n; b += 1) {
    const s = Math.floor(b / per);
    const c = pathAt(keys, s);
    const o = b ? bars[b - 1].c : pathAt(keys, 0);
    const x = { t: new Date(T0 + b * base * 60000).toISOString(), o, h: Math.max(o, c), l: Math.min(o, c), c, v: 100 };
    Object.assign(x, overrides[b] || {});
    if (overrides[b] && overrides[b].c !== undefined) { x.h = Math.max(x.h, x.c, x.o); x.l = Math.min(x.l, x.c, x.o); }
    bars.push(x);
  }
  const out = mirror ? bars.map(b => ({ t: b.t, o: pivot - b.o, h: pivot - b.l, l: pivot - b.h, c: pivot - b.c, v: b.v })) : bars;
  const minutes = { parent: base * per * PARENT_PER, setup: base * per, timing: base };
  const idx = (f, at) => (f === 'timing' && Array.isArray(at) ? at[0] * per + at[1] : at);
  const roleOf = c => {
    if (c.length < 2) return null;
    const m = (Date.parse(c[1].t) - Date.parse(c[0].t)) / 60000;
    return Object.keys(minutes).find(k => minutes[k] === m) || null;
  };
  const prims = {
    breaksOf: c => {
      const r = roleOf(c);
      // Only the breaks on candles these bars hold (a prefix of the world's bars: the non-repainting checks).
      return events.filter(e => e.f === r && !e.cisd && idx(r, e.at) < c.length).map(e => {
        const i = idx(r, e.at);
        const sw = idx(r, e.swing);
        const dir = mirror ? -e.dir : e.dir;
        const level = e.level !== undefined ? (mirror ? pivot - e.level : e.level) : dir > 0 ? c[sw].h : c[sw].l;
        return { kind: e.kind, direction: dir > 0 ? 'up' : 'down', level, swingAt: c[sw].t, at: c[i].t, i };
      }).filter(b => b.i < c.length).sort((a, b) => a.i - b.i);
    },
    findCisds: c => {
      const r = roleOf(c);
      return events.filter(e => e.f === r && e.cisd).map(e => ({ dir: mirror ? -e.dir : e.dir, level: mirror ? pivot - e.level : e.level, runStart: idx(r, e.at) - 1, runEnd: idx(r, e.at) - 1, confirm: idx(r, e.at) }))
        .filter(e => e.confirm < c.length).sort((a, b) => a.confirm - b.confirm);
    },
    atr: c => { const r = roleOf(c); const a = r && Number.isFinite(atr[r]) ? atr[r] : 0; return c.map(() => a); },
  };
  return {
    bars: out, base, prims, per, n,
    level: { name: 'p>s', parent: minutes.parent, setup: minutes.setup, timing: minutes.timing, role: 'primary' },
    below: { name: 's>t', parent: minutes.setup, setup: minutes.timing, timing: null, role: 'below' },
    at: (s, off) => s * per + off,
    end: s => s * per + per - 1,
    endP: p => (p + 1) * per * PARENT_PER - 1,
  };
}

// The 1h-up scenario (spec 2.3, every stage through conservative ready and COMPLETED), in setup-candle units:
// the parent breaks up on parent candle 2 (its protected low 100, the path's low at setup 4); the impulse high 150 at
// setup 16; the pullback to 130 at setup 24; back up to 160 at setup 44.
const KEYS = [[0, 105], [4, 100], [16, 150], [24, 130], [44, 160], [47, 162]];
const EVENTS = [
  { f: 'parent', at: 2, kind: 'BOS', dir: 1, swing: 0, level: 104 },
  { f: 'timing', at: [17, 0], kind: 'CHoCH', dir: -1, swing: [16, 2], level: 149 },   // POTENTIAL
  { f: 'setup', at: 17, kind: 'CHoCH', dir: -1, swing: 15, level: 146 },              // DEVELOPING
  { f: 'setup', at: 20, kind: 'BOS', dir: -1, swing: 18, level: 141 },                // ESTABLISHED (protected high 145)
  { f: 'timing', at: [25, 1], kind: 'CHoCH', dir: 1, swing: [24, 1], level: 131 },    // WEAKENING (origin 130)
  { f: 'timing', at: [27, 1], kind: 'BOS', dir: 1, swing: [26, 0], level: 134 },      // REVERSING (origin 133)
  { f: 'timing', at: [36, 1], kind: 'CHoCH', dir: -1, swing: [35, 3], level: 147.5 }, // conservative: the 3m pullback
  { f: 'timing', at: [36, 3], kind: 'CHoCH', dir: 1, swing: [36, 2], level: 148.25 }, // its first break back up (CHoCH)
  { f: 'timing', at: [37, 1], kind: 'BOS', dir: 1, swing: [36, 2], level: 148.5 },    // the BOS: conservative ready
];

module.exports = { T0, SETUPS, world, pathAt, KEYS, EVENTS };
