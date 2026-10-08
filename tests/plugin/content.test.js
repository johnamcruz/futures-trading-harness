'use strict';

// Structural checks for the plugin's agents, skills, commands, hooks, and manifest.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const list = rel => fs.readdirSync(path.join(ROOT, rel));

const PROJECTX_TOOLS = new Set([
  'get_server_config', 'list_accounts', 'get_account_snapshot', 'search_contracts', 'get_contract',
  'list_available_contracts', 'get_bars', 'get_quote', 'place_order', 'modify_order', 'cancel_order',
  'close_position', 'partial_close_position', 'list_open_orders', 'search_orders', 'list_open_positions',
  'search_trades', 'get_performance', 'journal_add', 'journal_read',
]);
const WRITE_TOOLS = ['place_order', 'modify_order', 'cancel_order', 'close_position', 'partial_close_position'];

function frontmatter(text, file) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, `${file}: missing YAML frontmatter`);
  const fields = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
  }
  return fields;
}

const skills = list('skills').filter(d => fs.existsSync(path.join(ROOT, 'skills', d, 'SKILL.md')));

test('every skill has matching name, description, and the required sections', () => {
  assert.ok(skills.length >= 15);
  for (const dir of skills) {
    const file = `skills/${dir}/SKILL.md`;
    const text = read(file);
    const fm = frontmatter(text, file);
    assert.strictEqual(fm.name, dir, `${file}: name must match folder`);
    assert.ok(fm.description && fm.description.length >= 40, `${file}: description too short`);
    for (const h of ['## When to Use', '## How It Works', '## Examples']) {
      assert.ok(text.includes(h), `${file}: missing "${h}"`);
    }
  }
});

test('agents declare name, description, tools, model; only the executor can write orders', () => {
  for (const f of list('agents').filter(x => x.endsWith('.md'))) {
    const file = `agents/${f}`;
    const fm = frontmatter(read(file), file);
    assert.strictEqual(fm.name, f.replace(/\.md$/, ''), `${file}: name must match file`);
    for (const k of ['description', 'tools', 'model']) assert.ok(fm[k], `${file}: missing ${k}`);
    const tools = fm.tools.split(',').map(t => t.trim());
    for (const t of tools.filter(x => x.startsWith('mcp__'))) {
      const m = /^mcp__projectx__(\w+)$/.exec(t);
      assert.ok(m && PROJECTX_TOOLS.has(m[1]), `${file}: unknown MCP tool ${t}`);
    }
    const writes = tools.filter(t => WRITE_TOOLS.some(w => t === `mcp__projectx__${w}`));
    if (fm.name === 'trade-executor') assert.ok(writes.includes('mcp__projectx__place_order'));
    else assert.deepStrictEqual(writes, [], `${file}: only trade-executor may hold order tools`);
  }
});

test('agents only reference skills that exist', () => {
  for (const f of list('agents')) {
    const text = read(`agents/${f}`);
    for (const m of text.matchAll(/`((?:playbook|market|trend|vwap|liquidity|session|position|prop|trade|setup|topstepx|multi)-[a-z-]+)`/g)) {
      if (m[1].startsWith('market-structure-analyst') || m[1].startsWith('trade-executor')) continue;
      if (fs.existsSync(path.join(ROOT, 'agents', `${m[1]}.md`))) continue;
      assert.ok(skills.includes(m[1]), `agents/${f}: references missing skill ${m[1]}`);
    }
  }
});

test('commands have a description and reference existing agents', () => {
  const agents = new Set(list('agents').map(f => f.replace(/\.md$/, '')));
  for (const f of list('commands')) {
    const file = `commands/${f}`;
    const text = read(file);
    assert.ok(frontmatter(text, file).description, `${file}: missing description`);
    for (const m of text.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)) {
      if (/-(analyst|manager|executor|reviewer|researcher)$/.test(m[1])) {
        assert.ok(agents.has(m[1]), `${file}: unknown agent ${m[1]}`);
      }
    }
  }
});

test('playbook setup tags match the snapshot signal names', () => {
  const { snapshot } = require('../../scripts/lib/trading/market-snapshot');
  const bars = Array.from({ length: 10 }, (_, i) => ({ t: new Date(Date.UTC(2026, 9, 7, 14, i * 3)).toISOString(), o: 1, h: 2, l: 0, c: 1, v: 1 }));
  const signalNames = Object.keys(snapshot(bars).signals);
  const tags = skills.filter(d => d.startsWith('playbook-'))
    .map(d => (/Journal tag setup:([a-z_]+)/.exec(frontmatter(read(`skills/${d}/SKILL.md`), d).description) || [])[1]);
  assert.ok(tags.every(Boolean), 'every playbook description ends with its journal tag');
  for (const s of signalNames) assert.ok(tags.includes(s), `no playbook for snapshot signal ${s}`);
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

test('plugin manifest and marketplace are valid', () => {
  const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.strictEqual(plugin.name, 'futures-trading-harness');
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  const market = JSON.parse(read('.claude-plugin/marketplace.json'));
  assert.strictEqual(market.plugins[0].name, plugin.name);
  assert.strictEqual(JSON.parse(read('package.json')).version, plugin.version);
});
