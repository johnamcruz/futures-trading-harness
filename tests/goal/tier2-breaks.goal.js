'use strict';

/**
 * Tier 2's break self-tests (npm run goal:full; a test that can't catch the break it claims to guard is no test): one
 * deliberate break per goal-breaking issue, each on one short day of main's, each asserting tier 2 fails and names it:
 *   drop-setups, compose-refuse, phase2-unread, gate-refuse (tests/goal/breaks.js patches the shipped code) on a day
 *   whose trade stops out early: categories a, b, c, d of main's tier 2 trades; gate-refuse's day also counts as a
 *   lost fill (no first planned entry filled, mock or mechanical: the fills metric 0)
 *   latency (an injected stub of this test only: the replay clock moved past the record's life before the order, nothing
 *   waits): category e
 *   delay (the 3m-confirmation-style delay: the order a bar late) on a move day: its golden's ENTRY layer
 *   stale-trail (the structure trail behind a stale swing) on the move day that trails most: its golden's EXIT layer
 *   no-micro-fallback (the sizing before the owner's 2026-10-30 fix: a stop the composed cap prices out of one mini sized
 *   nothing in auto mode) on main's days whose trade the cap holds to 5 MNQ or fewer (a stop of about 26 points or more,
 *   where the old rule skipped): the sizing check (goal-sizing.js), the simulator skipping a trade live sizes
 * A stop taken away on a late fill is the fault days' (tier2-faults.goal.js: covered at every pass).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const T = require('./tier2-run');
const GP = require('../../scripts/lib/eval/goal-path');

const SET = (() => { try { return T.set(); } catch (err) { return { missing: err.message }; } })();
const skip = SET.missing ? `skipped: ${SET.missing}` : false;
const BASE = skip ? null : JSON.parse(fs.readFileSync(SET.baselineFile, 'utf8')).tier2;
const GOLDEN = skip ? null : T.readGolden();
const OUT = fs.mkdtempSync(`${os.tmpdir()}/fth-goal-breaks-`);
const LIFE = require('../../scripts/lib/trading/strategies').loadStrategies(require('path').resolve(__dirname, '..', '..'), {}).strategies.find(s => s.name === 'trade_lifecycle');
const BAR_MS = require('../../scripts/lib/tunables').runner().bars.timeframe * 60000;
// The latency stub: past the compose record's life (valid_bars base bars), inside the replay clock's tolerance.
const LATE_MS = BAR_MS * (1 + LIFE.valid_bars);

/** main's tier 2 on some days only (a day's own check: its trades and traces decide, no summary). */
const onDays = days => ({ ...BASE, summary: null, behaviour: [], trades: BASE.trades.filter(t => days.includes(t.day)) });
const quick = skip ? null : (BASE.trades.find(t => t.exitReason === 'stop') || BASE.trades[0]).day;
const golden = day => GOLDEN.scenarios.find(s => s.day === day);
const caughtMove = skip ? null : GOLDEN.scenarios.find(s => s.layers && s.layers.capture.caught).day;
const trailed = skip ? null : [...GOLDEN.scenarios].filter(s => s.layers).sort((a, b) => b.layers.exit.moves.length - a.layers.exit.moves.length)[0].day;

const CHECKS = [
  { name: 'drop-setups', day: quick, category: 'a', says: /no setup listed/ },
  { name: 'compose-refuse', day: quick, category: 'b', says: /compose_check refuses/ },
  { name: 'phase2-unread', day: quick, category: 'c', says: /phase 2 approved without a size the runner can read/ },
  { name: 'gate-refuse', day: quick, category: 'd', says: /\[goal-break\]/, lostFill: true },
  { name: 'latency', day: quick, category: 'e', says: /expired|late/, latencyMs: LATE_MS },
];
// The days whose trade the cap holds to 5 MNQ or fewer: wide stops, where the old sizing skipped (the probe: 26-44 points).
const SIZING = skip ? null : { name: 'no-micro-fallback', days: [...new Set(BASE.trades.filter(t => t.size <= 5).map(t => t.day))] };
const MOVES = [
  { name: 'delay (the order a bar late)', day: caughtMove, layer: 'ENTRY', latencyMs: BAR_MS },
  { name: 'stale-trail', day: trailed, layer: 'EXIT', breakName: 'stale-trail' },
];

test('tier 2 break self-tests: each deliberate break fails tier 2 and is named by its category or its layer', { skip }, async () => {
  const runs = await Promise.all([
    ...CHECKS.map(c => T.runDays([c.day], { breakName: c.latencyMs ? null : c.name, latencyMs: c.latencyMs || 0, parallel: 1, dir: OUT }).then(r => ({ c, r }))),
    ...MOVES.map(m => T.runDays([m.day], { breakName: m.breakName || null, latencyMs: m.latencyMs || 0, parallel: 1, dir: OUT }).then(r => ({ m, r }))),
    T.runDays(SIZING.days, { breakName: SIZING.name, parallel: 1, dir: OUT }).then(r => ({ z: SIZING, r })),
  ]);
  const lines = [];
  assert.ok(SIZING.days.length, 'main has a trade the cap holds to 5 MNQ or fewer (a wide stop) for the sizing break');
  for (const { c, m, z, r } of runs) {
    if (z) {
      const j = T.judge(onDays(z.days), T.readTier2(r), r);
      const hit = j.problems.filter(p => /sizing .*the simulator \(the policy's auto mode\) skips a trade live sizes/.test(p));
      lines.push(`${z.name} on ${z.days.join(', ')}: ${j.fail ? 'FAILS' : 'passes'}; ${hit.join('; ') || 'no sizing problem named'}`);
      assert.ok(j.fail && hit.length, `${z.name}: the sizing check must fail it\n${T.reportText(j)}`);
    } else if (c) {
      const j = T.judge(onDays([c.day]), T.readTier2(r), r);
      const hit = j.changes.filter(x => x.category === c.category && c.says.test(x.why));
      lines.push(`${c.name} on ${c.day}: ${j.fail ? 'FAILS' : 'passes'}; ${j.changes.map(x => `(${x.category}) ${x.why}`).join('; ') || 'no change named'}`);
      assert.ok(j.fail, `${c.name}: tier 2 must fail\n${T.reportText(j)}`);
      assert.ok(hit.length, `${c.name}: tier 2 must name category ${c.category} (${GP.CATEGORIES[c.category]}); it named:\n${T.reportText(j)}`);
      // A real lost fill (the gate refusing every entry: neither the mock's nor the mechanical entry fills) still
      // counts as one under the fills metric (the day's first planned entry filled, mock or mechanical).
      if (c.lostFill) {
        const fills = T.readTier2(r).summary.fills;
        lines.push(`${c.name} on ${c.day}: the day's first planned entry filled: ${fills}`);
        assert.ok(r.every(d => d.mechanical.length), `${c.name}: ${c.day} has a mechanical first entry`);
        assert.strictEqual(fills, 0, `${c.name}: a lost fill must count as one (fills ${fills})`);
      }
    } else {
      const diffs = T.judgeMoves(GOLDEN, T.readMoves(r), r[0].tick)[0].diffs;
      lines.push(`${m.name} on ${m.day}: ${diffs.join('; ') || 'as the golden'}`);
      assert.ok(diffs.some(x => x.startsWith(`${m.layer}:`)), `${m.name}: the move golden must name its ${m.layer} layer; it said: ${diffs.join('; ') || 'nothing'}`);
      assert.ok(golden(m.day), m.day);
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
});
