'use strict';

// P1: the selection scorecard's run reader (scripts/lib/replay/selection-run.js). Every record is runner-shaped: cycle
// records written by the runner's own writer (cycle-log.js writeCycleLog) under a replay clock, so cycleAt is the bar's
// close plus the runner's seconds; entry orders as the gateway records them (order-tracker.js: side as given, the gate's
// mtf stamp); a resting-stop exit emits no event (the reader reads none). The ruler runs on real bars.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('../../scripts/lib/replay/selection-run');
const { writeCycleLog } = require('../../scripts/lib/cycle-log');
const { tmpDir } = require('../helpers');

const LINE = (o = {}) => `- MTF candidate ${o.side || 'LONG'} (chosen): ${o.model || 'aggressive'} at stage WEAKENING, trigger 3m CHoCH ${o.way || 'up'} ${o.et || '10:12'} (new this bar); drift 0R past the trigger; context: fresh turn (this session): 1h CHoCH up 09:00, BOS up 09:45; 1 BOS since the turn; impulse 2.6 ATR in 8 bars, 2 displacement candles, cleanness 0.81; pullback #1 of this 1h leg; depth 55% (moderate): the stop 11.5 pts away, the impulse extreme 30 pts away; structural stop ${o.stop || 21528.75}: 11.5 pts, $24.24 a contract all in; the $300 cap fits 12; 4h structure UP (context).`;
const BRIEF = (asOf, line) => `Autonomous cycle.\n--- bar_briefing {"symbol":"MNQ"} as of ${asOf} ---\n${line}\n--- end of bar_briefing {"symbol":"MNQ"} (sha256 x) ---`;
const claude = text => JSON.stringify({ type: 'result', subtype: 'success', result: text });

// A replay home: a replay broker (the clock is honoured only with one) and the runner's cycle writer at a replay time.
function home() {
  const h = tmpDir();
  fs.writeFileSync(path.join(h, 'brokers.json'), JSON.stringify({ broker: 'rp', brokers: { rp: { command: ['node', path.join(h, 'replay-server.js')], replay: true } } }));
  return h;
}
// `transcript`: the harness's raw output, as the runner hands it (the record's transcript field).
function cycle(h, replayNow, { prompt, transcript = '', harness = 'claude', result = null }) {
  const env = { HOME: h, FTH_HOME: h, FTH_REPLAY_NOW: replayNow };
  return writeCycleLog(h, { at: new Date('2026-11-18T20:00:00Z'), env, action: 'trade', harness, prompt, output: transcript, result, ok: true }).file;
}

test('selectionOf: a labelled line at a line start (the quiz\'s rule: colon or a dash, markdown bold), the label and word case-sensitive, the LAST wins; quoted, lowercase or a longer word is none', () => {
  const D = t => R.selectionOf(t);
  assert.deepEqual(D('x\nSELECTION: ENTER - long 10:12\nCYCLE RESULT: planned'), { decision: 'ENTER', reason: 'long 10:12' });
  assert.deepEqual(D('**SELECTION:** WAIT — the 3m not closed'), { decision: 'WAIT', reason: 'the 3m not closed' });
  assert.deepEqual(D('SELECTION – PASS – too far'), { decision: 'PASS', reason: 'too far' });
  assert.deepEqual(D('**SELECTION: PASS**'), { decision: 'PASS', reason: '' });
  assert.deepEqual(D('SELECTION: PASS.'), { decision: 'PASS', reason: '' });
  assert.equal(R.decisionOf('SELECTION: PASS - a\nSELECTION: WAIT - b'), 'WAIT');
  assert.equal(R.decisionOf('SELECTION: ENTER - a\nselection: pass - b'), 'ENTER', 'a lowercase line is none: the last labelled one stands');
  assert.equal(R.decisionOf('The skill says to write "SELECTION: ENTER - x".'), 'UNLABELLED');
  assert.equal(R.decisionOf('SELECTION: ENTERED - x'), 'UNLABELLED');
  assert.equal(R.decisionOf('SELECTION: enter - x'), 'UNLABELLED');
  assert.equal(R.decisionOf('SELECTIONS: ENTER'), 'UNLABELLED');
  assert.equal(R.decisionOf(null), 'UNLABELLED');
});

test('barOf: the prompt\'s bar briefing time; else cycleAt floored to the bar grid (the runner\'s seconds past the close)', () => {
  assert.equal(R.barOf({ prompt: BRIEF('2026-10-07T14:15:00.000Z', LINE()), cycleAt: '2026-10-07T14:18:30.000Z' }, 180000), '2026-10-07T14:15:00.000Z');
  assert.equal(R.barOf({ prompt: 'no briefing', cycleAt: '2026-10-07T14:15:02.000Z' }, 180000), '2026-10-07T14:15:00.000Z');
  assert.equal(R.barOf({ prompt: '', cycleAt: '2026-10-07T14:17:59.000Z' }, 180000), '2026-10-07T14:15:00.000Z');
  assert.equal(R.barOf({ prompt: '', cycleAt: 'x' }, 180000), null);
});

test('readRun on runner-written cycles (cycleAt 2 s past the close): each chosen line at its bar, the decision from the head trader\'s final text, never the prompt', () => {
  const h = home();
  cycle(h, '2026-10-07T14:15:02Z', { prompt: `${LINE()}\nSELECTION: ENTER - in the prompt, not the model's`, transcript: claude('The 3m may deepen.\nSELECTION: WAIT - the 3m has not closed past it\nCYCLE RESULT: no-trade') });
  cycle(h, '2026-10-07T14:18:02Z', { prompt: LINE(), transcript: claude('**SELECTION:** PASS — too far\nCYCLE RESULT: no-trade') });
  const r = R.readRun({ home: h, runDir: path.join(h, 'nothing'), minutes: 3, symbol: 'MNQ' });
  assert.deepEqual(r.picks.map(p => [p.at, p.decision]), [['2026-10-07T14:15:00.000Z', 'WAIT'], ['2026-10-07T14:18:00.000Z', 'PASS']]);
  assert.deepEqual([r.rows.length, r.rows[0].state, r.rows[0].outcome], [1, 'passed', null]);
});

test('readRun reads an opencode cycle\'s decision from its transcript\'s final text', () => {
  const h = home();
  const raw = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'opencode-cycle-transcript.jsonl'), 'utf8');
  const t = raw.replace('Entered MNQ long 1 at market with the bracket.', 'SELECTION: ENTER - long aggressive 10:12');
  assert.notEqual(t, raw);
  cycle(h, '2026-10-07T14:15:02Z', { prompt: LINE(), transcript: t, harness: 'opencode' });
  const r = R.readRun({ home: h, runDir: path.join(h, 'nothing'), minutes: 3, symbol: 'MNQ' });
  assert.deepEqual([r.picks[0].decision, r.rows[0].state], ['ENTER', 'enterNoOrder']);
});

test('ordersFrom: the gateway\'s entry orders with the gate\'s mtf stamp (side as given: 0 or buy is long), the bar the gate judged; a non-MTF order is none', () => {
  const o = R.ordersFrom([
    { at: '2026-10-07T14:18:20.000Z', side: '0', composed: { entry: 21540.25, stop: 21528.75, mtf: { bar: '2026-10-07T14:18:00.000Z', model: 'aggressive', instanceId: 'intraday|a|b|aggressive' } } },
    { at: '2026-10-07T14:21:20.000Z', side: 'sell', composed: { entry: 1, stop: 2, mtf: { bar: '2026-10-07T14:21:00Z', model: 'balanced' } } },
    { at: '2026-10-07T14:24:20.000Z', side: 'buy', composed: { entry: 1, stop: 0 } },
  ]);
  assert.deepEqual(o.map(x => [x.side, x.bar, x.model, x.instanceId]), [['long', '2026-10-07T14:18:00.000Z', 'aggressive', 'intraday|a|b|aggressive'], ['short', '2026-10-07T14:21:00.000Z', 'balanced', null]]);
});

test('candidateRows: a take is the candidate an order was placed for, scored at THAT bar (a WAIT then an ENTER scores at the entry bar); an ENTER with no order is its own state; an order for another model, or on a bar it never printed on, is not its take', () => {
  const at = m => `2026-10-07T14:${m}:00.000Z`;
  const p = (m, o) => ({ at: at(m), side: 'long', model: 'aggressive', trigger: '3m CHoCH up 10:12', stop: 100, ...o });
  const ruler = x => ({ R: Number(x.at.slice(14, 16)), points: 1, filled: true }); // the scored bar's minute, to see which bar
  const order = (m, o) => ({ bar: at(m), side: 'long', model: 'aggressive', ...o });
  const rows = R.candidateRows([
    p('15', { decision: 'WAIT' }), p('18', { decision: 'ENTER' }), // took at 18
    p('15', { trigger: 'b', decision: 'ENTER' }), // ENTER, no order
    p('15', { trigger: 'c', model: 'balanced', decision: 'ENTER' }), // the order below names conservative at 15: not this one's
    p('15', { trigger: 'd', decision: 'PASS' }),
    p('21', { trigger: 'e', decision: 'WAIT' }), // open at the last bar
    p('15', { trigger: 'f', decision: 'WAIT' }), // outlived
    p('15', { trigger: 'g', decision: 'UNLABELLED' }),
  ], [order('18'), order('15', { model: 'conservative' }), order('24')], ruler, { lastBar: at('21') });
  const by = Object.fromEntries(rows.map(r => [r.key.split('|')[2], r]));
  const took = by['3m CHoCH up 10:12'];
  assert.deepEqual([took.state, took.at, took.outcome.R, took.firstOutcome.R], ['took', at('18'), 18, 15]);
  assert.deepEqual(['b', 'c', 'd', 'e', 'f', 'g'].map(k => by[k].state), ['enterNoOrder', 'enterNoOrder', 'passed', 'waited', 'passed', 'unlabelled']);
  assert.equal(by.b.order, null);
  assert.equal(by.b.outcome.R, 15, 'an ENTER with no order: scored at its ENTER');
});

test('candidateRows: the same trigger text in another trading session is its own candidate (the 18:00 ET rollover, not the UTC date)', () => {
  const p = (at, o) => ({ at, side: 'long', model: 'balanced', trigger: '3m BOS up 10:12', stop: 100, ...o });
  const rows = R.candidateRows([
    p('2026-10-07T14:15:00.000Z', { decision: 'ENTER' }), p('2026-10-08T14:15:00.000Z', { decision: 'PASS' }),
    p('2026-10-08T21:30:00.000Z', { trigger: 'late', decision: 'ENTER' }), p('2026-10-08T22:30:00.000Z', { trigger: 'late', decision: 'PASS' }),
  ], [], () => null);
  assert.deepEqual(rows.map(r => [r.key.split('|')[2], r.day, r.state]), [
    ['3m BOS up 10:12', '2026-10-07', 'enterNoOrder'], ['3m BOS up 10:12', '2026-10-08', 'passed'], ['late', '2026-10-08', 'enterNoOrder'], ['late', '2026-10-09', 'passed']]);
});

// Real bars (tests/fixtures/selection): 2022-07-06, the print at the 15:06 bar's close (15144.5), structural stop 15078.
const DAY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'selection', '2022-07-06-3m.json'), 'utf8')).bars;
const SHIPPED = (() => { const P = require('../../scripts/lib/eval/goal-trades').shippedOf(path.join(__dirname, '..', '..'), {}); return { validBars: P.validBars, minRR: P.minRR, plan: P.exit.plan }; })();

test('rulerOf on real bars: a gap fill (15143.5, a tick better than the 15144.5 limit) keeps the printed structural stop 15078 and stops out (-1R on the fill-to-stop basis); brackets in ticks from the fill would have held at 15077 and ridden to +0.98R', () => {
  const ruler = R.rulerOf(DAY, 3, 'MNQ', SHIPPED);
  const o = ruler({ at: '2022-07-06T15:09:00.000Z', side: 'long', stop: 15078 });
  assert.equal(o.fill, 15143.5);
  assert.equal(o.filled, true);
  assert.ok(o.R <= -0.99 && o.R >= -1.01, JSON.stringify(o));
  assert.equal(o.points, Math.round(o.R * (15143.5 - 15078) * 100) / 100);
  // The same trade with the brackets in ticks from the fill (experience-log.js limitOutcome as it is, no re-anchor).
  const { limitOutcome } = require('../../scripts/lib/learning/experience-log');
  const list = DAY.map(b => ({ ...b, ms: Date.parse(b.t) }));
  const at = Date.parse('2022-07-06T15:09:00.000Z');
  const shifted = limitOutcome({ bars: list, tfMs: 180000, side: 'long', entry: 15144.5, stop: 15078, target: 15144.5 + SHIPPED.minRR * 66.5, fromMs: at, expiresMs: at + SHIPPED.validBars * 180000, eodMs: Date.parse('2022-07-06T19:50:00Z'), tick: 0.25, plan: SHIPPED.plan });
  assert.ok(shifted.R > 0.9, JSON.stringify(shifted));
});

test('rulerOf: the limit stands for valid_bars bars (a fill in the second bar counts); a limit that never fills is no trade (0R); no bar at the time, or the stop on the wrong side: none; the shipped values are required', () => {
  const T = m => `2026-10-07T14:${String(m).padStart(2, '0')}:00.000Z`;
  const bar = (m, o, h, l, c) => ({ t: T(m), o, h, l, c, v: 100 });
  // The print at the 14:00 bar's close (14:03): 100. 14:03 stays above the limit; 14:06 trades to it; then up.
  const bars = [bar(0, 99, 101, 98, 100), bar(3, 101, 103, 100.5, 102), bar(6, 102, 102, 99.75, 101), bar(9, 101, 110, 101, 109), bar(12, 109, 130, 108, 128)];
  assert.ok(SHIPPED.validBars >= 2, 'the shipped record stands two bars or more');
  const ruler = R.rulerOf(bars, 3, 'MNQ', SHIPPED);
  const o = ruler({ at: T(3), side: 'long', stop: 95 });
  assert.equal(o.filled, true, JSON.stringify(o));
  const one = R.rulerOf(bars, 3, 'MNQ', { ...SHIPPED, validBars: 1 })({ at: T(3), side: 'long', stop: 95 });
  assert.deepEqual(one, { R: 0, points: 0, filled: false }, 'one bar: unfilled, no trade');
  assert.equal(ruler({ at: T(4), side: 'long', stop: 95 }), null, 'no bar closes then');
  assert.equal(ruler({ at: T(3), side: 'long', stop: 101 }), null, 'the stop above a long\'s limit');
  assert.equal(R.rulerOf([], 3, 'MNQ', {})({ at: T(3) }), null);
  assert.throws(() => R.rulerOf(bars, 3, 'MNQ', {}), /validBars and minRR are required/);
});

test('readRun with served bars and runner-written cycles: the candidate is scored on the bar the cycle decided on (cycleAt 2 s past the close)', () => {
  const h = home();
  const runDir = path.join(h, 'replay', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  require('../../scripts/lib/session/bars-archive').appendBars(runDir, '2022-07-06', { symbol: 'MNQ', minutes: 3, bars: DAY });
  cycle(h, '2022-07-06T15:09:02Z', { prompt: LINE({ et: '11:06', stop: 15078 }), transcript: claude('SELECTION: PASS - the stop is far') });
  const r = R.readRun({ home: h, runDir, minutes: 3, symbol: 'MNQ' });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].at, '2022-07-06T15:09:00.000Z');
  assert.ok(r.rows[0].outcome && r.rows[0].outcome.filled === true && r.rows[0].outcome.R < -0.99, JSON.stringify(r.rows[0]));
});

test('the CLI (scripts/selection-score.js): its arguments; each run\'s pick table and rows', () => {
  const CLI = require('../../scripts/selection-score');
  assert.throws(() => CLI.parse([]), /usage: selection-score.js/);
  assert.throws(() => CLI.parse(['x', '--nope']), /unknown argument --nope/);
  assert.throws(() => CLI.parse(['x', '--min-leg-r', '2']), /unknown argument --min-leg-r/, 'the legs table is gone');
  assert.equal(CLI.parse(['a', '--minutes', '1']).minutes, 1);
  const h = home();
  cycle(h, '2026-10-07T14:15:02Z', { prompt: LINE(), transcript: claude('no label') });
  const r = CLI.main([h]);
  assert.deepEqual([r.runs[0].selection.candidates, r.runs[0].selection.unlabelled, r.runs[0].rows[0].state], [1, 1, 'unlabelled']);
});
