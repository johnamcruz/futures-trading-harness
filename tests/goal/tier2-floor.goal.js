'use strict';

/**
 * Tier 2's floor days (npm run goal:full): D13's stop floor must bind and refuse, never widen. Two synthetic days
 * (scripts/lib/eval/goal-synth.js floor) whose listed setup's stop (the reaction candle's low, one tick under) is closer
 * than max(stop_floor_ticks, stop_floor_atr x ATR(20)): on floor-ticks the tick term binds (the ATR term below the stop),
 * on floor-atr the ATR term (the stop past stop_floor_ticks). Through the live path with the plan-following mock, each
 * must hold (goal-path.js floorChecks): compose_check's record refused by the floor, its stop the named level less the
 * buffer (not widened to fit), the binding term the day's, and no trade.
 * Mutation checks on a copy of the tree (strategies/trade_lifecycle/STRATEGY.md): stop_floor_ticks 8 -> 4 must let the
 * floor-ticks stop through, and the ATR term removed (stop_floor_atr 0) the floor-atr one: each record OK and a trade.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./tier2-run');
const GP = require('../../scripts/lib/eval/goal-path');
const { stopRuleOf } = require('../../scripts/lib/trading/trade-lifecycle');
const { tmpDir, treeCopy } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const SET = (() => { try { return T.set(); } catch (err) { return { missing: err.message }; } })();
const skip = SET.missing ? `skipped: ${SET.missing}` : false;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-goal-floor-'));
const LIFE = require('../../scripts/lib/trading/strategies').loadStrategies(ROOT, {}).strategies.find(s => s.name === 'trade_lifecycle');
const RULE = stopRuleOf(LIFE.risk);
const DAYS = skip ? [] : T.floorDays();
const STRATEGY = path.join('strategies', 'trade_lifecycle', 'STRATEGY.md');
const edit = (from, to) => treeCopy(tmpDir(), r => {
  const f = path.join(r, STRATEGY);
  const text = fs.readFileSync(f, 'utf8');
  assert.ok(text.includes(from), `${STRATEGY}: ${from}`);
  fs.writeFileSync(f, text.replace(from, to));
});
const MUTATIONS = { ticks: [`stop_floor_ticks: ${RULE.floorTicks} `, 'stop_floor_ticks: 4 '], atr: [`stop_floor_atr: ${RULE.floorAtr} `, 'stop_floor_atr: 0 '] };
const run = (day, root) => T.runDays([day], { root, parallel: 1, dir: OUT }).then(r => r[0]);

let MAIN = null;
const main = () => { MAIN = MAIN || Promise.all(DAYS.map(f => run(f.day).then(d => ({ ...f, d })))); return MAIN; };

test.describe('tier 2 floor days', { concurrency: true }, () => {
  test('tier 2 floor days: compose refuses a stop under D13\'s floor, never widens it, the tick term and the ATR term each binding on its day, no trade', { skip }, async () => {
    assert.deepStrictEqual(DAYS.map(f => f.bind).sort(), ['atr', 'ticks'], 'a floor day for each term');
    const runs = await main();
    const lines = runs.map(({ day, bind, d }) => { const c = GP.floorChecks(d, { rule: RULE, bind }); const s = c.refused && c.refused.plan.stop; return `${day} (${bind}): ${s ? `refused at ${s.ticks} ticks, floor ${s.floorTicks}, stop ${s.price} (level ${s.level})` : 'no refusal'}${c.problems.length ? `; PROBLEMS: ${c.problems.join('; ')}` : ''}`; });
    process.stdout.write(`${lines.join('\n')}\n`);
    assert.deepStrictEqual(runs.flatMap(({ bind, d }) => GP.floorChecks(d, { rule: RULE, bind }).problems), []);
  });

  test('tier 2 floor days mutation checks: stop_floor_ticks 8 -> 4 and the ATR term removed each let their day\'s stop through', { skip }, async () => {
    const [base, runs] = await Promise.all([main(), Promise.all(DAYS.map(f => run(f.day, edit(...MUTATIONS[f.bind])).then(d => ({ ...f, d }))))]);
    for (const { day, bind, d } of runs) {
      const refused = GP.floorChecks(base.find(x => x.day === day).d, { rule: RULE, bind }).refused;
      assert.ok(refused, `${day}: main's refusal`);
      const rec = d.records.find(r => r.at === refused.at);
      const trades = GP.dayTrades(d, { tick: d.tick });
      process.stdout.write(`${bind} mutation on ${day}: the record ${rec ? (rec.ok ? 'OK' : `refused (${rec.problems.join('; ')})`) : 'missing'}; trades ${trades.map(t => `${t.side} ${t.size} at ${t.entry}`).join(', ') || 'none'}\n`);
      assert.ok(rec && rec.ok, `${bind} mutation: the record must pass with the floor ${bind === 'ticks' ? 'at 4 ticks' : 'without its ATR term'}`);
      assert.ok(trades.length > 0, `${bind} mutation: a trade must follow (the floor day's no-trade golden fails)`);
    }
  });
});
