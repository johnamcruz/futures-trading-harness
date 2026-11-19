'use strict';

// P1: the selection scorecard's run reader (scripts/lib/replay/selection-run.js): the chosen candidate lines
// from the cycles' prompts (one per bar and side), the MTF entries from the entry orders' gate stamps with the runner's
// closes, the took/passed marks, the reference 1R, and a synthetic run home read whole.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('../../scripts/lib/replay/selection-run');
const { tmpDir } = require('../helpers');

const LINE = '- MTF candidate LONG (chosen): aggressive at stage WEAKENING, trigger 3m CHoCH up 10:12 (new this bar); context: fresh turn (this session): 1h CHoCH up 09:00, BOS up 09:45; 1 BOS since the turn; impulse 2.6 ATR in 8 bars, 2 displacement candles, cleanness 0.81; pullback #1 of this 1h leg; depth 55% (moderate); structural stop 21528.75: 11.5 pts, $24.24 a contract all in; the $300 cap fits 12; 4h structure UP (context).';

test('picksFrom: the chosen line\'s side, model, rank and stop points; once per bar and side; a line with no rank: null', () => {
  const cycles = [{ bar: '2026-10-07T14:15:00.000Z', prompt: `x\n${LINE}\ny\n${LINE}` }, { bar: '2026-10-07T14:18:00.000Z', prompt: LINE.replace('pullback #1 of this 1h leg', 'its rank in the 1h leg not known').replace('LONG', 'SHORT') }, { bar: 'z', prompt: '- MTF candidate LONG: balanced at stage REVERSING, trigger' }];
  assert.deepEqual(R.picksFrom(cycles), [
    { at: '2026-10-07T14:15:00.000Z', side: 'long', model: 'aggressive', trigger: '3m CHoCH up 10:12', rank: 1, stop: 21528.75, stopPts: 11.5, decision: 'unlabelled' },
    { at: '2026-10-07T14:18:00.000Z', side: 'short', model: 'aggressive', trigger: '3m CHoCH up 10:12', rank: null, stop: 21528.75, stopPts: 11.5, decision: 'unlabelled' },
  ]);
});

test('entriesFrom and tookAt: MTF entries only, each with the runner\'s close after it (price, R, who), or open; a pick is taken by an entry its way in its bar', () => {
  const orders = [
    { at: '2026-10-07T14:15:20.000Z', side: 'buy', composed: { record: 'r1', entry: 21540.25, stop: 21528.75, mtf: { rank: 1 } } },
    { at: '2026-10-07T15:00:00.000Z', side: 'buy', composed: { record: 'r2', entry: 1, stop: 0 } },
    { at: '2026-10-07T15:30:00.000Z', side: 'sell', composed: { record: 'r3', entry: 21600, stop: 21610, mtf: { rank: 2 } } },
  ];
  const events = [{ kind: 'position_closed', at: '2026-10-07T14:50:00.000Z', side: 'long', why: 'trail: price went through the new stop 21560', lastClose: 21559, rNow: 1.63 }];
  const e = R.entriesFrom(orders, events);
  assert.deepEqual(e.map(x => [x.record, x.rank, x.exitBy, x.r, x.exit]), [['r1', 1, 'trail', 1.63, 21559], ['r3', 2, 'open', null, null]]);
  const picks = R.tookAt([{ at: '2026-10-07T14:15:00.000Z', side: 'long', rank: 1 }, { at: '2026-10-07T14:30:00.000Z', side: 'long', rank: 1 }], e, 180000);
  assert.deepEqual(picks.map(p => p.took), [true, false]);
  assert.equal(R.refRiskOf(e, []), 10, 'the median structural stop distance (11.5 and 10)');
  assert.equal(R.refRiskOf([], [{ stopPts: 12 }, { stopPts: 8 }, { stopPts: 20 }]), 12);
  assert.equal(R.refRiskOf([], []), null);
});

test('readRun: a run home\'s cycles, orders and events (no served bars: no legs)', () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'logs', 'cycles', '2026-10-07'), { recursive: true });
  fs.writeFileSync(path.join(home, 'logs', 'cycles', '2026-10-07', '141502-trade.json'), JSON.stringify({ cycleAt: '2026-10-07T14:15:00.000Z', prompt: LINE }));
  fs.writeFileSync(path.join(home, 'entry-orders.json'), JSON.stringify([{ at: '2026-10-07T14:15:20.000Z', side: 'buy', composed: { record: 'r1', entry: 21540.25, stop: 21528.75, mtf: { rank: 1 } } }]));
  fs.writeFileSync(path.join(home, 'logs', 'events-2026-10-07.jsonl'), `${JSON.stringify({ kind: 'position_closed', at: '2026-10-07T14:50:00.000Z', side: 'long', why: 'previous high 21600 rejected', lastClose: 21598, rNow: 5 })}\n`);
  const r = R.readRun({ home, runDir: path.join(home, 'nothing'), session: '09:30-12:00@America/New_York', minutes: 3 });
  assert.deepEqual([r.picks.length, r.picks[0].took, r.entries[0].exitBy, r.refRiskPts, r.legs.length], [1, true, 'runner', 11.5, 0]);
});

test('the CLI (scripts/selection-score.js): its arguments; a run without a reference 1R says so; two runs are paired', () => {
  const CLI = require('../../scripts/selection-score');
  assert.throws(() => CLI.parse([]), /usage: selection-score.js/);
  assert.throws(() => CLI.parse(['x', '--nope']), /unknown argument --nope/);
  assert.equal(CLI.parse(['a', '--min-leg-r', '3']).minLegR, 3);
  const empty = tmpDir();
  const r = CLI.main([empty]);
  assert.match(r.runs[0].error, /no reference 1R/);
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'logs', 'cycles', '2026-10-07'), { recursive: true });
  fs.writeFileSync(path.join(home, 'logs', 'cycles', '2026-10-07', '141502-trade.json'), JSON.stringify({ cycleAt: '2026-10-07T14:15:00.000Z', prompt: LINE }));
  const two = CLI.main([home, home]);
  assert.equal(two.pairs.length, 1);
  assert.equal(two.runs[0].headline.passRate, 1);
  // The selection table comes first in every run (primary): one candidate, its decision not stated (unknown).
  assert.deepEqual([Object.keys(two.runs[0])[1], two.runs[0].selection.candidates, two.runs[0].selection.unlabelled], ['selection', 1, 1]);
});

test('the CLI scores every run on ONE reference 1R (--ref-risk-pts, else the median of the runs\' own), so paired runs count the same legs', () => {
  const CLI = require('../../scripts/selection-score');
  assert.equal(CLI.parse(['a', '--ref-risk-pts', '12']).refRiskPts, 12);
  const mk = stop => {
    const home = tmpDir();
    fs.mkdirSync(path.join(home, 'logs', 'cycles', '2026-10-07'), { recursive: true });
    fs.writeFileSync(path.join(home, 'logs', 'cycles', '2026-10-07', '141502-trade.json'), JSON.stringify({ cycleAt: '2026-10-07T14:15:00.000Z', prompt: LINE.replace('11.5 pts', `${stop} pts`) }));
    return home;
  };
  const r = CLI.main([mk(100), mk(10), mk(30)]);
  assert.deepEqual(r.runs.map(x => x.refRiskPts), [30, 30, 30], 'the median of the runs\' own references');
  assert.equal(r.refRiskPts, 30);
  assert.deepEqual(CLI.main([mk(100), mk(10), '--ref-risk-pts', '12']).runs.map(x => x.refRiskPts), [12, 12]);
});

test('candidateRows: one row per candidate (side, model, trigger, day); took on an entry or ENTER; a PASS passes; a WAIT open at the run\'s last bar is waited, a WAIT the candidate outlived to void is passed; no decision: unknown; the outcome is the first print\'s', () => {
  const p = (at, o) => ({ at, side: 'long', model: 'balanced', trigger: '3m BOS up 10:12', stop: 100, ...o });
  const ruler = x => ({ R: x.at === '2026-10-07T14:15:00.000Z' ? 2 : -1, points: 1 });
  const rows = R.candidateRows([
    p('2026-10-07T14:15:00.000Z', { decision: 'WAIT' }), p('2026-10-07T14:18:00.000Z', { decision: 'ENTER' }),
    p('2026-10-07T14:15:00.000Z', { trigger: 'b', decision: 'WAIT' }),
    p('2026-10-07T14:15:00.000Z', { trigger: 'c', decision: 'PASS' }),
    p('2026-10-07T14:21:00.000Z', { trigger: 'd', decision: 'WAIT' }),
    p('2026-10-07T14:15:00.000Z', { trigger: 'e', decision: 'unlabelled' }),
  ], ruler, { lastBar: '2026-10-07T14:21:00.000Z' });
  assert.deepEqual(rows.map(r => [r.key.split('|')[2], r.state, r.outcome.R]), [['3m BOS up 10:12', 'took', 2], ['b', 'passed', 2], ['c', 'passed', 2], ['d', 'waited', -1], ['e', 'unlabelled', 2]]);
  // The model's decision is read from the cycle's stated result.
  const cyc = [{ bar: '2026-10-07T14:15:00.000Z', prompt: LINE, output: 'I would pass on chasing.\nSELECTION: WAIT - the 3m has not closed past it\nCYCLE RESULT: no-trade' }];
  assert.equal(R.picksFrom(cyc)[0].decision, 'WAIT');
});

test('candidateRows: the same trigger text on another trading session is its own candidate (the session by the 18:00 ET rollover, not the UTC date)', () => {
  const p = (at, o) => ({ at, side: 'long', model: 'balanced', trigger: '3m BOS up 10:12', stop: 100, ...o });
  const ruler = () => ({ R: 1, points: 1 });
  const rows = R.candidateRows([
    p('2026-10-07T14:15:00.000Z', { decision: 'ENTER' }), p('2026-10-08T14:15:00.000Z', { decision: 'PASS' }),
    // 21:30 and 22:30 UTC on 2026-10-08 straddle 18:00 ET (EDT): two sessions on one UTC date.
    p('2026-10-08T21:30:00.000Z', { trigger: 'late', decision: 'ENTER' }), p('2026-10-08T22:30:00.000Z', { trigger: 'late', decision: 'PASS' }),
  ], ruler);
  assert.deepEqual(rows.map(r => [r.key.split('|')[2], r.day, r.state]), [
    ['3m BOS up 10:12', '2026-10-07', 'took'], ['3m BOS up 10:12', '2026-10-08', 'passed'], ['late', '2026-10-08', 'took'], ['late', '2026-10-09', 'passed']]);
});

test('decisionOf (the coordinator\'s ruling): only a labelled line at a line\'s start counts, case-sensitive, the LAST wins; prose with the words, lowercase, or none is unlabelled (never a pass)', () => {
  assert.equal(R.decisionOf('SELECTION: ENTER - the turn is fresh'), 'ENTER');
  assert.equal(R.decisionOf('Reasoning: I could WAIT or PASS here.\nI will not ENTER.'), 'unlabelled', 'the words in prose');
  assert.equal(R.decisionOf('SELECTION: WAIT - next bar\nmore thought\nSELECTION: PASS - too stretched'), 'PASS', 'the last line wins');
  assert.equal(R.decisionOf('selection: enter - lower case'), 'unlabelled');
  assert.equal(R.decisionOf('note SELECTION: ENTER - not at the start'), 'unlabelled');
  assert.equal(R.decisionOf('SELECTION: ENTERED'), 'unlabelled', 'the word must be one of the three');
  assert.equal(R.decisionOf(''), 'unlabelled');
  assert.equal(R.decisionOf(null), 'unlabelled');
});

test('readRun reads the model\'s decision from the head trader\'s final text in the cycle record (a Claude Code transcript\'s result), never from the prompt', () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'logs', 'cycles', '2026-10-07'), { recursive: true });
  const transcript = JSON.stringify({ type: 'result', subtype: 'success', result: 'The pullback may still deepen.\nSELECTION: WAIT - the 3m has not closed past it\nCYCLE RESULT: no-trade' });
  fs.writeFileSync(path.join(home, 'logs', 'cycles', '2026-10-07', '141502-trade.json'), JSON.stringify({ cycleAt: '2026-10-07T14:15:00.000Z', harness: 'claude', prompt: `${LINE}\nSELECTION: ENTER - in the prompt, not the model's`, transcript }));
  const r = R.readRun({ home, runDir: path.join(home, 'nothing'), session: '09:30-12:00@America/New_York', minutes: 3, symbol: 'MNQ' });
  assert.deepEqual([r.picks[0].decision, r.rows[0].state], ['WAIT', 'waited']);
});
