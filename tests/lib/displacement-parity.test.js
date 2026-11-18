'use strict';

// Displacement: no regression (swing-holds, the owner: "We can't break the displacement skill"). displacement.js now
// reads a protected swing's status through protected-status.js; its outputs must equal main's. Recorded on main
// (8453dcd2a) as a golden BEFORE the comparison, on every 3m close 09:30-12:00 ET of the five fixture mornings (the full
// briefing, both frames) and every close 09:33-10:33 of the real 2022-04-11 open (the 3m record alone: the slice has too
// little history for a briefing). Per bar: each frame's last break and its `quality` (displaced, why, cleared, bodyX,
// leg, origin, fvg, status), `last.protected.brokenAt`, its invalidation read (`protected.quality`: displaced, why,
// barsAgo, closedAt, or the tie), and the printed Break quality line.

const test = require('node:test');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const GF = require('../../scripts/lib/eval/goal-fixture');
const B = require('../../scripts/lib/trading/briefing');
const D = require('../../scripts/lib/trading/displacement');
const SE = require('../../scripts/lib/trading/structure-events');
const ind = require('../../scripts/lib/trading/indicators');
const { assertGolden } = require('../golden');

const EQ = require('../../scripts/lib/tunables').analysis().marketState.equalAtr;
const DOC = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'goal', 'bars.json.gz'))));
const DAYS = Object.keys(require('../fixtures/market-state/fixture-day-labels.json').days);
const HOURS = DOC.historyHours * 3600000;
const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const et = t => { const p = Object.fromEntries(etFmt.formatToParts(new Date(t)).map(x => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute, hm: `${p.hour}:${p.minute}` }; };

// One frame's displacement outputs, every field, in a fixed key order.
const frame = lb => {
  const x = lb && lb.last;
  if (!x) return 'none';
  const pr = x.protected || null;
  return JSON.stringify({ kind: x.kind, direction: x.direction, level: x.level, at: x.at, quality: x.quality || null, brokenAt: pr ? pr.brokenAt : null, invalidation: pr ? (pr.quality || null) : null });
};

function morning(date) {
  const bars = GF.decodeBars(DOC.blocks.find(x => x.sessions.includes(date)).bars);
  const open = bars.findIndex(b => { const e = et(b.t); return e.date === date && e.min === 570; });
  const out = [`== ${date}`];
  let prev = null;
  for (let j = open; j < open + 50; j += 1) {
    const w = bars.filter((x, k) => k <= j && Date.parse(x.t) >= Date.parse(bars[j].t) - HOURS);
    const b = B.buildBriefing({ symbol: 'NQ', bars: w, minutes: 3, prev, now: new Date(Date.parse(bars[j].t) + 180000) });
    prev = b;
    const text = B.renderBriefing(b, { now: new Date(Date.parse(b.closedAt)) });
    const line = text.split('\n').find(l => l.startsWith('- Break quality')) || '-';
    out.push(`${et(bars[j].t).hm} m3 ${frame(b.sections.m3.data.lastBreak)}`, `${et(bars[j].t).hm} m15 ${frame(b.sections.m15.data.lastBreak)}`, `${et(bars[j].t).hm} line ${line}`);
  }
  return out;
}

function open0411() {
  const all = require('../fixtures/market-state/2022-04-11-open.json');
  const open = all.findIndex(b => b.t === '2022-04-11T13:30:00.000Z');
  const out = ['== 2022-04-11 (3m record)'];
  for (let z = open; z < all.length; z += 1) {
    const bars = all.slice(0, z + 1);
    const atr = ind.atr(bars);
    const lb = SE.lastBreaks(bars);
    // The briefing's own construction (briefing.js withProtected, then qualityOf); the extra argument is the band on this
    // branch and ignored on main, where qualityOf bands `last`.
    const w = Object.fromEntries(Object.entries(lb).map(([k, x]) => [k, x ? { ...x, protected: SE.protectedOf(bars, x, { atr, equalAtr: EQ }) } : x]));
    const q = D.qualityOf(bars, w, { minutes: 3, levels: [] });
    const brk = q.last ? { ...q.last, barsAgo: lb.last ? bars.length - 1 - bars.findIndex(b => b.t === lb.last.at) : null } : null;
    const line = brk && brk.quality ? D.breakLine({ entry: { tf: '3m', brk, minutes: 3 } }) : null;
    const hm = et(Date.parse(bars[z].t) + 180000).hm;
    out.push(`${hm} m3 ${frame(q)}`, `${hm} line ${line || '-'}`);
  }
  return out;
}

test('displacement: no regression: quality, the invalidation read, last.protected.brokenAt and the Break quality line equal main\'s on every fixture bar', () => {
  assertGolden('displacement-parity.txt', `${[...DAYS.flatMap(morning), ...open0411()].join('\n')}\n`);
});

// The tie's boundary, exactly (no real fixture close sits on it, so the golden above cannot see `>` against `>=`): ATR 5,
// equalAtr 0.05, a tie of 0.25. A close exactly 0.25 past the protected low holds (a tie); 0.26 past is the invalidation.
// Without the break's candle the scan starts at the record's brokenAt, never earlier (a close before the break is not it).
test('displacement: the invalidation read at the tie\'s exact boundary, and without the break\'s candle', () => {
  const assert = require('node:assert');
  assert.strictEqual(EQ * 5, 0.25, 'the fixture: a tie of exactly 0.25');
  const t = i => new Date(Date.UTC(2026, 0, 6, 15, 3 * i)).toISOString();
  const c = (i, close) => ({ t: t(i), o: 101, h: 101.5, l: Math.min(close, 100.5) - 0.25, c: close, v: 1 });
  const brk = { direction: 'up', at: t(0) };
  const tie = [c(0, 101), c(1, 99.75)];
  assert.deepStrictEqual(D.invalidationQuality(tie, brk, { level: 100, brokenAt: null }, [5, 5], D.PARAMS), { tie: true });
  const past = [c(0, 101), c(1, 99.74)];
  const q = D.invalidationQuality(past, brk, { level: 100, brokenAt: t(1) }, [5, 5], D.PARAMS);
  assert.ok(q && q.tie === undefined && q.barsAgo === 0, JSON.stringify(q));
  // A close past the level BEFORE the break, and no break candle given: the scan starts at brokenAt.
  const early = [c(0, 99), c(1, 101), c(2, 99.75)];
  assert.deepStrictEqual(D.invalidationQuality(early, { direction: 'up' }, { level: 100, brokenAt: t(2) }, [5, 5, 5], D.PARAMS), { tie: true }, 'the scan starts at brokenAt (a tie at 2): the close at 0, 1 past the level, is not counted');
  assert.strictEqual(D.invalidationQuality(early, { direction: 'up' }, { level: 100, brokenAt: null }, [5, 5, 5], D.PARAMS), null, 'no break candle, no record: nothing');
  // A tie-only series, no break candle and no broken record: nothing (not a tie read from the whole series).
  assert.strictEqual(D.invalidationQuality([c(0, 101), c(1, 99.9)], { direction: 'up' }, { level: 100, brokenAt: null }, [5, 5], D.PARAMS), null, 'no anchor: no scan');
});
