'use strict';

// Structural checks for agents, skills, commands, strategies, hooks, and manifests.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const list = rel => fs.readdirSync(path.join(ROOT, rel));
const fm = rel => parseFrontmatter(read(rel)).data;

const PROJECTX_TOOLS = new Set([
  'get_server_config', 'list_accounts', 'get_account_snapshot', 'search_contracts', 'get_contract',
  'list_available_contracts', 'get_bars', 'get_quote', 'place_order', 'modify_order', 'cancel_order',
  'close_position', 'partial_close_position', 'list_open_orders', 'search_orders', 'list_open_positions',
  'search_trades', 'get_performance', 'journal_add', 'journal_read',
]);
const WRITE_TOOLS = ['place_order', 'modify_order', 'cancel_order', 'close_position', 'partial_close_position'];

const skills = list('skills').filter(d => fs.existsSync(path.join(ROOT, 'skills', d, 'SKILL.md')));
const agents = list('agents').filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));

test('every skill has matching name, description, and the required sections', () => {
  assert.ok(skills.length >= 18);
  for (const dir of skills) {
    const file = `skills/${dir}/SKILL.md`;
    const data = fm(file);
    assert.strictEqual(data.name, dir, `${file}: name must match folder`);
    assert.ok(typeof data.description === 'string' && data.description.length >= 40, `${file}: description too short`);
    for (const h of ['## When to Use', '## How It Works', '## Examples']) {
      assert.ok(read(file).includes(h), `${file}: missing "${h}"`);
    }
  }
});

test('agents declare name, description, tools, model; only the executor can write orders', () => {
  for (const name of agents) {
    const file = `agents/${name}.md`;
    const data = fm(file);
    assert.strictEqual(data.name, name, `${file}: name must match file`);
    for (const k of ['description', 'tools', 'model']) assert.ok(data[k], `${file}: missing ${k}`);
    const tools = String(data.tools).split(',').map(t => t.trim());
    for (const t of tools.filter(x => x.startsWith('mcp__'))) {
      const m = /^mcp__projectx__(\w+)$/.exec(t);
      assert.ok(m && PROJECTX_TOOLS.has(m[1]), `${file}: unknown MCP tool ${t}`);
    }
    const writes = tools.filter(t => WRITE_TOOLS.some(w => t === `mcp__projectx__${w}`));
    if (name === 'trade-executor') assert.ok(writes.includes('mcp__projectx__place_order'));
    else assert.deepStrictEqual(writes, [], `${file}: only trade-executor may hold order tools`);
  }
});

test('backticked skill and agent references point at files that exist', () => {
  const known = new Set([...skills, ...agents]);
  const candidates = /`([a-z]+(?:-[a-z]+)+)`/g;
  const roleOrSkill = /-(analyst|manager|executor|reviewer|researcher)$|^(trade|strategy|market|premarket|end|autonomous|setup|position|prop|session|liquidity|vwap|trend|multi|topstepx)-/;
  const files = [
    ...agents.map(a => `agents/${a}.md`),
    ...skills.map(s => `skills/${s}/SKILL.md`),
    ...list('commands').map(c => `commands/${c}`),
  ];
  for (const file of files) {
    for (const m of read(file).matchAll(candidates)) {
      if (!roleOrSkill.test(m[1])) continue;
      assert.ok(known.has(m[1]), `${file}: references missing skill or agent "${m[1]}"`);
    }
  }
});

test('commands have a description and point at an existing skill', () => {
  for (const f of list('commands')) {
    const file = `commands/${f}`;
    assert.ok(fm(file).description, `${file}: missing description`);
    const m = /Use the `([a-z-]+)` skill/.exec(read(file));
    assert.ok(m && skills.includes(m[1]), `${file}: must delegate to an existing skill`);
  }
});

test('hooks.json points at existing scripts through run-with-flags', () => {
  const hooks = JSON.parse(read('hooks/hooks.json')).hooks;
  let count = 0;
  for (const groups of Object.values(hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        const m = /run-with-flags\.js" (\S+) (\S+) (\S+)$/.exec(h.command);
        assert.ok(m, `unexpected hook command: ${h.command}`);
        assert.ok(fs.existsSync(path.join(ROOT, m[2])), `missing hook script ${m[2]}`);
        count += 1;
      }
    }
  }
  assert.ok(count >= 3);
  const gate = hooks.PreToolUse.find(g => /place_order/.test(g.matcher));
  assert.ok(new RegExp(gate.matcher).test('mcp__projectx__place_order'));
});

test('plugin manifests agree on name and version', () => {
  const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.strictEqual(plugin.name, 'futures-trading-harness');
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(JSON.parse(read('.claude-plugin/marketplace.json')).plugins[0].name, plugin.name);
  assert.strictEqual(JSON.parse(read('package.json')).version, plugin.version);
});
