'use strict';

// Quoted text never parses as the model's STOP line (DESIGN 5.2): no skill, agent, rule, command or generated prompt
// text holds a form trading/stop-line.js stopLines returns, so a model that echoes its instructions never states a line
// it did not decide (a skill's example "-> STOP 21516.75: ..." was a line start before the arrow was excluded).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stopLines, parseStopLine } = require('../../scripts/lib/trading/stop-line');

const ROOT = path.resolve(__dirname, '..', '..');
const walk = d => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
  const p = path.join(d, e.name);
  if (e.isSymbolicLink()) return [];
  return e.isDirectory() ? walk(p) : [p];
}) : []);

test('no instruction text (skills, agents, rules, commands, the generated adapters) holds a line stopLines reads', () => {
  const files = ['skills', 'agents', 'rules', 'commands', '.codex', 'qwen-extension'].flatMap(d => walk(path.join(ROOT, d)))
    .concat(walk(path.join(ROOT, 'workspace')).filter(f => /\.(md|json)$/.test(f)))
    .filter(f => /\.(md|json|toml)$/.test(f));
  assert.ok(files.some(f => f.endsWith(path.join('manage-position', 'SKILL.md'))), 'the manage-position skill is scanned');
  const found = files.map(f => [path.relative(ROOT, f), stopLines(fs.readFileSync(f, 'utf8'))]).filter(([, x]) => x.length);
  assert.deepStrictEqual(found, []);
});

test('the head trader\'s generated prompt and a managed cycle\'s situational text hold none either', () => {
  const head = require('../../scripts/lib/head-prompt').claudeHeadText(ROOT);
  const SS = require('../../scripts/lib/situational-skills');
  const A = require('../../scripts/lib/autotrader');
  const loaded = A.cycleLoaded(A.validateConfig({ harness: 'claude' }));
  const managed = SS.situationText(ROOT, SS.choose(ROOT, SS.factsOf({ state: { positions: [{ contractId: 'MNQ', type: 1, size: 1, averagePrice: 21500 }], workingOrders: 1 } }), { loaded }));
  assert.ok(/manage-position/.test(managed), 'the managed situation carries manage-position');
  for (const [name, text] of [['head', head], ['managed situation', managed]]) {
    assert.deepStrictEqual(stopLines(text), [], name);
    assert.strictEqual(parseStopLine(text).stated, false, name);
  }
});
