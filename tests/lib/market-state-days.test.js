'use strict';

// The Market state on five real mornings of the goal fixture (round 20, DECISIONS 12 / the design review's section 5):
// every 3m close 09:30-12:00 ET on the runner's window, the printed line pinned as a golden (each state word from the
// bars: transition, weakening, rotation of a pullback and of a stale leg, reversal confirmed, the opening-drive failure,
// chop, pullback), and the frozen addendum-28 hindsight labels (tests/fixtures/market-state/fixture-day-labels.json,
// written by the label rule outside the repo, never a state input) scoring FALSE-CHOP (chop on TREND or PULLBACK bars)
// and MISSED-CHOP (the trend class on ROTATION bars) on the aligned bars: an explained golden of the decisive test.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const GF = require('../../scripts/lib/eval/goal-fixture');
const B = require('../../scripts/lib/trading/briefing');
const M = require('../../scripts/lib/trading/market-state');
const { assertGolden } = require('../golden');
const { analysis } = require('../../scripts/lib/tunables');

const AN = analysis();
const TH = { crossesChop: AN.regime.rangeCrosses, maxPullbackDepth: AN.pullbackRead.maxStateDepth, lineBytes: AN.marketState.lineBytes }; // the briefing's
const DOC = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'goal', 'bars.json.gz'))));
const LABELS = require('../fixtures/market-state/fixture-day-labels.json');
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
    const s = M.stateOf(b, TH);
    out.push({ hm: et(bars[j].t).hm, s, cls: M.classWordOf(s), line: M.marketStateLine(s) });
  }
  return out;
}

const DAYS = Object.keys(LABELS.days);
const RUNS = Object.fromEntries(DAYS.map(d => [d, morning(d)]));

test('fixture days (real): the printed Market state per bar, 09:30-12:00 ET, pinned (a changed line is an explained golden change)', () => {
  const text = DAYS.map(d => [`== ${d}`, ...RUNS[d].map(r => `${r.hm} ${r.line}`)].join('\n')).join('\n');
  assertGolden('market-state-days.txt', `${text}\n`);
});

// State parity (swing-holds Build 1): the machine's every transition and the state and class on every fixture bar, recorded
// before the print's rework (a changed row is a changed transition: Build 1 changes none).
const parityRow = r => {
  const P = r.s && r.s.layers && r.s.layers.structure;
  const m = P ? [P.side, P.status, P.level, P.legOK, P.resumed, P.flip ? P.flip.held : '-', P.flipsIn].join(' ') : '-';
  return `${r.hm} ${m} | ${r.s ? r.s.state : '-'} ${r.cls}`;
};
test('fixture days (real): state parity: side, status, level, legOK, resumed, flip.held, flipsIn, the state and the class per bar, pinned', () => {
  assertGolden('market-state-parity.txt', `${DAYS.map(d => [`== ${d}`, ...RUNS[d].map(parityRow)].join('\n')).join('\n')}\n`);
});

test('fixture days (real): every state word the precedence makes is reached from the bars; the guard never prints chop; the line stays short', () => {
  const all = DAYS.flatMap(d => RUNS[d]);
  for (const re of [/: transition (up|down): /, /: weakening (up|down): /, /: rotation: pullback \(/, /: rotation (up|down): /, /reversal confirmed/, /potential failed opening drive/, /: chop: the (up|down) leg's last break failed, (HL|LH) [\d.]+ (holds|broken by a close, closed back (above|below))/, /: pullback \((long|short) leg/, /: in the (up|down) leg: /, /: trend (up|down): /, /: range: no leg holds/, /: range: the (up|down) leg's last break failed, (HL|LH) [\d.]+ (holds|broken by a close, closed back (above|below))/, /: forming /, /, CHoCH then BOS/]) {
    assert.ok(all.some(r => re.test(r.line)), `${re} reached`);
  }
  for (const r of all) if (r.s.pullback) assert.notStrictEqual(r.s.state, 'chop', r.line);
  // swing-holds: no line says a level holds that a close went through (the machine's hand-back, levelBroken) or that is broken.
  for (const r of all) {
    const P = r.s.layers && r.s.layers.structure;
    if (P && (P.levelBroken || P.status === 'broken')) assert.doesNotMatch(r.line, new RegExp(`\\b${P.level} holds|\\b${P.flip ? P.flip.oldLevel : P.level} holds`), r.line);
  }
  assert.ok(all.some(r => r.s.layers && r.s.layers.structure && r.s.layers.structure.levelBroken), 'the mornings reach a handed-back leg');
  // Round 20c: "no leg holds" only when no protected level holds; one 15m word per line under the early read.
  for (const r of all) if (/no leg holds/.test(r.line)) assert.ok(!r.s.layers || !r.s.layers.structure || r.s.layers.structure.status !== 'intact', r.line);
  for (const r of all) if (r.s.early) assert.doesNotMatch(r.line, /\b15m (trending|overlapping|rotating|mixed|early)\b/, r.line);
  const max = Math.max(...all.map(r => Buffer.byteLength(r.line)));
  assert.ok(max <= TH.lineBytes, `the longest line ${max} bytes`);
});

// The decisive test on these mornings (aligned bars only; the label's side is the 4h + 1h side at the bar). Before round
// 20 (a3adcfab5) the same bars scored FALSE-CHOP 4 of 66 trend/pullback bars and MISSED-CHOP 58 of 100 rotation bars
// (measured with the same labels); round 20: 1 and 29 (below).
test('fixture days (real): FALSE-CHOP and MISSED-CHOP against the frozen hindsight labels (addendum 28), pinned', () => {
  let falseChop = 0; let missed = 0; let rotation = 0; let trendPb = 0;
  for (const d of DAYS) {
    RUNS[d].forEach((r, i) => {
      if (!r.s.align) return;
      const lab = LABELS.days[d][r.s.align][i];
      const kind = r.cls === 'chop' ? 'chop' : r.cls === 'unclear' ? 'unclear' : 'trend';
      if (lab === 'T' || lab === 'P') { trendPb += 1; if (kind === 'chop') falseChop += 1; }
      if (lab === 'R') { rotation += 1; if (kind === 'trend') missed += 1; }
    });
  }
  assert.deepStrictEqual({ falseChop, missed, rotation, trendPb }, PINNED);
});

const PINNED = { falseChop: 1, missed: 29, rotation: 100, trendPb: 66 };
