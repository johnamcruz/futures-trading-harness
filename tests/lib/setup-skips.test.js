'use strict';

// Every listed setup composed or skipped with a reason (scripts/lib/setup-skips.js): the SKIP lines parsed, a setup
// neither composed nor explained recorded as a process miss, the counts in the run's report, the stated reason in the
// trend findings; nothing reaches the gate.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SK = require('../../scripts/lib/setup-skips');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');

test('parseSkips: one, several, none; malformed lines ignored', () => {
  assert.deepStrictEqual(SK.parseSkips('Plan...\nSKIP "15m rejected overnight low up": HTF prevailing down\nCYCLE RESULT: no-trade - x'), [{ setup: '15m rejected overnight low up', reason: 'HTF prevailing down' }]);
  assert.deepStrictEqual(SK.parseSkips('- SKIP "15m compression break up": no room to 2R (1h swing 3 pts)\n  SKIP "5m cisd up":  waiting for the OTE touch  '), [
    { setup: '15m compression break up', reason: 'no room to 2R (1h swing 3 pts)' }, { setup: '5m cisd up', reason: 'waiting for the OTE touch' }]);
  assert.deepStrictEqual(SK.parseSkips(''), []);
  assert.deepStrictEqual(SK.parseSkips(null), []);
  for (const bad of ['SKIP 15m rejected overnight low up: no quotes', 'SKIP "15m rejected overnight low up":', 'SKIP "": empty', 'I would SKIP "15m broke x up": mid-line', 'skipping "15m broke x up": not the word']) {
    assert.deepStrictEqual(SK.parseSkips(bad), [], bad);
  }
});

test('setupSkips: each listed setup not composed, with its stated reason or none (a process miss); a composed one is no skip', () => {
  const listed = ['15m rejected overnight low up', '15m compression break up', '5m cisd up'];
  const composed = [{ reads: [{ step: 'setup', read: '15m compression break up' }] }];
  const text = 'SKIP "rejected overnight low up": HTF prevailing down';
  const skips = SK.setupSkips({ listed, composed, text });
  assert.deepStrictEqual(skips, [{ setup: '15m rejected overnight low up', reason: 'HTF prevailing down' }, { setup: '5m cisd up', reason: null }], 'a SKIP line without the timeframe still names it');
  assert.deepStrictEqual(SK.misses(skips), [{ setup: '5m cisd up', reason: null }]);
  assert.deepStrictEqual(SK.setupSkips({ listed: [], composed, text }), []);
  assert.deepStrictEqual(SK.misses(undefined), []);
});

test('the cycle log records the listed setups and their skips from the final message; a trade cycle without listed setups records none', () => {
  const { writeCycleLog } = require('../../scripts/lib/cycle-log');
  const stream = text => [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }), JSON.stringify({ type: 'result', subtype: 'success', result: text })].join('\n');
  const out = stream('SKIP "15m rejected overnight low up": HTF prevailing down\nCYCLE RESULT: no-trade - nothing');
  const { summary } = writeCycleLog(tmpDir(), { action: 'trade', harness: 'claude', prompt: 'p', output: out, context: { setupsListed: ['15m rejected overnight low up', '15m broke opening range high up'] } });
  assert.deepStrictEqual([summary.setupsListed, summary.setupSkips], [2, [{ setup: '15m rejected overnight low up', reason: 'HTF prevailing down' }, { setup: '15m broke opening range high up', reason: null }]]);
  const none = writeCycleLog(tmpDir(), { action: 'trade', harness: 'claude', prompt: 'p', output: out, context: {} }).summary;
  assert.ok(!('setupSkips' in none) && !('setupsListed' in none));
});

test('the report counts the listed setups: composed, skipped with a reason, neither', () => {
  const R = require('../../scripts/lib/replay/report');
  const cycle = (listed, skips) => ({ action: 'trade', setupsListed: listed, setupSkips: skips });
  const days = { '2026-04-23': [{ t: '2026-04-23T14:00:00.000Z', kind: 'trade', ran: [], cycles: [cycle(3, [{ setup: 'a', reason: 'x' }, { setup: 'b', reason: null }]), cycle(1, [])], refusals: [] }] };
  const s = R.summarize(days);
  assert.deepStrictEqual(s.total.setups, { listed: 4, skipped: 1, unexplained: 1 });
  assert.strictEqual(R.setupsLine(s.total), 'Setups listed 4: 2 composed, 1 skipped with a reason, 1 neither (a process miss).');
  assert.strictEqual(R.setupsLine(R.summarize({ '2026-04-23': [{ t: 'x', kind: 'trade', ran: [], cycles: [], refusals: [] }] }).total), null);
});

test('the trend findings: a missed leg\'s example shows its stated skip reason the leg\'s way, scrubbed', () => {
  const X = require('../../scripts/lib/train/trend-facts');
  const leg = { side: 'long', facts: { bars: [{ valid: true, known: true, said: 'CYCLE RESULT: no-trade - waiting', shown: 'no-trade - waiting', planReads: ['1h up'], skipped: [{ setup: '15m rejected overnight low up', reason: 'HTF prevailing down at 21512.75 since 10:45' }] }] } };
  const line = X.exampleLine(leg);
  assert.match(line, /^long: what you said: "no-trade - waiting"; you skipped "15m rejected overnight low up": "HTF prevailing down at since"\. A plan that passed there: "1h up"$/);
  assert.doesNotMatch(line, /21512|10:45/);
  // From the cycle record: only the skips with a reason that point the leg's side.
  const rec = { summary: { setupSkips: [{ setup: '15m rejected overnight low up', reason: 'r1' }, { setup: '15m broke opening range low down', reason: 'r2' }, { setup: '5m cisd up', reason: null }] } };
  assert.deepStrictEqual(X.skipsOf(rec, 'long'), [{ setup: '15m rejected overnight low up', reason: 'r1' }]);
  assert.deepStrictEqual(X.skipsOf(rec, 'short'), [{ setup: '15m broke opening range low down', reason: 'r2' }]);
  assert.deepStrictEqual(X.skipsOf(null, 'long'), []);
});

test('no gate effect: the order gate and its checks never read the skips', () => {
  const dir = path.join(ROOT, 'scripts', 'lib', 'trading');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /setup-skips|setupSkips/, f);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'trading', 'check-order.js'), 'utf8'), /SKIP/);
});
