'use strict';

// Read once, in code: in an autonomous cycle whose bar briefing is current, the tools that recompute what it holds
// (the summary strategies_scan, the default mtf_read) point to it instead; anything it doesn't hold still runs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const B = require('../../scripts/lib/trading/briefing');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { scan } = require('../../scripts/lib/harness-tools/strategies');
const { mtf } = require('../../scripts/lib/harness-tools/mtf');
const { briefedThisCycle } = require('../../scripts/lib/harness-tools/briefing');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const BARS = readBarsArg(path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv')).slice(0, 1300);

function setup() {
  const home = tmpDir();
  const b = B.buildBriefing({ symbol: 'MNQ', bars: BARS, minutes: 3 });
  B.writeBriefing(home, b);
  const file = path.join(home, 'MNQ-3m.json');
  fs.writeFileSync(file, JSON.stringify({ bars: BARS }));
  const ctx = cycleBar => ({ root: ROOT, env: { FTH_HOME: home, NODE_ENV: 'test', FTH_TEST_NOW: b.closedAt, ...(cycleBar ? { FTH_CYCLE_BARS: JSON.stringify({ MNQ: cycleBar }) } : {}) } });
  return { b, file, ctx };
}

test('briefedThisCycle: this cycle\'s bar briefing for the symbol, else null', () => {
  const { b, ctx } = setup();
  assert.strictEqual(briefedThisCycle(ctx(b.asOf).env, 'MNQ').asOf, b.asOf);
  assert.strictEqual(briefedThisCycle(ctx(b.asOf).env, 'NQ').asOf, b.asOf, 'the family');
  assert.strictEqual(briefedThisCycle(ctx(b.asOf).env, null).asOf, b.asOf, 'the cycle\'s only symbol');
  assert.strictEqual(briefedThisCycle(ctx('2026-01-01T00:00:00.000Z').env, 'MNQ'), null, 'another bar');
  assert.strictEqual(briefedThisCycle(ctx(null).env, 'MNQ'), null, 'not a cycle');
  assert.strictEqual(briefedThisCycle(ctx(b.asOf).env, 'MES'), null, 'another symbol');
});

test('strategies_scan: the summary points to the current briefing; name, detail, record, or no current briefing still scan', () => {
  const { b, file, ctx } = setup();
  assert.match(scan({ file, symbol: 'MNQ', view: 'summary' }, ctx(b.asOf)).text, /^This bar's briefing is current \(bar_briefing \{"symbol": "MNQ"\}\): its m3 candidates are this scan/);
  assert.doesNotMatch(scan({ file, symbol: 'MNQ', view: 'summary' }, ctx(null)).text, /briefing is current/, 'outside a cycle');
  assert.doesNotMatch(scan({ file, symbol: 'MNQ', view: 'summary' }, ctx('2026-01-01T00:00:00.000Z')).text, /briefing is current/, 'another bar\'s briefing');
  assert.doesNotMatch(scan({ file, symbol: 'MNQ', view: 'one', name: 'orb' }, ctx(b.asOf)).text, /briefing is current/, 'one strategy\'s full result');
  assert.doesNotMatch(scan({ file, symbol: 'MNQ', view: 'json' }, ctx(b.asOf)).text, /briefing is current/, 'detail');
});

test('mtf_read: the default read points to the current briefing; a daily file, other timeframes or json still read', () => {
  const { b, file, ctx } = setup();
  assert.match(mtf({ file, symbol: 'MNQ' }, ctx(b.asOf)).text, /^This bar's briefing is current \(bar_briefing\): its m15 alignment/);
  assert.match(mtf({ file }, ctx(b.asOf)).text, /briefing is current/, 'the cycle\'s only symbol');
  assert.doesNotMatch(mtf({ file, symbol: 'MNQ' }, ctx(null)).text, /briefing is current/);
  assert.doesNotMatch(mtf({ file, symbol: 'MNQ', tf: [5, 30] }, ctx(b.asOf)).text, /briefing is current/);
  assert.doesNotMatch(mtf({ file, symbol: 'MNQ', json: true }, ctx(b.asOf)).text, /briefing is current/);
});
