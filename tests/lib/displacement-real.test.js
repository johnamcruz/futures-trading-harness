'use strict';

// Displacement on REAL briefings (the design review's M8): buildBriefing on the CI goal fixture's real 3m bars, every 3m
// close 09:30-12:00 ET of two fixture mornings, so the one definition is checked on the produced briefing and the printed
// lines, never on the function called twice: the break's `quality.displaced` equals the Market state layers' `strong`
// for the same break (the same candle rule on the same ATR), the Market state line never prints `(displaced)` beside a
// Break quality `weak` for the same break, the JSON shape on m3 and m15, the line only while a break is recent, and
// within its budget.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const GF = require('../../scripts/lib/eval/goal-fixture');
const B = require('../../scripts/lib/trading/briefing');
const D = require('../../scripts/lib/trading/displacement');

const DOC = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'goal', 'bars.json.gz'))));
const HOURS = DOC.historyHours * 3600000;
const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const et = t => { const p = Object.fromEntries(etFmt.formatToParts(new Date(t)).map(x => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute, hm: `${p.hour}:${p.minute}` }; };

function morning(date) {
  const bars = GF.decodeBars(DOC.blocks.find(x => x.sessions.includes(date)).bars);
  const open = bars.findIndex(b => { const e = et(b.t); return e.date === date && e.min === 570; });
  const out = [];
  let prev = null;
  for (let j = open; j < open + 50; j += 1) {
    const w = bars.filter((x, k) => k <= j && Date.parse(x.t) >= Date.parse(bars[j].t) - HOURS);
    const b = B.buildBriefing({ symbol: 'NQ', bars: w, minutes: 3, prev, now: new Date(Date.parse(bars[j].t) + 180000) });
    prev = b;
    const text = B.renderBriefing(b, { now: new Date(Date.parse(b.closedAt)) });
    const line = l => text.split('\n').find(x => x.startsWith(l)) || null;
    out.push({ hm: et(bars[j].t).hm, w, b, text, m3: b.sections.m3.data, m15: b.sections.m15.data, state: line('- Market state'), bq: line('- Break quality'), detail: text.split('Detail by timeframe:')[1] });
  }
  return out;
}

const RUNS = ['2023-09-25', '2021-06-15'].flatMap(morning);

test('real: the break\'s quality.displaced equals the Market state layers\' strong for the same break, on every RTH bar', () => {
  let same = 0; let displaced = 0; let weak = 0;
  for (const r of RUNS) {
    const L = r.m3.layers && r.m3.layers.lastBreak;
    const last = r.m3.lastBreak.last;
    if (!L || !last || L.barsAgo !== last.barsAgo || L.level !== last.level || L.direction !== last.direction) continue;
    same += 1;
    assert.strictEqual(last.quality.displaced, L.strong, `${r.hm} ${last.kind} ${last.direction} ${last.level}`);
    if (L.strong) displaced += 1; else weak += 1;
  }
  assert.ok(same >= 60 && displaced > 5 && weak > 5, `${same} bars compared (${displaced} displaced, ${weak} weak)`);
});

test('real: the printed lines agree: never `(displaced)` on the Market state line beside `weak` for the same break on the Break quality line', () => {
  let both = 0;
  for (const r of RUNS) {
    if (!r.state || !r.bq) continue;
    for (const m of r.state.matchAll(/(BOS|CHoCH) (up|down) (this bar|\d+ min ago) \(displaced\)/g)) {
      both += 1;
      assert.doesNotMatch(r.bq, new RegExp(`3m ${m[1]} ${m[2]} [\\d.]+ ${m[3]}: weak`), `${r.hm}\n${r.state}\n${r.bq}`);
    }
    for (const m of r.bq.matchAll(/3m (BOS|CHoCH) (up|down) [\d.]+ (this bar|\d+ min ago): displaced/g)) {
      assert.doesNotMatch(r.state, new RegExp(`${m[1]} ${m[2]} ${m[3]}(?! \\(displaced\\))[;,.]`), `${r.hm}: the state prints the same break without (displaced)\n${r.state}\n${r.bq}`);
    }
  }
  assert.ok(both > 0, 'the state line names a displaced break at least once');
});

test('real: the JSON shape on m3 and m15 lastBreak.last (`quality`), the protected status\'s once broken, and the detail leaves them to the line', () => {
  const keys = ['bodyX', 'cleared', 'displaced', 'fvg', 'fvgPending', 'leg', 'origin', 'status', 'why'];
  for (const r of RUNS) {
    for (const s of [r.m3, r.m15]) {
      const last = s.lastBreak.last;
      assert.deepStrictEqual(Object.keys(last.quality).sort(), keys, r.hm);
      assert.strictEqual(s.lastBreak.previous && s.lastBreak.previous.quality, undefined, 'previous carries none');
    }
    const pr = r.m3.lastBreak.last.protected;
    assert.strictEqual(Boolean(pr.quality), Boolean(pr.brokenAt), `${r.hm}: a protected read only once broken`);
    if (pr.quality) assert.deepStrictEqual(Object.keys(pr.quality).sort(), ['barsAgo', 'closedAt', 'displaced', 'why']);
    assert.doesNotMatch(r.detail, /"quality"/, `${r.hm}: the detail leaves the read to the line`);
  }
  assert.ok(RUNS.some(r => r.m3.lastBreak.last.quality.fvg) && RUNS.some(r => r.m3.lastBreak.last.quality.status.closedBack), 'an FVG and a close back occur');
});

test('real: the Break quality line prints only while a break is recent (recentEntry 3m candles, recentSetup 15m candles), within lineBytes, strength words only', () => {
  let printed = 0;
  for (const r of RUNS) {
    const e = r.m3.lastBreak.last; const s = r.m15.lastBreak.last;
    const due = (e && e.barsAgo <= D.PARAMS.recentEntry) || (s && s.barsAgo <= D.PARAMS.recentSetup);
    assert.strictEqual(Boolean(r.bq), Boolean(due), `${r.hm}`);
    if (!r.bq) continue;
    printed += 1;
    assert.ok(Buffer.byteLength(r.bq) <= D.PARAMS.lineBytes, `${r.hm}: ${Buffer.byteLength(r.bq)} bytes`);
    assert.doesNotMatch(r.bq, /confirm/i, 'displacement prints strength, never confirmation');
    assert.match(r.bq, /: (displaced|weak \((?:opposite colour|wicks|closed mid|small)(?:, (?:wicks|closed mid|small))*\)), (holding|closed back (above|below) )/);
  }
  assert.ok(printed > 20 && printed < RUNS.length, `${printed} of ${RUNS.length} bars print the line`);
});

// swing-holds: one predicate for every protected status. On every RTH bar the record's brokenAt, last and previous, is the
// first close after the break past equalAtr x ATR(14) at that candle (computed here from the closes, not by protectedOf),
// and the Break quality line's invalidating close (quality.closedAt) is that same candle: the override qualityOf used to
// apply changes nothing, so it is gone.
test('real: last and previous protected brokenAt follow the tie on every RTH bar; the invalidating close is brokenAt\'s candle', () => {
  const ind = require('../../scripts/lib/trading/indicators');
  const EQ = require('../../scripts/lib/tunables').analysis().marketState.equalAtr;
  const tied = { last: 0, previous: 0 };
  let invalidations = 0;
  for (const r of RUNS) {
    const atr = ind.atr(r.w);
    for (const k of ['last', 'previous']) {
      const x = r.m3.lastBreak[k];
      if (!x || !x.protected) continue;
      const s = x.direction === 'up' ? 1 : -1;
      const from = r.w.findIndex(c => c.t === x.at);
      const j = r.w.findIndex((c, i) => i > from && s * (x.protected.level - c.c) > EQ * (Number.isFinite(atr[i]) ? atr[i] : 0));
      assert.strictEqual(x.protected.brokenAt, j >= 0 ? r.w[j].t : null, `${r.hm} ${k} ${x.kind} ${x.direction} ${x.protected.level}`);
      const raw = r.w.findIndex((c, i) => i > from && s * (x.protected.level - c.c) > 0);
      if (raw >= 0 && raw !== j) tied[k] += 1;
      const q = x.protected.quality;
      if (k === 'last' && q && !q.tie) {
        invalidations += 1;
        assert.strictEqual(Date.parse(q.closedAt) - 180000, Date.parse(x.protected.brokenAt), `${r.hm}: the Break quality line's close is brokenAt's`);
      }
      if (k === 'last' && q && q.tie) assert.strictEqual(x.protected.brokenAt, null, `${r.hm}: a tie holds`);
    }
  }
  assert.ok(invalidations > 5, `${invalidations} invalidations compared`);
  assert.deepStrictEqual(tied, { last: 0, previous: 0 }, 'no tie on these two mornings: the tie cases are pinned on 2022-08-24 10:18 (market-state-real.test.js) and in the unit tests');
});

// swing-holds: every printer agrees with the predicate on every RTH bar of the two mornings: the Market state line's level
// words (holds only when no close past the tie went through the level since it was set; the broken words when the machine
// handed back a closed-through level), the Break quality line's protected status, and the structure-read scorecard's truth
// (all three against protected-status.js on the bars, not against each other).
test('real: parity: the Market state line, the Break quality line and the structure-read truth agree with protected-status on every RTH bar', () => {
  const ind = require('../../scripts/lib/trading/indicators');
  const PS = require('../../scripts/lib/trading/protected-status');
  const SR = require('../../scripts/lib/learning/structure-read');
  const EQ = require('../../scripts/lib/tunables').analysis().marketState.equalAtr;
  const seen = { holds: 0, broken: 0, bq: 0, truth: 0 };
  for (const r of RUNS) {
    const atr = ind.atr(r.w);
    const z = r.w.length - 1;
    const P = r.m3.layers && r.m3.layers.structure;
    if (P && P.status === 'intact' && r.state) {
      const brokenSince = PS.firstCloseThrough(r.w, { level: P.level, legSide: P.side, after: z - P.levelAgo - 1, atr, equalAtr: EQ }) >= 0;
      assert.strictEqual(P.levelBroken, brokenSince, `${r.hm}: levelBroken is the predicate since the level was set`);
      if (r.state.includes(`${P.level} holds`)) { seen.holds += 1; assert.ok(!brokenSince, `${r.hm} ${r.state}`); }
      if (P.levelBroken) { seen.broken += 1; assert.match(r.state, new RegExp(`${P.level} broken by a close`), r.hm); }
    }
    const last = r.m3.lastBreak.last;
    const pr = last && last.protected;
    const bqProt = r.bq && r.bq.match(/^- Break quality[^:]*: 3m [^;]*;[^]*?from protected (?:low|high) ([\d.]+)[^:]*: (holds|broken)/);
    if (pr && bqProt && Number(bqProt[1]) === pr.level) {
      seen.bq += 1;
      const k = PS.firstCloseThrough(r.w, { level: pr.level, legSide: last.direction, after: r.w.findIndex(c => c.t === last.at), atr, equalAtr: EQ });
      assert.strictEqual(bqProt[2] === 'broken', k >= 0, `${r.hm} ${r.bq}`);
    }
    const truth = SR.truthOf(`\n${r.text}`).structure;
    if (truth && pr) { seen.truth += 1; assert.strictEqual(truth.prot_status, pr.brokenAt ? 'broken' : 'holding', r.hm); }
  }
  assert.ok(seen.holds > 20 && seen.broken > 0 && seen.bq > 10 && seen.truth > 20, JSON.stringify(seen));
});
