'use strict';

/**
 * A data lane end to end (lanes.js trigger "data"): the live runner as the harness wires it (runner-wiring.js), one
 * pass per decision time as a replay runs it, on the parity bars served by the replay mock exchange at 3m and, for the
 * data lane, at 1m (tests/fixtures/decision-path.js). The 3m cycle's bar briefing gains what only 1m bars can build
 * (5m structure, 5m FVGs, 5m candles), causally (no 1m bar after the decision time); the cycle itself, its prompt
 * and its budget are the one-lane runner's; a pass where only the data lane's bar closed runs nothing.
 */

const test = require('node:test');
const assert = require('node:assert');
const D = require('../fixtures/decision-path');
const { readBriefing } = require('../../scripts/lib/trading/briefing');
const { structure5m } = require('../../scripts/lib/trading/m5-structure');

const { FIRED_BAR, decisionAt } = D;

const m3 = w => readBriefing(w.home, 'MNQ').sections.m3.data;

test('data lane: the 3m cycle\'s briefing gains the 5m structure, 5m FVGs and 5m candle; the cycle is the one-lane runner\'s', async () => {
  const plain = D.world();
  const laned = D.world({ dataLane: true });
  const at = decisionAt(FIRED_BAR);
  const a = await D.pass(plain, at, D.passCycle(plain, 'reading the briefing'));
  const b = await D.pass(laned, at, D.passCycle(laned, 'reading the briefing'));
  // Without 1m bars the 5m facts are unavailable, saying why; with the data lane they are built from its 1m bars.
  assert.match(m3(plain).structure5m.unavailable, /no 1m bars configured/);
  assert.match(String(m3(plain).fvgs['5m']), /^unavailable/);
  const s = m3(laned).structure5m;
  assert.strictEqual(s.source, '1m bars', JSON.stringify(s));
  assert.ok(Array.isArray(m3(laned).fvgs['5m']), JSON.stringify(m3(laned).fvgs['5m']));
  assert.ok(!m3(laned).candles['5m'].unavailable, JSON.stringify(m3(laned).candles['5m']));
  // Causal: nothing known after the decision bar's close.
  const close = Date.parse(FIRED_BAR) + D.STEP;
  for (const x of [s.lastBreak && s.lastBreak.last, s.lastBreak && s.lastBreak.previous].filter(Boolean)) assert.ok(Date.parse(x.knownAt) <= close, x.knownAt);
  assert.strictEqual(m3(laned).candles['5m'].closedAt, '2026-04-28T04:10:00.000Z', 'the last completed 5m candle (04:10-04:15 is forming)');
  // The same facts as the 1m bars cut at the decision bar's close give (no later 1m bar was served or read).
  const cut = D.MINUTE_BARS.filter(x => Date.parse(x.t) + 60000 <= close);
  const bars3 = D.BARS.filter(x => Date.parse(x.t) + D.STEP <= close);
  assert.deepStrictEqual(s, structure5m({ bars: bars3.slice(-laned.cfg.bars), base: 3, fine: cut.slice(-laned.cfg.bars) }));
  // Every other fact is the one-lane briefing's.
  // The 5m compression too: built from the 1m bars with the lane, unavailable without it; the other frames' the same.
  assert.match(String(m3(plain).compression['5m']), /^unavailable/);
  assert.ok(m3(laned).compression['5m'] && m3(laned).compression['5m'].state, JSON.stringify(m3(laned).compression['5m']));
  const { '5m': _p5, ...plainComp } = m3(plain).compression;
  const { '5m': _l5, ...lanedComp } = m3(laned).compression;
  assert.deepStrictEqual(lanedComp, plainComp);
  const rest = d => { const { structure5m: _s, fvgs: _f, candles: _c, compression: _k, ...o } = d; return o; };
  assert.deepStrictEqual(rest(m3(laned)), rest(m3(plain)));
  // One cycle each, with the one-lane prompt, context and budget: the data lane adds no lane to the cycle.
  assert.strictEqual(a.ran.length, 1);
  assert.strictEqual(b.ran.length, 1);
  // The situational skills follow the briefing (situational-skills.js), which the data lane's 5m parts change by design:
  // the prompts are compared without that section.
  const prompt = (w, r) => r.ran[0].prompt.split(w.home).join('<home>').replace(/ This cycle's situation[^]*?(?= End with the cycle result)/, '');
  assert.strictEqual(prompt(laned, b), prompt(plain, a));
  assert.doesNotMatch(b.ran[0].prompt, /Lanes closed/);
  assert.ok(!('lanes' in b.ran[0].context));
  const budget = r => r.events.find(e => e.kind === 'cycle_start').timeoutMs;
  assert.strictEqual(budget(b), budget(a));
  assert.strictEqual(budget(b), laned.cfg.cycleTimeoutMinutes * 60000);
  // The data lane's clock is kept (a replay pass is a new process), so the next 3m pass is not taken for a new 1m bar.
  assert.ok(b.state.laneClocks['MNQ|1m'] && b.state.laneClocks['MNQ|3m']);
});

test('data lane: a pass where only its 1m bar closed runs no cycle, no scan, no session-record point; the next 3m pass cycles as usual', async () => {
  const w = D.world({ dataLane: true });
  await D.pass(w, decisionAt(FIRED_BAR), D.passCycle(w, 'reading the briefing'));
  const briefed = readBriefing(w.home, 'MNQ').asOf;
  // 04:13:02: the 1m bar 04:12 closed, the 3m bar 04:12 not yet.
  const mid = await D.pass(w, new Date(Date.parse(decisionAt(FIRED_BAR)) + 60000).toISOString(), [{ result: 'CYCLE RESULT: no-trade - never run' }]);
  assert.deepStrictEqual(mid.ran, []);
  assert.ok(!mid.events.some(e => e.kind === 'cycle_start'));
  assert.strictEqual(readBriefing(w.home, 'MNQ').asOf, briefed, 'no briefing on a data lane\'s bar');
  assert.ok(!mid.logs.some(l => /cycle|no cycle/.test(l) && /1m/.test(l)), mid.logs.join('\n'));
  const next = await D.pass(w, decisionAt(D.NEXT_BAR), D.passCycle(w, 'managing'));
  assert.strictEqual(next.ran.length, 1);
  assert.strictEqual(m3(w).structure5m.source, '1m bars');
});
