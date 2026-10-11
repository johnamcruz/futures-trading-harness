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

const BROKER_TOOLS = new Set([
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
    const { BY_NAME: HARNESS_TOOLS } = require('../../scripts/lib/harness-tools/registry');
    for (const t of tools.filter(x => x.startsWith('mcp__'))) {
      const m = /^mcp__broker__(\w+)$/.exec(t);
      const h = /^mcp__harness__(\w+)$/.exec(t);
      assert.ok((m && BROKER_TOOLS.has(m[1])) || (h && HARNESS_TOOLS.has(h[1])), `${file}: unknown MCP tool ${t}`);
    }
    const writes = tools.filter(t => WRITE_TOOLS.some(w => t === `mcp__broker__${w}`));
    if (name === 'trade-executor') assert.ok(writes.includes('mcp__broker__place_order'));
    else assert.deepStrictEqual(writes, [], `${file}: only trade-executor may hold order tools`);
  }
  // And in every generated adapter that grants tools by role: opencode's roles (workspace/opencode.json).
  const opencode = JSON.parse(read('workspace/opencode.json'));
  for (const name of agents) {
    const permission = opencode.agent[name].permission;
    assert.strictEqual(Object.keys(permission)[0], '*', `${name}: everything denied first`);
    assert.strictEqual(permission['*'], 'deny');
    const orders = Object.keys(permission).filter(k => WRITE_TOOLS.some(w => k === `broker_${w}`) && permission[k] !== 'deny');
    if (name === 'trade-executor') assert.ok(orders.includes('broker_place_order'));
    else assert.deepStrictEqual(orders, [], `workspace/opencode.json ${name}: only trade-executor may hold order tools`);
    assert.ok(!Object.keys(permission).some(k => /\*/.test(k) && k !== '*'), `${name}: no wildcard grants`);
  }
});

test('backticked skill and agent references point at files that exist', () => {
  const { TAGS: REGIME_TAGS } = require('../../scripts/lib/trading/regime');
  const known = new Set([...skills, ...agents, ...REGIME_TAGS]);
  const candidates = /`([a-z]+(?:-[a-z]+)+)`/g;
  const roleOrSkill = /-(analyst|manager|executor|reviewer|researcher)$|^(trade|strategy|market|premarket|end|autonomous|setup|position|prop|session|liquidity|vwap|trend|multi|broker)-/;
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
  assert.ok(new RegExp(gate.matcher).test('mcp__broker__place_order'));
});

test('every harness manifest agrees on name and version, and its paths exist', () => {
  const version = JSON.parse(read('package.json')).version;
  const claude = JSON.parse(read('.claude-plugin/plugin.json'));
  const claudeMarket = JSON.parse(read('.claude-plugin/marketplace.json'));
  const codex = JSON.parse(read('.codex-plugin/plugin.json'));
  const codexMarket = JSON.parse(read('.agents/plugins/marketplace.json'));
  const qwen = JSON.parse(read('qwen-extension/qwen-extension.json'));
  for (const [file, m] of Object.entries({ claude, codex, qwen })) {
    assert.strictEqual(m.name, 'futures-trading-harness', `${file} name`);
    assert.strictEqual(m.version, version, `${file} version`);
  }
  assert.strictEqual(claudeMarket.plugins[0].name, claude.name);
  assert.strictEqual(claudeMarket.plugins[0].version, version);
  assert.strictEqual(codexMarket.plugins[0].name, codex.name);
  assert.strictEqual(codexMarket.plugins[0].version, version);
  assert.ok(fs.existsSync(path.join(ROOT, codex.skills)), 'codex skills path');
  assert.ok(fs.existsSync(path.join(ROOT, codex.hooks)), 'codex hooks path');
  for (const d of ['agents', 'commands', 'skills', 'hooks']) assert.ok(fs.existsSync(path.join(ROOT, 'qwen-extension', d)), `qwen-extension/${d}`);
});

// A cycle that waits for a fill burns its context (a replayed broker fills a market order at the next bar, and live
// fills can lag): every doc that places or verifies an order checks it once, and an unfilled one ends the cycle.
test('order docs check a new order once and never wait or poll for a fill; the cycle result is plain text', () => {
  const docs = {
    'skills/broker-mcp/SKILL.md': [/check a new order once; never wait for a fill/i, /read its status once/, /Still working[^]*?journal that\s+it is working[^]*?end the cycle/, /Never wait or poll for a fill/, /closing is acting,\s+not waiting/,
      /Still working without a stop bracket[^]*?`cancel_order` it[^]*?`list_open_positions` once[^]*?`\[protect\]` stop/],
    'skills/trade-session/SKILL.md': [/`list_open_orders` once/, /Not filled yet[^]*?journal\s+a note that the entry is working[^]*?end the cycle/, /Never wait or poll for the fill/,
      /Without a stop bracket, the trade-executor cancels the entry/],
    'agents/trade-executor.md': [/Check the entry's status once/, /don't\s+wait\. With its stop bracket attached[^]*?report `EXECUTED` with the entry working/, /Never poll for a fill/,
      /Without a stop bracket \(step 4\): `cancel_order` the entry[^]*?`list_open_positions` once[^]*?`\[protect\]` stop/],
    'skills/autonomous-trading/SKILL.md': [/Never wait\s+within a cycle/, /journalled as working and the cycle\s+ends/, /as plain text in your final message: never as a tool call/,
      /unfilled entry without a\s+stop bracket is cancelled, not left working/],
    'skills/end-of-day/SKILL.md': [/close again until\s+the position is gone/, /Don't wait for a close to\s+fill/, /runner keeps closing until it reads flat/],
  };
  for (const [rel, wants] of Object.entries(docs)) {
    const text = read(rel);
    for (const want of wants) assert.match(text, want, `${rel}: ${want}`);
  }
  // The generated copies carry it too (node scripts/sync-harness.js).
  assert.match(read('qwen-extension/agents/trade-executor.md'), /Never poll for a fill/);
});
