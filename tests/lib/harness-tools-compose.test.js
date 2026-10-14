'use strict';

// compose_check (scripts/lib/harness-tools/compose.js, the harness tool and scripts/compose-check.js): the reads checked
// against the cycle bar's briefing only, the plan in code, and every call appended to the record under FTH_HOME
// (never the repository), refused calls too.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { composeCheck, parseArgv } = require('../../scripts/lib/harness-tools/compose');
const { BY_NAME } = require('../../scripts/lib/harness-tools/registry');
const { validate } = require('../../scripts/lib/harness-tools/validate');
const { writeBriefing } = require('../../scripts/lib/trading/briefing');
const { readRecords, recordFile } = require('../../scripts/lib/trading/trade-lifecycle');
const { loadStrategies, checkStrategyForOrder, validateStrategy } = require('../../scripts/lib/trading/strategies');
const { tmpDir } = require('../helpers');
const { scenario1, SCENARIO_1 } = require('../fixtures/trade-lifecycle-scenario');

const ROOT = path.resolve(__dirname, '..', '..');
const BAR = '2026-04-23T14:57:00.000Z';

function setup({ cycleBar = BAR, briefing = scenario1() } = {}) {
  const home = tmpDir();
  if (briefing) writeBriefing(home, briefing);
  const env = { FTH_HOME: home, ...(cycleBar ? { FTH_CYCLE_BARS: JSON.stringify({ MNQ: cycleBar }) } : {}) };
  return { home, ctx: { env, now: () => new Date('2026-04-23T15:00:05Z') } };
}

test('compose_check: scenario 1 is OK, the plan in code, one record appended per call', () => {
  const { home, ctx } = setup();
  const r = composeCheck({ symbol: 'MNQ', side: 'long', reads: SCENARIO_1, size: 1 }, ctx);
  assert.ok(!r.code);
  assert.match(r.text, /entry limit 21540.25; stop 21512.5 [^]*111 ticks[^]*R:R 2.08[^]*size 1 risking \$55.5/);
  assert.match(r.text, /OK: every read verified/);
  const [rec] = readRecords(home, 'MNQ');
  assert.strictEqual(rec.ok, true);
  assert.strictEqual(rec.bar, BAR);
  assert.strictEqual(rec.expiresAt, '2026-04-23T15:03:00.000Z');
  assert.strictEqual(rec.at, '2026-04-23T15:00:05.000Z');
  assert.strictEqual(rec.plan.size, 1);
  assert.strictEqual(rec.plan.maxSize, 1, 'the shipped strategy\'s $100 cap over $55.50 a contract');
  assert.strictEqual(rec.signature, 'bias:1h-bos-up+bias:above-prior-rth-range+location:at-prior-vah+setup:15m-rejected-prior-vah-up+entry:3m-close-top+entry:3m-momentum-up+stop:15m-low+target:1h-swing-1.5-2.5r');
  assert.strictEqual(rec.context.trendSide, 'with');
  // Under FTH_HOME, never the repository.
  assert.ok(recordFile(home, 'MNQ').startsWith(home));
  // Append-only: a second call adds a line.
  composeCheck({ symbol: 'MNQ', side: 'short', reads: SCENARIO_1, size: 1 }, ctx);
  const all = readRecords(home, 'MNQ');
  assert.deepStrictEqual(all.map(x => [x.side, x.ok]), [['long', true], ['short', false]]);
});

test('compose_check: a false read, an unknown skill or a size over the cap is recorded NOT OK', () => {
  const { home, ctx } = setup();
  const one = reads => composeCheck({ symbol: 'MNQ', side: 'long', reads, size: 1 }, ctx);
  assert.match(one(SCENARIO_1.map(x => (x.step === 'setup' ? { ...x, read: '15m rejected prior VAH down' } : x))).text, /FALSE setup[^]*NOT OK/);
  assert.match(one(SCENARIO_1.map((x, i) => (i === 0 ? { ...x, skill: 'astrology' } : x))).text, /no skill named astrology[^]*NOT OK/);
  assert.match(composeCheck({ symbol: 'MNQ', side: 'long', reads: SCENARIO_1, size: 2 }, ctx).text, /PROBLEM: size 2 risks \$111, over the strategy's risk.max_risk_usd \$100/);
  assert.deepStrictEqual(readRecords(home, 'MNQ').map(x => x.ok), [false, false, false]);
});

test('compose_check: no cycle bar, another bar\'s briefing or none: refused and recorded, never checked against a guess', () => {
  for (const [opts, why] of [[{ cycleBar: null }, /no cycle bar for MNQ/], [{ cycleBar: '2026-04-23T15:00:00.000Z' }, /briefing is for the bar at 2026-04-23T14:57:00.000Z, not the cycle's/], [{ briefing: null }, /no bar briefing for MNQ/]]) {
    const { home, ctx } = setup(opts);
    const r = composeCheck({ symbol: 'MNQ', side: 'long', reads: SCENARIO_1, size: 1 }, ctx);
    assert.match(r.text, why);
    assert.match(r.text, /NOT OK/);
    const [rec] = readRecords(home, 'MNQ');
    assert.strictEqual(rec.ok, false);
    assert.deepStrictEqual(rec.reads, []);
  }
  // Under a replay clock, never a briefing of a bar that closed after it.
  const { home, ctx } = setup();
  ctx.replayAt = () => new Date('2026-04-23T14:59:00Z');
  assert.match(composeCheck({ symbol: 'MNQ', side: 'long', reads: SCENARIO_1, size: 1 }, ctx).text, /NOT OK/);
  assert.strictEqual(readRecords(home, 'MNQ')[0].ok, false);
});

test('compose_check: arguments refused before anything is recorded; the CLI\'s argv', () => {
  const { home, ctx } = setup();
  assert.throws(() => composeCheck({ symbol: 'mnq', side: 'long', reads: [], size: 1 }, ctx), /--symbol/);
  assert.throws(() => composeCheck({ symbol: 'MNQ', side: 'flat', reads: [], size: 1 }, ctx), /--side/);
  assert.throws(() => composeCheck({ symbol: 'MNQ', side: 'long', reads: 'x', size: 1 }, ctx), /--reads/);
  assert.ok(!fs.existsSync(recordFile(home, 'MNQ')));
  assert.deepStrictEqual(parseArgv(['--symbol', 'MNQ', '--side=long', '--size', '2', '--reads', '[{"step":"bias"}]']), { symbol: 'MNQ', side: 'long', size: 2, reads: [{ step: 'bias' }] });
  assert.throws(() => parseArgv(['--reads', '{bad']), /--reads: JSON/);
  assert.throws(() => parseArgv(['--bogus']), /unknown argument/);
});

test('the tool: its schema takes the reads and a size and refuses the rest', () => {
  const t = BY_NAME.get('compose_check');
  const ok = { symbol: 'MNQ', side: 'long', reads: SCENARIO_1, size: 1 };
  assert.deepStrictEqual(validate(t.inputSchema, ok), []);
  assert.deepStrictEqual(t.args(ok), ok);
  for (const bad of [{ ...ok, size: 0 }, { ...ok, size: 1.5 }, { ...ok, reads: [] }, { ...ok, reads: [{ step: 'exit', skill: 'x', read: 'y' }] },
    { ...ok, reads: [{ step: 'bias', read: 'y' }] }, { ...ok, extra: 1 }, { ...ok, reads: [{ ...SCENARIO_1[0], field: 'h1' }] }, { symbol: 'MNQ', side: 'long', reads: SCENARIO_1 }]) {
    assert.ok(validate(t.inputSchema, bad).length, JSON.stringify(bad).slice(0, 80));
  }
});

test('the trade_lifecycle strategy: signal composed, active, max_risk_usd required; the gate places no entry from it yet', () => {
  const s = loadStrategies(ROOT, {}).strategies.find(x => x.name === 'trade_lifecycle');
  assert.ok(s && s.valid, s && s.errors.join('; '));
  assert.strictEqual(s.signal, 'composed');
  assert.strictEqual(s.status, 'active');
  const body = '## When to Use\n## How It Works\n## Examples\n';
  const base = { name: 'x', description: 'a composed strategy for the schema test, forty chars', status: 'active', instruments: ['MNQ'], timeframe: '3m', signal: 'composed', risk: { stop: 'structure', min_rr: 2, max_risk_usd: 100 } };
  assert.deepStrictEqual(validateStrategy(base, body, 'x'), []);
  assert.ok(validateStrategy({ ...base, risk: { stop: 'structure', min_rr: 2 } }, body, 'x').some(e => /max_risk_usd: required for signal: composed/.test(e)));
  assert.ok(validateStrategy({ ...base, risk: { stop: 'atr:0.5', min_rr: 2, max_risk_usd: 100 } }, body, 'x').some(e => /risk.stop: structure/.test(e)));
  assert.ok(validateStrategy({ ...base, exit: { target_r: 2 } }, body, 'x').some(e => /exit: not for signal: composed/.test(e)));
  // Fails closed until the gate checks its reads: the strategy check refuses it.
  assert.match(checkStrategyForOrder([s], 'trade_lifecycle', 'MNQ', new Date('2026-04-23T15:00:05Z'), 'buy'), /doesn't check its reads yet, so it places no entries/);
});
