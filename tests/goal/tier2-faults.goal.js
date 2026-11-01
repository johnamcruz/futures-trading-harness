'use strict';

/**
 * Tier 2's broker-fault days (npm run goal:full): the live path with the plan-following mock, a broker fault armed on the
 * mock exchange around the day's first order (tests/fixtures/goal-world.js FAULTS; nothing waits: each fault is a reply
 * or a read), one short day each:
 *   lost-reply      the entry's reply never comes (the order is taken and fills)
 *   late-fill       the fill is reported late (the position and its fill not shown for three reads)
 *   late-fill-long  the fill reported late for long enough that the gate's own reads miss the position too
 *   partial-fill    the market entry fills one contract of its size
 *   modify-refused  the runner's first stop moves refused by the broker
 *   modify-error    the runner's first stop moves answered with an error
 * Each must hold (goal-path.js faultChecks): the position never without a stop covering it for more than one managed
 * cycle (on the late-fill days at no pass at all: its bracket stop rests from the fill, however late the fill is
 * reported), no exit refused (the runner never cancelling the position's working stop), no duplicate position, the
 * fault fired, a refused stop move re-attempted, and the fault and its recovery on the day's trace. Any of these failing
 * fails the pull request.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./tier2-run');
const GP = require('../../scripts/lib/eval/goal-path');

const SET = (() => { try { return T.set(); } catch (err) { return { missing: err.message }; } })();
const skip = SET.missing ? `skipped: ${SET.missing}` : false;
const BASE = skip ? null : JSON.parse(fs.readFileSync(SET.baselineFile, 'utf8')).tier2;
const GOLDEN = skip ? null : T.readGolden();
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-goal-faults-'));
// The entry faults on a day whose trade stops out early; the stop-move faults on the move day that trails soonest with
// moves enough for them: the two refused or errored moves (goal-world.js FAULTS modifyFaults) and the re-attempt after.
// A day whose trail moves once and exits (2021-06-15 since the wrong-side swing fix) can't show the re-attempt.
const MOVES_FOR_FAULTS = 3;
const quick = skip ? null : (BASE.trades.find(t => t.exitReason === 'stop') || BASE.trades[0]).day;
const trailed = skip ? null : (GOLDEN.scenarios.filter(s => s.layers && s.layers.exit.moves.length >= MOVES_FOR_FAULTS).sort((a, b) => Date.parse(a.layers.exit.time) - Date.parse(b.layers.exit.time))[0] || {}).day;
const FAULTS = [['lost-reply', quick], ['late-fill', trailed], ['late-fill-long', trailed], ['partial-fill', quick], ['modify-refused', trailed], ['modify-error', trailed]];

async function check(faults) {
  const runs = await Promise.all(faults.map(([fault, day]) => T.runDays([day], { fault, parallel: 1, dir: OUT }).then(r => ({ fault, day, d: r[0] }))));
  const lines = [];
  const bad = [];
  for (const { fault, day, d } of runs) {
    const c = GP.faultChecks(d);
    const trades = GP.dayTrades(d, { tick: d.tick });
    lines.push(`${fault} on ${day}: ${c.trace.map(x => `${x.step} ${x.at} ${x.kind || x.how}`).join('; ')}; trades ${trades.map(t => `${t.size} ${t.side} at ${t.entry}, ${t.exitReason} ${t.R}R`).join(', ') || 'none'}${c.problems.length ? `; PROBLEMS: ${c.problems.join('; ')}` : ''}`);
    if (c.problems.length) bad.push(`${fault}: ${c.problems.join('; ')}`);
    if (!(c.trace.some(x => x.step === 'fault') && c.trace.some(x => x.step === 'recovery'))) bad.push(`${fault}: the trace must record the fault and the recovery`);
  }
  fs.writeFileSync(path.join(OUT, `faults-${faults.map(f => f[0]).join('-')}.json`), JSON.stringify(runs.map(({ fault, day, d }) => ({ fault, day, check: GP.faultChecks(d), snaps: d.snaps })), null, 1));
  process.stdout.write(`${lines.join('\n')}\n(the fault traces: ${OUT})\n`);
  return bad;
}

// Every fault day at once (each its own process): the job's time is the slowest day's.
test('tier 2 broker faults: protected within a managed cycle (a late fill at every pass), no exit refused, no duplicate position, the fault and its recovery traced', { skip }, async () => {
  assert.deepStrictEqual(await check(FAULTS), []);
});
