'use strict';

// The Market state is a read, not a filter (MARKET-STATE-SPEC, feat/chop-read): it is printed in the briefing's summary
// and restated by the recognition key's coded read (measurement), and no gate, hook, gateway, compose, entry-rule or
// decision code reads it. Every file under scripts/ and hooks/ that requires market-state.js, or names the printed line,
// is on this allow-list; anything else fails.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const REQUIRERS = ['scripts/lib/trading/briefing.js', 'scripts/lib/learning/recognition/key.js', 'scripts/lib/eval/context-quiz.js'];
const NAMERS = ['scripts/lib/trading/market-state.js', ...REQUIRERS];

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(rel));
    else if (/\.(c?js|mjs|json)$/.test(e.name)) out.push(rel);
  }
  return out;
}

const ALL = [...files('scripts'), ...files('hooks')];

test('only the briefing, the recognition key and the quiz lib require market-state.js', () => {
  const req = ALL.filter(f => /require\([^)]*market-state['"]\)/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepStrictEqual(req.sort(), [...REQUIRERS].sort());
});

test('no other script or hook names the Market state line or the module', () => {
  const named = ALL.filter(f => /Market state \(|\/market-state['"]/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepStrictEqual(named.filter(f => !NAMERS.includes(f)), []);
});

test('the decision paths are not among the readers (the gate, hooks, gateway, compose, entry rule, decision parsers)', () => {
  const decides = /(^hooks\/|^scripts\/hooks\/|gate|gateway|compose|entry-rule|order-plan|decision|verdict|phase2|autotrader|runner)/;
  for (const f of REQUIRERS) assert.doesNotMatch(f, decides, f);
  // The test sees the files it guards: the gate and the gateway exist where it scans.
  assert.ok(ALL.some(f => /order-gate/.test(f)) && ALL.includes('scripts/mcp-gateway.js'), 'the decision files are scanned');
});
