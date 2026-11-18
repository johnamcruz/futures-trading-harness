'use strict';

// The MTF structure read in the REAL runner briefing (briefing.js): buildBriefing on the CI goal fixture's real 3m bars
// (tests/fixtures/goal/bars.json.gz, the runner's 514 h window). The field is m3.mtfStructure on the chain's entry frame
// only, its side the Bias line's (the entry rule's); its two lines sit directly under the Market state line, in the
// briefing the head and every analyst read (bar_briefing); the detail leaves it out (SUMMARY_FIELDS); every other line,
// the Market state line and its class word among them, is byte-identical with and without the field (displacement
// parity: the Break quality line too); no displacement file differs from Build 1's head. B1: the runner already holds
// more than the read needs (historyBars), and every existing reader is handed the same bars as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const GF = require('../../scripts/lib/eval/goal-fixture');
const B = require('../../scripts/lib/trading/briefing');
const MTF = require('../../scripts/lib/trading/mtf-structure');
const { biasLine } = require('../../scripts/lib/trading/bias-line');
const { historyBars } = require('../../scripts/lib/autotrader');
const { deskReads } = require('../../scripts/lib/cycle-data');
const BT = require('../../scripts/lib/harness-tools/briefing');
const CFG = require('../../scripts/lib/tunables').analysis().mtfStructure;

const REPO = path.join(__dirname, '..', '..');
const DOC = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'goal', 'bars.json.gz'))));
const etHm = ms => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
const blockBars = new Map();
const barsOf = day => {
  const blk = DOC.blocks.find(x => x.sessions.includes(day));
  if (!blockBars.has(blk)) blockBars.set(blk, GF.decodeBars(blk.bars));
  return blockBars.get(blk);
};
const cache = new Map();
/** The runner's briefing on the bar CLOSING at `hm` ET, on its 514 h window. */
function briefAt(day, hm) {
  const key = `${day} ${hm}`;
  if (cache.has(key)) return cache.get(key);
  const BARS = barsOf(day);
  const j = BARS.findIndex(x => x.t.startsWith(day) && etHm(Date.parse(x.t) + 180000) === hm);
  assert.ok(j > 0, `a bar closing at ${hm} ET on ${day}`);
  const t = Date.parse(BARS[j].t);
  const w = BARS.filter((x, k) => k <= j && Date.parse(x.t) >= t - DOC.historyHours * 3600000);
  const now = new Date(t + 180000);
  const b = B.buildBriefing({ symbol: 'NQ', bars: w, minutes: 3, now });
  const text = B.renderBriefing(b, { now });
  const out = { b, now, w, text, lines: text.split('\n') };
  cache.set(key, out);
  return out;
}
const IS_MTF = l => l.startsWith('- MTF structure ');
const DAYS = [['2022-08-16', ['09:33', '10:15', '11:30']], ['2021-05-27', ['09:45', '11:00']], ['2023-09-21', ['10:03', '11:57']], ['2021-11-19', ['09:36', '10:30']]];

test('briefing (real): the two lines sit directly under the Market state line, the primary first; the record\'s side is the Bias line\'s; the detail leaves the field out', () => {
  for (const [day, hms] of DAYS) {
    for (const hm of hms) {
      const { b, lines, text } = briefAt(day, hm);
      const i = lines.findIndex(IS_MTF);
      assert.ok(i > 0, `${day} ${hm}: the lines`);
      assert.match(lines[i - 1], /^- Market state \(3m\): /, `${day} ${hm}`);
      assert.match(lines[i], /^- MTF structure 1h > 15m \(primary\): stage [A-Z ]+\. .* Above: /);
      assert.match(lines[i + 1], /^- MTF structure below: 15m > 3m \(context\): stage [A-Z ]+\./);
      assert.equal(lines.filter(IS_MTF).length, 2);
      const rec = b.sections.m3.data.mtfStructure;
      const bias = biasLine(b);
      const side = /^Bias: (long|short) only/.exec(bias);
      assert.equal(rec.side, side ? side[1] : null, `${day} ${hm}: ${bias}`);
      assert.deepEqual(rec.levels.map(l => l.name), ['4h>1h', '1h>15m', '15m>3m']);
      assert.ok(!text.includes('"mtfStructure"') && !text.includes('mtfStructure:'), 'not in the detail');
      assert.deepEqual(MTF.mtfLines(rec, { lineBytes: CFG.lineBytes, primaryBytes: CFG.primaryBytes }), lines.slice(i, i + 2));
    }
  }
});

test('briefing (real): every other rendered line is byte-identical with and without the field (the Market state line and its class word, the Break quality line, the Pullback line)', () => {
  let n = 0;
  for (const [day, hms] of DAYS) {
    for (const hm of hms) {
      const { b, now, lines } = briefAt(day, hm);
      const bare = JSON.parse(JSON.stringify(b));
      delete bare.sections.m3.data.mtfStructure;
      const without = B.renderBriefing(bare, { now }).split('\n');
      assert.deepEqual(lines.filter(l => !IS_MTF(l)), without, `${day} ${hm}`);
      assert.ok(without.some(l => l.startsWith('- Market state (3m): ')));
      n += 1;
    }
  }
  assert.equal(n, 9);
});

test('displacement: no file with displacement in its path differs from Build 1\'s head (the read never touches the skill or its code)', () => {
  const PINNED = {
    'scripts/lib/trading/displacement.js': '928c0003c2ae354960ac75c0477c67e64bf45979d3ab9eb076fea40ae0b26928',
    'skills/displacement/SKILL.md': '73ce03f22d33e0a9c139c6b487f9899442e1416c0bed18b7ca564dc5bae88133',
    'tests/fixtures/golden/displacement-parity.txt': '1579f7de9298287e46eceda26e5440ac02b41b9105a9248c6c3ebf3fa5065806',
  };
  for (const [f, sha] of Object.entries(PINNED)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f))).digest('hex'), sha, f);
  for (const f of ['tests/lib/displacement-parity.test.js', 'tests/lib/displacement-real.test.js', 'tests/lib/displacement.test.js', 'tests/plugin/displacement-readers.test.js', 'tests/plugin/displacement-skill.test.js']) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f))).digest('hex'), DISPLACEMENT_TESTS[f], f);
  }
});
const DISPLACEMENT_TESTS = {
  'tests/lib/displacement-parity.test.js': 'c89f8e88a05e1d25623e00dd5d2904a6feb905ba57e2cefdf9c836e010a322da',
  'tests/lib/displacement-real.test.js': '150f21a67e5ece411e16788eaae3056277bfa63e51fa044738d715316bc6b91a',
  'tests/lib/displacement.test.js': '4fc542ca93e70e39b3bbddbc78d848c2e721ee6e08bd675898f4780fba8388b0',
  'tests/plugin/displacement-readers.test.js': '69d2e23f6a90aed05af99d3a6c29399aca37f00299ef04f8e04d2e79ccd7ec2e',
  'tests/plugin/displacement-skill.test.js': 'a1288c53dfec34b2e6bf819e2c7e5319817ae6d0d6fe08acf13d5d0c68eafb93',
};

test('B1: the runner holds more 3m bars than the read needs (4,400, the 4h level\'s depth), so the read gets its depth from the bars every reader already gets; the 4h level is warm on the runner\'s window', () => {
  assert.ok(historyBars(3) >= 4400, `historyBars(3) = ${historyBars(3)}`);
  for (const [day, hms] of DAYS) {
    const { b, w } = briefAt(day, hms[0]);
    assert.ok(w.length >= 4400, `${day}: the runner's 514 h window holds ${w.length} bars`);
    for (const l of b.sections.m3.data.mtfStructure.levels) assert.equal(l.partial, false, `${day} ${l.name}`);
  }
});

test('the head and every analyst read the same lines: the analysts\' first read is bar_briefing, and the tool serves the runner\'s briefing with the two lines', () => {
  for (const role of ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst']) assert.deepEqual(deskReads(role, { symbol: 'MNQ' })[0], { tool: 'bar_briefing', args: { symbol: 'MNQ' } }, role);
  const { b, lines } = briefAt('2022-08-16', '10:15');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-mtf-'));
  B.writeBriefing(home, { ...b, symbol: 'MNQ' });
  const out = BT.barBriefing({ symbol: 'MNQ' }, { env: { FTH_HOME: home }, now: () => new Date(b.closedAt), replayAt: () => null }).text;
  const served = out.split('\n');
  const i = served.findIndex(IS_MTF);
  assert.ok(i > 0);
  assert.match(served[i - 1], /^- Market state \(3m\): /);
  assert.deepEqual(served.slice(i, i + 2), lines.filter(IS_MTF));
});

test('M2: no MTF line and the Pullback line print opposite status words (holds / broken) for the same price', () => {
  const status = (l, re) => [...l.matchAll(re)].map(m => [Number(m[1]), m[2]]);
  let both = 0;
  for (const [day, hms] of DAYS) {
    const BARS = barsOf(day);
    for (let k = 0; k < BARS.length; k += 1) {
      if (!BARS[k].t.startsWith(day)) continue;
      const hm = etHm(Date.parse(BARS[k].t) + 180000);
      if (hm < '09:30' || hm > '12:00' || (!hms.includes(hm) && !(day === '2022-08-16' && k % 3 === 0))) continue;
      const { lines } = briefAt(day, hm);
      const pb = lines.find(l => l.startsWith('- Pullback ('));
      if (!pb) continue;
      both += 1;
      const p = new Map(status(pb, /\b(\d{4,}(?:\.\d+)?) (holds|broken by a close)/g));
      for (const l of lines.filter(IS_MTF)) {
        // A bare `holds` against `broken by a close` is the contradiction; the MTF line's `holds on 1h closes` and its
        // `not broken on a 1h close; WARNING: a 3m close ...` name the frame whose close decides, so a 3m close through
        // the same price (the Pullback line's base close) does not contradict them.
        for (const [price, word] of status(l, /(\d{4,}(?:\.\d+)?)(?: \(the origin of the last \w+ break\))? (holds(?! on \w+ closes))/g)) {
          assert.notEqual(p.get(price), 'broken by a close', `${day} ${hm}: ${price} ${word} on the MTF line, broken by a close on the Pullback line`);
        }
      }
    }
  }
  assert.ok(both > 0, 'some bars carry both lines');
});
