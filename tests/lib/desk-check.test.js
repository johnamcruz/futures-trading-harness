'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { expectedRoles, deskCheck, deskWarning } = require('../../scripts/lib/trading/desk-check');
const { prompts, validateConfig } = require('../../scripts/lib/autotrader');

const ROOT = path.resolve(__dirname, '..', '..');
const ALL = ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager'];

test('expectedRoles: a full trade cycle launches the three analysts and risk-manager phase 1, less the cached; nothing else is expected', () => {
  assert.deepStrictEqual(expectedRoles({ action: 'trade', cycle: 'full' }), ALL);
  assert.deepStrictEqual(expectedRoles({ action: 'trade', cycle: 'full', cachedRoles: ['risk-manager', 'trend-momentum-analyst'] }), ['market-structure-analyst', 'volume-liquidity-analyst']);
  assert.deepStrictEqual(expectedRoles({ action: 'trade', cycle: 'full', cachedRoles: 'risk-manager' }), ALL, 'a malformed cache list is no cache');
  for (const c of [{ action: 'premarket', cycle: 'full' }, { action: 'eod', cycle: 'full' }, { action: 'trade', cycle: 'lean' }, { action: 'trade', cycle: 'full', manageOnly: true }, { action: 'trade', cycle: 'full', paper: true }, {}, undefined]) {
    assert.deepStrictEqual(expectedRoles(c), [], JSON.stringify(c));
  }
});

test('expectedRoles names exactly the roles the full cycle\'s prompt tells it to launch (the roster), cached or not', () => {
  const cfg = validateConfig({ harness: 'opencode', account: '1', symbols: ['MNQ'] });
  const p = prompts(cfg, new Date('2026-10-07T14:03:02Z'), ROOT);
  for (const cachedRoles of [[], ['risk-manager'], ['market-structure-analyst', 'volume-liquidity-analyst'], ['trend-momentum-analyst', 'risk-manager']]) {
    const text = p.trade([{ symbol: 'MNQ' }], { cached: { roles: cachedRoles, reports: [] } });
    const m = /Full cycle: ([^;]*?) as parallel subagents/.exec(text);
    const named = ALL.filter(r => m && m[1].includes(r));
    assert.deepStrictEqual(named, expectedRoles({ action: 'trade', cycle: cfg.cycle, cachedRoles }), cachedRoles.join(',') || 'none cached');
  }
});

test('deskCheck: a role counts once a launch returned; a failed launch alone is missing; roles not expected are ignored', () => {
  const d = deskCheck({ expected: ALL, calls: [{ role: 'risk-manager' }, { role: 'market-structure-analyst' }, { role: 'trade-executor' }, null], failed: ['trend-momentum-analyst', 'task', 'task', 7] });
  assert.deepStrictEqual(d, { expected: ALL, ran: ['market-structure-analyst', 'risk-manager'], missing: ['trend-momentum-analyst', 'volume-liquidity-analyst'], failed: ['trend-momentum-analyst', 'task'], complete: false });
  assert.match(deskWarning(d), /^\[desk\] this cycle was decided without trend-momentum-analyst, volume-liquidity-analyst \(no launch returned\); launches that failed: trend-momentum-analyst, task$/);
  const ok = deskCheck({ expected: ALL, calls: ALL.map(role => ({ role })), failed: ['task'] });
  assert.strictEqual(ok.complete, true);
  assert.strictEqual(deskWarning(ok), null, 'a failed launch retried successfully is a complete desk');
  assert.deepStrictEqual(deskCheck({}), { expected: [], ran: [], missing: [], failed: [], complete: true });
  assert.strictEqual(deskWarning(null), null);
});
