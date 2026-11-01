'use strict';

// The prompt-cache lifetime each harness run asks for (scripts/lib/prompt-cache-ttl.js): long enough that the run's
// next one finds its stable prefix still cached, from the role's own timeframe; the lifetimes are config, not code.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const T = require('../../scripts/lib/prompt-cache-ttl');
const { validateConfig, childEnv, CLAUDE_CACHE_TTL_ENV } = require('../../scripts/lib/autotrader');
const { loadAgents } = require('../../scripts/lib/harness-sync');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const TTLS = require('../../scripts/lib/tunables').runner().prompt.cacheTtlMinutes;

test('ttlFor: the shortest configured lifetime that lasts the run\'s interval, else the longest; none without an interval or a lifetime', () => {
  const t = { '5m': 5, '1h': 60 };
  assert.deepStrictEqual([1, 3, 5, 6, 15, 60, 240].map(m => T.ttlFor(m, t)), ['5m', '5m', '5m', '1h', '1h', '1h', '1h']);
  for (const bad of [0, -3, NaN, null, undefined]) assert.strictEqual(T.ttlFor(bad, t), null, String(bad));
  assert.strictEqual(T.ttlFor(3, {}), null);
  assert.strictEqual(T.ttlFor(3, null), null);
  assert.strictEqual(T.ttlFor(3, { x: 0, '1h': 60 }), '1h', 'a lifetime of no minutes is none');
  // The config's own values (config/runner.json prompt.cacheTtlMinutes).
  assert.strictEqual(T.ttlFor(3, TTLS), '5m');
  assert.strictEqual(T.ttlFor(15, TTLS), '1h');
});

test('each run\'s interval: an analyst on its own timeframe (its agent file or the config\'s override) its own, every other run the first lane\'s', () => {
  const agents = loadAgents(ROOT);
  const cfg = validateConfig({ harness: 'claude', timeframe: 3, agents: { 'trend-momentum-analyst': { timeframe: '15m' }, 'volume-liquidity-analyst': { timeframe: '1h' } } });
  assert.strictEqual(T.intervalOf(cfg, null, agents), 3, 'the head trader');
  assert.strictEqual(T.intervalOf(cfg, 'trend-momentum-analyst', agents), 15);
  assert.strictEqual(T.intervalOf(cfg, 'volume-liquidity-analyst', agents), 60);
  for (const r of ['risk-manager', 'trade-executor']) assert.strictEqual(T.intervalOf(cfg, r, agents), 3, r);
  assert.strictEqual(T.ttlOfRun(cfg, 'trend-momentum-analyst', agents, TTLS), '1h');
  assert.strictEqual(T.ttlOfRun(cfg, 'risk-manager', agents, TTLS), '5m');
  assert.strictEqual(T.intervalOf(null, 'x', agents), null, 'no config: none');
});

test('Claude Code\'s run environment carries its lifetime: the head trader and a 3m role 5 minutes, a 15m analyst an hour; another harness none', () => {
  const home = tmpDir();
  // Seeded with a value the runner never sets, so each lifetime below is childEnv's own, never the inherited one; and with
  // each of the two, so neither is merely passed through.
  for (const seed of ['inherited', '1h', '5m']) {
    const base = { FTH_HOME: home, HOME: home, [CLAUDE_CACHE_TTL_ENV]: seed };
    const cfg = validateConfig({ harness: 'claude', timeframe: 3, dataDir: path.join(home, 'bars'), agents: { 'trend-momentum-analyst': { timeframe: '15m' } } });
    const env = role => childEnv(cfg, ROOT, base, { action: 'trade', symbols: [], ...(role ? { roleRun: role } : {}) });
    assert.strictEqual(env(null)[CLAUDE_CACHE_TTL_ENV], '5m', seed);
    assert.strictEqual(env('market-structure-analyst')[CLAUDE_CACHE_TTL_ENV], '5m', seed);
    assert.strictEqual(env('trend-momentum-analyst')[CLAUDE_CACHE_TTL_ENV], '1h', seed);
    assert.strictEqual(env('trade-executor')[CLAUDE_CACHE_TTL_ENV], '5m', seed);
  }
  const q = childEnv(validateConfig({ harness: 'qwen', dataDir: path.join(home, 'bars') }), ROOT, { FTH_HOME: home, HOME: home }, { action: 'trade', symbols: [] });
  assert.strictEqual(q[CLAUDE_CACHE_TTL_ENV], undefined);
});
