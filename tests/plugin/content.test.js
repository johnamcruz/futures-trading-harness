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

// A cycle that waits for a fill burns its context (a replay broker may fill a market order only at the next bar, and live
// fills can lag): every doc that places or verifies an order checks it once, and an unfilled one ends the cycle.
test('order docs check a new order once and never wait or poll for a fill; the cycle result is plain text', () => {
  const docs = {
    'skills/broker-mcp/SKILL.md': [/check a new order once; never wait for a fill/i, /read its status once/, /Still working[^]*?journal that\s+it is working[^]*?end the cycle/, /Never wait or poll for a fill/, /closing is acting,\s+not waiting/,
      // An unbracketed entry still working is cancelled, and the cancel confirmed (orders and positions read once).
      /Still working without a stop bracket[^]*?`cancel_order` it[^]*?read `list_open_orders` and `list_open_positions`\s+once to confirm/,
      /Gone and flat: journal\s+a review tagged `result:nofill`/, /Filled before\s+the cancel \(in whole or part\): it is a live, executed trade/,
      /cancel was refused, errored, or lost\): cancel\s+once more[^]*?journal a note naming it as an entry\s+without a stop bracket and end the cycle as `error`[^]*?next cycle\s+cancels it first \(interactively, tell the user/,
      /any quantity that filled is\s+protected first/,
      /with its order id and that its stop bracket is attached[^]*?the next cycle\s+tells by the entry's `order_placed` record, whose `data\.request` carries\s+`stopLossBracket`/,
      /`\[protect\]` stop when the order's one status\s+check shows the\s+fill/],
    'skills/trade-session/SKILL.md': [/`list_open_orders` once/, /Not filled yet[^]*?journal a note that the entry is working/, /in an autonomous cycle, end the cycle; interactively, until\s+the next check/, /Never wait or poll for the fill/,
      /Without a stop bracket, the trade-executor cancels the entry[^]*?confirms the cancel/, /journal a review tagged `result:nofill`/,
      /cycle result `no-trade`, entry cancelled: no stop\s+bracket/, /Filled before the cancel and now protected: report it as executed/, /Still working\s+after a second cancel: journal a note naming it as an entry without a stop\s+bracket and report `error`/,
      /Any quantity that filled is protected first in every case/,
      // The next cycle tells a bracketed working entry by the note; no note means cancel; a partial fill's unbracketed rest is cancelled.
      /journal a note that the entry is working \(its order\s+id, and that its stop bracket is attached\)/,
      /tell by the entry's\s+own `order_placed` journal record \(`journal_read \{kind:"order_placed"\}`[^]*?`data\.result\.orderId`[^]*?`stopLossBracket`[^]*?An entry without one, or with no such record,\s+is cancelled first/,
      /an entry order on the position's side \(one that would add to it\) still working without a stop bracket \(the rest of a partial fill; tell by its `order_placed` record, as for a flat account below\) is cancelled first/,
      /The position's own stop and target \(bracket legs, `\[protect\]` and `\[exit\]` orders, on the opposite side\) are never cancelled here/,
      /`journal_read \{kind:"order_placed"\}`, kind\s+only, no `contractId` filter/,
      // The next cycle cancels an unbracketed working entry instead of keeping it as its own pending entry.
      /Keep only\s+a pending entry from your own plan that carries its stop bracket\./],
    'agents/trade-executor.md': [/Check the entry's status once/, /Working, with its stop bracket[^]*?report `EXECUTED` with the entry working, its order id, and that its\s+stop bracket is attached/, /Never wait or poll for a fill/,
      /if the one status\s+check \(step 5\) shows the fill, place the stop/,
      /Working, without a stop bracket[^]*?`cancel_order` it, then read `list_open_orders` and\s+`list_open_positions` once/,
      /Gone and flat: report `ABORTED`[^]*?`result:nofill`\s+review/, /Filled \(in\s+whole or part\) before the cancel: place its `\[protect\]` stop \(or\s+`close_position`\) and report `EXECUTED`, protected/,
      /Still working:\s+`cancel_order` once more[^]*?result is `error`\), so the next cycle cancels it first \(interactively,\s+the caller tells the user\)/,
      /Any quantity that filled is protected\s+first, whatever the rest shows/],
    'skills/autonomous-trading/SKILL.md': [/Never wait\s+within a cycle/, /\*\*Read once per cycle\.\*\* For each symbol, each\s+role/, /A full cycle still runs its analysts in parallel/, /lacks `remainingBeforeLimit` \(and, without a prop attempt,\s+today's P&L\): a cycle that may enter reads `get_account_snapshot` once/, /gives only a count of working orders, the\s+trend rule \(not the multi-timeframe read's alignment\), and no scan\s+details: read `list_open_orders`, `mtf_read`, and `strategies_scan`/, /\(you, each analyst, each call of a role; a role you play yourself\s+counts as that role\)/, /Anything under "Context unavailable", read\s+once yourself/, /A trade review's\s+`get_bars` over a trade's hold is one read per trade reviewed/, /Read the account and open orders once after each `place_order`,\s+`modify_order`, `cancel_order`, `close_position`, or\s+`partial_close_position`, including one that failed or timed out/, /before an order call unless you read them after\s+your last one/, /A failed read may be retried once/, /Never resend an order call blindly: after a failed or timed-out\s+one, read `list_open_orders` and `get_account_snapshot`, and send it\s+again only if they show it didn't go through and it is still needed \(a\s+close or a `\[protect\]` stop always is\)/, /journalled as working and the cycle\s+ends/, /as plain text in your final message: never as a tool call/,
      /unfilled entry without a\s+stop bracket is cancelled, not left working[^]*?cancel confirmed: cancelled, journal a `result:nofill` review and\s+end as `no-trade`[^]*?`executed`[^]*?`error` \(journal it as an entry without a stop bracket\)[^]*?Any quantity that filled is protected first/],
    'skills/end-of-day/SKILL.md': [/a position still\s+open after its close is closed again/, /Don't wait\s+for a close to fill/, /unless its earlier close still shows\s+as a working order in `list_open_orders`: a market order on the opposite\s+side, sized to the position \(a stop or limit is not one/,
      /cancels every working order once that\s+contract reads flat/, /runner keeps\s+closing until it reads flat \(interactively, close again and tell the user/],
    'rules/trading/risk-management.md': [/as soon as the\s+fill shows \(the order's one status check, or the next cycle's read\)/, /still unfilled at its one\s+status check is cancelled, not waited on/],
  };
  for (const [rel, wants] of Object.entries(docs)) {
    const text = read(rel);
    for (const want of wants) assert.match(text, want, `${rel}: ${want}`);
  }
  // No doc still has the executor wait for the fill to show before protecting it.
  assert.doesNotMatch(read('agents/trade-executor.md'), /as soon as\s+`list_open_positions` shows the fill/);
  assert.doesNotMatch(read('skills/broker-mcp/SKILL.md'), /stop once `list_open_positions` shows the fill/);
  // The gate counts a placed entry until a review (result:nofill counts) names it: what the docs tell the model to journal.
  assert.match(read('scripts/lib/trading/order-gate.js'), /hasTag\(e, 'result:nofill'\)/);
  // The generated copies carry it too (node scripts/sync-harness.js).
  assert.match(read('qwen-extension/agents/trade-executor.md'), /Never wait or poll for a fill/);
  assert.match(read('workspace/AGENTS.md'), /still unfilled at its one\s+status check is cancelled, not waited on/);
});

test('the skills say an autonomous entry waits for its roles, and what the plan takes from each', () => {
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const ts = read('skills/trade-session/SKILL.md');
  for (const re of [
    /Every role runs every full cycle: each carries skills the decision needs/,
    /gate refuses an entry \(`\[roles-ran\]`\) until `market-structure-analyst`,\s+`trend-momentum-analyst`, `volume-liquidity-analyst` and `risk-manager` have\s+returned as subagents this cycle, `risk-manager` twice \(phase 1, then phase\s+2 once phase 1 and the analysts have returned\), each in the foreground/,
    /since the last `trade-executor` call:\s+each entry has its own round of reports/,
    /the refused `trade-executor` call itself ends the round, so\s+report the block and end the cycle \(step 6\)/,
    /in an autonomous\s+run there is no stand-in: without the roles' reports, no entry/,
    /until\s+`risk-manager` has returned twice this cycle \(phase 1 and phase 2\)/,
    /structure bias and the level the entry and stop sit against/, /the VWAP side, the value area or POC, the nearest\s+liquidity in the trade's way, and the session window/,
    /multi-timeframe alignment for the side \(aligned, pullback, mixed, counter\)\s+and the size it implies/, /A plan\s+that can't name them isn't ready/,
  ]) assert.match(ts, re);
  assert.match(read('skills/broker-mcp/SKILL.md'), /\| `\[roles-ran\] … not returned yet: <roles>` \|[^\n]*End the cycle \(trade-session step 6\): the refused `trade-executor` call ends the round/);
});

test('the roles start from the bar briefing, reuse it, and say which versions they used', () => {
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const a of ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst']) {
    const t = read(`agents/${a}.md`);
    assert.match(t, /^tools: .*mcp__harness__bar_briefing/m, a);
    assert.match(t, /Start from the bar briefing: `bar_briefing \{"symbol": "<SYMBOL>"\}`[^]*?don't run\s+`market_snapshot`, `mtf_read`, `strategies_scan` or `bars_fetch` for what it\s+already holds/, a);
    assert.match(t, /```text\n## [^\n]*\nData: bar_briefing m3@<\.\.\.>, m15@<\.\.\.>, h1@<\.\.\.>, day@<\.\.\.> \(the versions you used\)/, a);
  }
  const rm = read('agents/risk-manager.md');
  assert.match(rm, /^tools: .*mcp__harness__bar_briefing/m);
  assert.match(rm, /The market facts come from the bar briefing[^]*?don't fetch bars or run\s+`strategies_scan`, `market_snapshot` or `mtf_read` again for what they hold/);
  const ts = read('skills/trade-session/SKILL.md');
  assert.match(ts, /\*\*Every cycle, first:\*\* the bar briefing \(`bar_briefing \{"symbol": "<SYMBOL>"\}`/);
  assert.match(ts, /Read it once and reuse it: no role re-runs\s+`market_snapshot`, `mtf_read` or `strategies_scan` for what it holds/);
  assert.match(ts, /Each report opens with a `Data:` line: the briefing versions it used, or,\s+without a current briefing, the tools it called\. A report with no `Data:`\s+line, or naming another bar's `m3` version while this bar's briefing is\s+current, didn't read this bar: run that analyst again once; if it still\s+doesn't, stand aside\. An old briefing \(the tool says so\) counts as none/);
  assert.match(read('skills/multi-timeframe-analysis/SKILL.md'), /In an autonomous cycle the bar briefing \(`bar_briefing`[^]*?run `mtf_read` only without a current briefing, or for the daily frame/);
  assert.match(read('skills/autonomous-trading/SKILL.md'), /The bar briefing \(`bar_briefing`\) is the\s+runner's file for this bar: read it as often as you need/);
  const ht = read('skills/harness-tools/SKILL.md');
  assert.match(ht, /\| `bar_briefing` \| `symbol`, `json`\? \| the bar briefing the autonomous runner built for the bar this cycle decides/);
  assert.match(ht, /`m3`, every bar: [^|]*today so far \(open, opening range, IB, day type\), the overnight range so far, the developing session profile/);
  assert.match(ht, /`day`, until the first bar after 16:00 ET: the prior RTH day and its profile/);
  assert.match(ht, /When it answers that there is no current briefing, or that it is old, read the bars yourself/);
  assert.match(read('agents/risk-manager.md'), /When the briefing\s+answers that there is no current one, take the candidates, the trend rule\s+and the alignment from the plan the caller gives you and the analysts'\s+reports instead; don't fetch bars for them\./);
  // The analysts read bars only through the harness tools: no raw file reads, no raw get_bars dumps.
  for (const a of ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst']) {
    const tools = /^tools: (.*)$/m.exec(read(`agents/${a}.md`))[1].split(',').map(t => t.trim());
    assert.ok(!tools.includes('Read') && !tools.includes('mcp__broker__get_bars'), a);
  }
});
