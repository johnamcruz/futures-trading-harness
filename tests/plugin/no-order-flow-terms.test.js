'use strict';

// The harness knows nothing about order flow (CLAUDE.md, "Separation of work": the broker servers compute
// it and put it on their bars; the harness passes bar fields through and strategies read them with
// field("path")). This test keeps it so: the harness's code and what it teaches the agents (scripts,
// hooks, agents, skills, rules, commands, and the adapters generated from them) never name order-flow
// terms. Strategy documents name the broker's fields as data (strategies/), mcp-configs/brokers.json links
// the servers and their settings, and docs/ holds the neutral notes; none of those is scanned.
// No exceptions and no pins: a hit is fixed, never excused. A skill that must say bars carry extra
// fields says it generically.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { listFiles, normalize, isBinary } = require('./platform-scan');

const REPO = path.resolve(__dirname, '..', '..');

/** Forbidden terms (case-insensitive), each with a sample that must be caught. */
const TERMS = [
  { re: '\\bofi\\b', sample: 'ofi(5)' },
  { re: '(?:(?<![A-Za-z])(?:order|ORDER)|Order)(?:[._-]*|\\s+)(?:flow|Flow|FLOW)', sample: 'Order-Flow', cs: true },
  { re: '\\bbv\\b', sample: 'b.bv' },
  { re: '\\bsv\\b', sample: 'b.sv' },
  { re: '(?:(?<![A-Za-z])(?:buy|BUY)|Buy)(?:[._-]*|\\s+)(?:volume|Volume|VOLUME)', sample: 'buy volume', cs: true },
  { re: '(?:(?<![A-Za-z])(?:sell|SELL)|Sell)(?:[._-]*|\\s+)(?:volume|Volume|VOLUME)', sample: 'sell-volume', cs: true },
  { re: 'bar_?delta', sample: 'barDelta' },
  { re: 'aggressor', sample: 'aggressor' },
  { re: 'footprint', sample: 'footprint' },
  { re: 'includeOrderFlow', sample: 'includeOrderFlow' },
  { re: 'flowWindows', sample: 'flowWindows' },
  { re: 'ofiTrade', sample: 'ofiTrade' },
  { re: 'ofiQuote', sample: 'ofiQuote' },
  { re: '\\bimbalance\\b', sample: 'Imbalance' },
  { re: 'cum(?:ulative)?[\\s-]?delta', sample: 'cumulative delta' },
];
// Most terms match in any case. The word pairs (order flow, buy/sell volume) are case-sensitive, so a camelCase or
// snake_case prefix (hasOrderFlow, HAS_ORDER_FLOW) is caught while a word that only ends in the letters (border, rebuy) is not.
const ANY_CASE = new RegExp(TERMS.filter(t => !t.cs).map(t => t.re).join('|'), 'i');
const EXACT_CASE = new RegExp(TERMS.filter(t => t.cs).map(t => t.re).join('|'));
const FORBIDDEN = {
  test: text => ANY_CASE.test(text) || EXACT_CASE.test(text),
  match: text => text.match(ANY_CASE) || text.match(EXACT_CASE),
};

/** The harness's code and its agent-facing text, canonical and generated. */
const SCOPE = /^(?:scripts|hooks|agents|skills|rules|commands|workspace|\.codex|qwen-extension)\//;

/** Lines in scope that name an order-flow term: `file:line: term`. Paths are checked too. */
function scan(files, read) {
  const hits = [];
  for (const file of files) {
    if (!SCOPE.test(file)) continue;
    if (FORBIDDEN.test(normalize(file))) hits.push(`${file}: the path names order flow`);
    const buf = read(file);
    if (isBinary(file, buf)) continue;
    normalize(buf.toString('utf8')).split('\n').forEach((text, i) => {
      // An escaped newline or tab in a string (JSON, code) separates words as the real one does.
      const m = FORBIDDEN.match(text.replace(/\\[ntr]/g, ' '));
      if (m) hits.push(`${file}:${i + 1}: ${m[0]}`);
    });
  }
  return hits;
}

test('every order-flow term is caught, in any case', () => {
  for (const t of TERMS) {
    assert.ok(FORBIDDEN.test(t.sample), t.sample);
    assert.ok(FORBIDDEN.test(t.sample.toUpperCase()), t.sample.toUpperCase());
  }
  // Spellings a regression would use.
  for (const miss of ['{ order_flow: 1 }', 'ORDER_FLOW', 'order  flow', 'orderflow', 'buy_volume', 'b.bv - b.sv', 'sell_volume', 'the aggressor side', 'a footprint chart', 'bar_delta', 'order.flow', 'buy volume', 'sell-volume', 'sellVolume', 'order_-_flow', 'HAS_ORDER_FLOW', 'x_order_flow', 'SELL_VOLUME_X', 'includeOrderFlow', 'hasOrderFlow', 'getOrderFlow', 'liveBuyVolume', 'totalSellVolume', 'Order Flow', 'ORDER-FLOW']) assert.ok(FORBIDDEN.test(miss), miss);
  // Words that only contain a term's letters are not hits.
  for (const ok of ['ofi_absorption', 'profile', 'workflow', 'delta of the stop', 'field("a.b")', 'bvx', 'svc', 'volume', 'flow strategies']) assert.ok(!FORBIDDEN.test(ok), ok);
  // Prose that only puts the words side by side: separators are spaces, or dots, hyphens and underscores, never mixed with punctuation.
  for (const ok of ['border flow', 'reorder flow', 'in order, flow', 'the bracket order. Flow', 'cash flow', 'rebuy volume', 'oversell volume']) assert.ok(!FORBIDDEN.test(ok), ok);
});

test('an order-flow term in harness code or a skill fails; strategies, docs and brokers.json may name them', () => {
  const files = {
    'scripts/lib/trading/x.js': "const v = ofi(bars, 5);\n",
    'skills/x/SKILL.md': '# X\n\nRead the OFI of the last bar.\n',
    'hooks/hooks.json': '{ "a": "x\\norder flow" }\n',
    'agents/x.md': 'the book imbalance\n',
    'scripts/orderflow.js': "'use strict';\n",
    'workspace/AGENTS.md': 'includeOrderFlow\n',
    'strategies/ofi/STRATEGY.md': '- field("flow.windows.5.ofiTrade") >= 0.3\n',
    'docs/ORDER-FLOW.md': '# Order flow\n',
    'mcp-configs/brokers.json': '"X_BARS_ORDER_FLOW"\n',
    'tests/lib/x.test.js': 'ofi\n',
    'scripts/lib/a.js': 'const c = { order_flow: 1 };\n',
    'scripts/lib/b.js': 'if (ORDER_FLOW) x();\n',
    'rules/trading/x.md': 'Read the order  flow.\n',
    'scripts/lib/c.js': 'const v = b.bv - b.sv;\n',
    'commands/x.md': 'the buy_volume column\n',
    'skills/y/SKILL.md': 'the aggressor side\n',
    'skills/z/SKILL.md': 'a footprint chart\n',
  };
  const hits = scan(Object.keys(files), f => Buffer.from(files[f]));
  assert.deepStrictEqual(hits.sort(), [
    'agents/x.md:1: imbalance',
    'commands/x.md:1: buy_volume',
    'hooks/hooks.json:1: order flow',
    'rules/trading/x.md:1: order  flow',
    'scripts/lib/a.js:1: order_flow',
    'scripts/lib/b.js:1: ORDER_FLOW',
    'scripts/lib/c.js:1: bv',
    'scripts/lib/trading/x.js:1: ofi',
    'scripts/orderflow.js: the path names order flow',
    'skills/x/SKILL.md:3: OFI',
    'skills/y/SKILL.md:1: aggressor',
    'skills/z/SKILL.md:1: footprint',
    'workspace/AGENTS.md:1: includeOrderFlow',
  ]);
});

test('the harness names no order-flow term (scripts, hooks, agents, skills, rules, commands, generated adapters)', () => {
  const { files } = listFiles(REPO);
  assert.ok(files.some(f => f.startsWith('scripts/lib/')) && files.some(f => f.startsWith('skills/')), 'the scan sees the harness');
  assert.deepStrictEqual(scan(files, f => fs.readFileSync(path.join(REPO, f))), []);
});
