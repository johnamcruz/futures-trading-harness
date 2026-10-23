'use strict';

// Structural checks for agents, skills, commands, strategies, hooks, and manifests.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');

const ROOT = path.resolve(__dirname, '..', '..');
// trade-session and the skills it was split into (tests/plugin/trade-session-split.test.js): its text, wherever it is now.
const TRADE_SESSION_SPLIT = ['trade-session', 'role-round', 'lean-cycle', 'manage-position', 'leftover-orders', 'setup-judgment', 'day-context', 'trade-plan', 'entry-outcome'].map(s => `skills/${s}/SKILL.md`);
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
const LONG_DESCRIPTIONS = JSON.parse(read('tests/plugin/skill-descriptions.pins.json'));
const agents = list('agents').filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));

test('every skill has matching name, description, and the required sections', () => {
  assert.ok(skills.length >= 18);
  for (const dir of skills) {
    const file = `skills/${dir}/SKILL.md`;
    const data = fm(file);
    assert.strictEqual(data.name, dir, `${file}: name must match folder`);
    assert.ok(typeof data.description === 'string' && data.description.length >= 40, `${file}: description too short`);
    // One sentence of when to use it, at most 160 characters: it reaches every prompt as an index or listing line.
    // Only a description pinned in skill-descriptions.pins.json (skills-indexed.test.js: only shrinking) is over.
    if (!Object.hasOwn(LONG_DESCRIPTIONS, dir)) {
      assert.ok(data.description.length <= 160, `${file}: description is ${data.description.length} characters, over 160`);
    }
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
    // Optional `timeframe` (the bars the role reads; none: the lane's): a timeframe such as 3m, 15m, 1h (lanes.js).
    if (data.timeframe !== undefined) assert.notStrictEqual(require('../../scripts/lib/lanes').tfMinutes(data.timeframe), null, `${file}: timeframe ${data.timeframe}`);
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
  // Skill references in prose too: a name, backticked or not, followed by "skill", "skill's" or "step N" must be a skill,
  // and a section it names ("<skill> skill, <Section>", "<skill> skill's <Section> table", "(<skill>, <Section>)") must
  // be one of that skill's headings exactly (a split skill leaves no pointer to a gone section). Docs and the README too.
  const misses = text => skillRefMisses(text, new Set(skills), s => read(`skills/${s}/SKILL.md`));
  const docs = fs.readdirSync(path.join(ROOT, 'docs'), { recursive: true }).map(String).filter(f => f.endsWith('.md')).map(f => `docs/${f}`);
  for (const file of [...files, ...list('rules/trading').map(r => `rules/trading/${r}`), ...docs, 'README.md']) {
    assert.deepStrictEqual(misses(read(file)), [], file);
  }
  // The check catches what it is for (it would fail without it).
  assert.deepStrictEqual(misses('see the no-such-skill skill'), ['no-such-skill']);
  assert.deepStrictEqual(misses('(the `no-such-thing` skill)'), ['no-such-thing']);
  assert.deepStrictEqual(misses('as in no-such-flow step 3'), ['no-such-flow']);
  assert.deepStrictEqual(misses('the fill (broker-mcp skill, Order mechanics).'), ['broker-mcp, Order mechanics']);
  assert.deepStrictEqual(misses('see the broker-mcp skill, Errors. Then'), ['broker-mcp, Errors']);
  assert.deepStrictEqual(misses('the broker-mcp skill\'s Errors table'), ['broker-mcp, Errors']);
  assert.deepStrictEqual(misses('the `broker-mcp` skill\'s Failures and limits section'), ['broker-mcp, Failures and limits']);
  assert.deepStrictEqual(misses('(broker-mcp, Errors)'), ['broker-mcp, Errors']);
  assert.deepStrictEqual(misses('(broker-mcp skill, Session)'), ['broker-mcp, Session'], 'a prefix of a heading is not a heading');
  assert.deepStrictEqual(misses('(strategy-library skill, "The priority")'), ['strategy-library, The priority']);
  assert.deepStrictEqual(misses('(broker-mcp skill, Session loop) and the trade-session skill\'s step 6, trade-session step 6'), []);
  assert.deepStrictEqual(misses('(the strategy-library skill, "The priority order"), (strategy-library, "The priority order"), the `broker-mcp` skill\'s Tools table'), []);
});

/**
 * Skill references in prose that point nowhere: "<name> skill", "<name> skill's", "<name> step N" (the name backticked
 * or not) where <name> isn't a skill, and a section of a skill ("<name> skill, <Section>", "<name> skill's <Section>
 * table|section|list|row", "(<name>, <Section>)"; the section capitalised or quoted) that isn't one of its headings.
 * A heading matches exactly, or by its title before ": " ("The priority order: the rule for every setup").
 */
function skillRefMisses(text, skillSet, readSkill) {
  const flat = text.replace(/\s+/g, ' ');
  const out = [];
  const NAME = '(?<![\\w/-])`?([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`?';
  for (const m of flat.matchAll(new RegExp(`${NAME}(?= skill\\b| skill's\\b| step \\d)`, 'g'))) {
    if (!skillSet.has(m[1])) out.push(m[1]);
  }
  const SECTION = '(?:"([^"]+)"|([A-Z][^).,;:"]*?))';
  const forms = [
    new RegExp(`${NAME} skill, ${SECTION}(?=[).,;:]|$)`, 'g'),
    new RegExp(`${NAME} skill's ${SECTION}(?= (?:table|section|list|row)\\b|[).,;:]|$)`, 'g'),
    new RegExp(`\\(${NAME}, ${SECTION}(?=[),;])`, 'g'),
  ];
  for (const re of forms) {
    for (const m of flat.matchAll(re)) {
      if (!skillSet.has(m[1])) continue;
      const section = (m[2] || m[3]).trim();
      const headings = readSkill(m[1]).split('\n').filter(l => /^#{1,4} /.test(l)).map(l => l.replace(/^#+ /, '').trim());
      if (!headings.some(h => h === section || h.split(': ')[0] === section)) out.push(`${m[1]}, ${section}`);
    }
  }
  return out;
}

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
    'skills/order-mechanics/SKILL.md': [/check a new order once; never wait for a fill/i, /read its status once/, /Still working[^]*?journal that\s+it is working[^]*?end the cycle/, /Never wait or poll for a fill/, /closing is acting,\s+not waiting/,
      // An unbracketed entry still working is cancelled, and the cancel confirmed (orders and positions read once).
      /Still working without a stop bracket[^]*?`cancel_order` it[^]*?read `list_open_orders` and `list_open_positions`\s+once to confirm/,
      /Gone and flat: journal\s+a review tagged `result:nofill`/, /Filled before\s+the cancel \(in whole or part\): it is a live, executed trade/,
      /cancel was refused, errored, or lost\): cancel\s+once more[^]*?journal a note naming it as an entry\s+without a stop bracket and end the cycle as `error`[^]*?next cycle\s+cancels it first \(interactively, tell the user/,
      /any quantity that filled is\s+protected first/,
      /with its order id and that its stop bracket is attached[^]*?the next cycle\s+tells by the entry's `order_placed` record, whose `data\.request` carries\s+`stopLossBracket`/,
      // A broker's refusal is reported, never answered by entering without the bracket (order-types carries the bracket).
      /\*\*Refused\*\*: a reply with `success: false` and an `errorCode`[^]*?Don't send it again without its brackets, and never enter without\s+them to place a stop afterwards[^]*?end the cycle as `blocked`/,
      /\*\*Any other error is an unknown outcome, not a refusal\*\*[^]*?a lost reply, a timeout, or a\s+message\s+that a position may be open\.\s+Read `list_open_positions` and\s+`list_open_orders` at once[^]*?`\[protect\]` stop, or `close_position`, before anything\s+else\. Never send the entry again/,
      /Flat with no working entry after a successful reply[^]*?`result:nofill`\s+only\s+when\s+nothing\s+shows\s+the\s+order\s+filled/,
      /Still working without a stop bracket \(one the gate never checked/],
    // Every entry carries its bracket (moved from order-mechanics: tests/plugin/order-mechanics-split.test.js).
    'skills/order-types/SKILL.md': [/Every entry carries its stop as `stopLossBracket \{ticks, type: "stop"\}`[^]*?the gate\s+refuses an entry without one \(`\[stop-defined\]`\), a check autonomous runs\s+can't skip[^]*?flattens it and says so[^]*?an error saying a position may be open: that is not a refusal/],
    // trade-session's step 6 and step 1 parts are skills of their own (tests/plugin/trade-session-split.test.js).
    'skills/entry-outcome/SKILL.md': [/`list_open_orders` once/, /Not filled yet[^]*?journal a note that the entry is working/, /in an autonomous cycle, end the cycle; interactively, until\s+the next check/, /Never wait or poll for the fill/,
      /Every entry carries its stop bracket \(the gate refuses an entry\s+without one, a check autonomous runs can't skip\)\. Refused \(`success: false`\s+with an `errorCode`[^]*?cycle result `blocked`\); never send the entry\s+again without its bracket\. Any other error[^]*?is an unknown outcome, not a refusal[^]*?never re-sends the entry\.\s+Flat after a successful reply[^]*?`result:nofill`\s+only\s+when\s+nothing\s+shows\s+the\s+order\s+filled/,
      /A position without a working stop is fixed before anything\s+else \(the trade-executor places a `\[protect\]` stop, or closes the position\)/,
      // The next cycle tells a bracketed working entry by the note; no note means cancel; a partial fill's unbracketed rest is cancelled.
      /journal a note that the entry is working \(its order\s+id, and that its stop bracket is attached\)/],
    'skills/leftover-orders/SKILL.md': [/a `result:nofill` review journalled/,
      /tell by the entry's\s+own `order_placed` journal record \(`journal_read \{kind:"order_placed"\}`[^]*?`data\.result\.orderId`[^]*?`stopLossBracket`[^]*?An entry without one, or with no such record,\s+is cancelled first/,
      /`journal_read \{kind:"order_placed"\}`, kind\s+only, no `contractId` filter/,
      // The next cycle cancels an unbracketed working entry instead of keeping it as its own pending entry.
      /Keep only\s+a pending entry from your own plan that carries its stop bracket\./],
    'skills/manage-position/SKILL.md': [/an entry order on the position's side \(one that would add to it\) still working without a stop bracket \(one the gate never checked, e\.g\. placed outside the harness; tell by its `order_placed` record, as for a flat account below\) is cancelled first/,
      /The position's own stop and target \(bracket legs, `\[protect\]` and `\[exit\]` orders, on the opposite side\) are never cancelled here/],
    'agents/trade-executor.md': [/Check the entry's status once/, /Working, with its stop bracket[^]*?report `EXECUTED` with the entry working, its order id, and that its\s+stop bracket is attached/, /Never wait or poll for a fill/,
      /every entry carries its stop as its\s+bracket, `stopLossBracket \{ticks, type: "stop"\}` \(the gate refuses an\s+entry without one, a check autonomous runs can't skip; always send it\)/,
      /\*\*Refused\*\*: a reply with `success: false` and an `errorCode`[^]*?Never send the\s+entry again without its bracket, and never enter without it to place\s+a stop afterwards; the caller reports the message to the user/,
      /\*\*Any other error\*\*[^]*?the outcome is unknown, not a refusal\. Read\s+`list_open_positions` and `list_open_orders` at once[^]*?`\[protect\]` stop, or\s+`close_position`, before anything else\. Never send the entry again/,
      /\*\*Flat, no working entry\*\* \(the reply was a success with an order id[^]*?report `ABORTED`\s+with the broker's message\. The caller journals a review for it:\s+`result:nofill`\s+only\s+when\s+nothing\s+shows\s+the\s+order\s+filled/,
      /\*\*Filled\*\*: verify with `list_open_orders` that the protective stop is\s+working\. If it isn't \(missing or cancelled\), place it as a `\[protect\]`\s+stop; if it can't be placed, `close_position` immediately/],
    'skills/autonomous-trading/SKILL.md': [/Never wait\s+within a cycle/, /\*\*Read once per cycle\.\*\* For each symbol, each\s+role/, /A full cycle still runs its analysts in parallel/, /lacks `remainingBeforeLimit` \(and, without a prop attempt,\s+today's P&L\): a cycle that may enter reads `get_account_snapshot` once/, /gives only a count of working orders, the\s+trend rule, and no scan details: read `list_open_orders` once; take the\s+alignment from the bar briefing/, /\(you, each analyst, each call of a role; a role you play yourself\s+counts as that role\)/, /Anything under "Context unavailable", read\s+once yourself/, /A trade review's\s+`get_bars` over a trade's hold is one read per trade reviewed/, /Read the account and open orders once after each `place_order`,\s+`modify_order`, `cancel_order`, `close_position`, or\s+`partial_close_position`, including one that failed or timed out/, /before an order call unless you read them after\s+your last one/, /A failed read may be retried once/, /Never resend an order call blindly: after a failed or timed-out\s+one, read `list_open_orders` and `get_account_snapshot`, and send it\s+again only if they show it didn't go through and it is still needed \(a\s+close or a `\[protect\]` stop always is\)/, /journalled as working and the cycle\s+ends/, /as plain text in your final message: never as a tool call/,
      // The refused or errored entry is trade-session step 6's (pinned there): here a pointer (autonomous-trading split).
      /A refused entry, or one whose\s+reply was an error, is handled as trade-session step 6 says \(a refusal\s+ends the cycle `blocked`\), and confirm it yourself: read positions and\s+orders, and fix any position without a working stop first\./],
    'skills/end-of-day/SKILL.md': [/a position still\s+open after its close is closed again/, /Don't wait\s+for a close to fill/, /unless its earlier close still shows\s+as a working order in `list_open_orders`: a market order on the opposite\s+side, sized to the position \(a stop or limit is not one/,
      /cancels every working order once that\s+contract reads flat/, /runner keeps\s+closing until it reads flat \(interactively, close again and tell the user/],
    'rules/trading/risk-management.md': [/as soon as the\s+fill shows \(the order's\s+one status check, or the next cycle's read\)/, /without a stop bracket \(one the gate never checked, e\.g\. placed outside\s+the harness\) is cancelled, not waited on/,
      /A separate `\[protect\]` stop\s+only repairs protection on an existing position[^]*?never a way to\s+enter without a bracket/],
    'rules/trading/execution.md': [/Every entry carries `stopLossBracket` \(and `takeProfitBracket` when it has\s+a target\), in whole ticks from the fill\. A broker that can't attach them\s+refuses the entry: never enter without them; report the broker's message\./],
  };
  for (const [rel, wants] of Object.entries(docs)) {
    const text = read(rel);
    for (const want of wants) assert.match(text, want, `${rel}: ${want}`);
  }
  // No doc still has the executor wait for the fill to show before protecting it.
  assert.doesNotMatch(read('agents/trade-executor.md'), /as soon as\s+`list_open_positions` shows the fill/);
  assert.doesNotMatch(read('skills/order-mechanics/SKILL.md'), /stop once `list_open_positions` shows the fill/);
  // The gate counts a placed entry until a review (result:nofill counts) names it: what the docs tell the model to journal.
  assert.match(read('scripts/lib/trading/order-gate.js'), /hasTag\(e, 'result:nofill'\)/);
  // The generated copies carry it too (node scripts/sync-harness.js).
  assert.match(read('qwen-extension/agents/trade-executor.md'), /Never wait or poll for a fill/);
  assert.match(read('workspace/AGENTS.md'), /placed outside\s+the harness\) is cancelled, not waited on/);
  // No canonical doc an agent acts on still teaches entering without brackets and protecting after the fill.
  // A platform's bracket settings (accounts/ is outside the platform-name scan) are spelled in pieces so this
  // file names no platform term (tests/plugin/no-platform-specifics.test.js).
  const PLATFORM_BRACKETS = [['Auto', 'OCO'], ['Position', 'Brackets']].map(w => w.join('\\s+')).join('|');
  const FALLBACK = new RegExp(`${/without brackets|brackets are rejected|rejects brackets|bracket rejected|brackets rejected|enter without (?:them|brackets)[^.]*?\[protect\]|if the one status\s+check \(step 5\) shows the fill|when the account supports brackets|the `\[protect\]` stop you place after the\s+fill|or `stop <price>` in the rationale|setup tag first, numeric stop|whatever the\s+wording/.source}|${PLATFORM_BRACKETS}`, 'i');
  for (const w of [['Auto', 'OCO'], ['Position', 'Brackets']]) assert.match(`turn on ${w.join(' ')} first`, FALLBACK, 'a platform\'s bracket setting is guarded, in accounts/ too');
  const actOn = ['agents', 'skills', 'rules/trading', 'commands', 'strategies', 'accounts'].flatMap(d => fs.readdirSync(path.join(ROOT, d), { recursive: true })
    .filter(f => String(f).endsWith('.md')).map(f => path.join(d, String(f))));
  // A refusal excludes codes 6 (OrderPending) and 7 (UnknownError): the gateway reads them as unknown outcomes (order-markers.js).
  const EXCLUDES = /`success: false`\s+(?:and|with)\s+an\s+`errorCode`\s+other\s+than\s+6\s+\(`OrderPending`\)\s+or\s+7\s+\(`UnknownError`\)/;
  const BARE_REFUSAL = /`success: false`\s+(?:and|with)\s+an\s+`errorCode`(?!\s+other\s+than\s+6\s+\(`OrderPending`\)\s+or\s+7\s+\(`UnknownError`\))/;
  for (const rel of ['agents/trade-executor.md', 'skills/order-mechanics/SKILL.md', 'skills/broker-refusals/SKILL.md', 'skills/entry-outcome/SKILL.md', 'rules/trading/execution.md']) {
    assert.match(read(rel), EXCLUDES, rel);
    assert.doesNotMatch(read(rel), BARE_REFUSAL, rel);
  }
  // autonomous-trading points to trade-session step 6 for it (its split): no bare refusal comes back there.
  assert.doesNotMatch(read('skills/autonomous-trading/SKILL.md'), BARE_REFUSAL);
  // A flat entry after a successful reply is a nofill only when nothing shows it filled; unknown yet, no review.
  for (const rel of ['agents/trade-executor.md', 'skills/order-mechanics/SKILL.md', 'skills/entry-outcome/SKILL.md']) {
    assert.match(read(rel), /`result:nofill`\s+only\s+when\s+nothing\s+shows\s+the\s+order\s+filled\.\s+If\s+the\s+reply\s+or\s+the\s+broker's\s+message\s+says\s+a\s+position\s+was\s+opened\s+or\s+closed,\s+or\s+`search_trades`\s+shows\s+any\s+fill\s+for\s+the\s+order[^]*?If\s+it\s+can't\s+be\s+told\s+yet[^]*?no\s+review\s+this\s+cycle/, rel);
  }
  const generated = ['workspace/AGENTS.md', 'workspace/QWEN.md', 'workspace/opencode.json', 'qwen-extension/QWEN.md', 'qwen-extension/agents/trade-executor.md', '.codex/agents/trade-executor.toml'];
  for (const rel of [...actOn, 'docs/BROKER-MCP-INTERFACE.md', 'docs/HARNESS-DESIGN.md', 'README.md', ...generated]) {
    // opencode.json carries the prompts as JSON strings: their newlines are \n.
    assert.doesNotMatch(read(rel).replace(/\\n/g, '\n'), FALLBACK, rel);
  }
});

test('the skills say an autonomous entry waits for its roles, and what the plan takes from each', () => {
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  // trade-session's step 2 roles, its lean cycle and its step 4 plan are skills of their own (trade-session-split.test.js).
  const ts = ['role-round', 'lean-cycle', 'trade-plan'].map(s => read(`skills/${s}/SKILL.md`)).join('\n');
  for (const re of [
    /Every other role runs every full cycle: each carries skills the decision needs/,
    /\*\*Cached reports\.\*\*[^]*?in a one-symbol cycle, an analyst's report while the bar briefing\s+parts it was built on are current \(until the next 15m close\); `risk-manager`\s+phase 1 while the account is unchanged[^]*?Don't launch a role whose report the prompt gives[^]*?Phase 2 reviews this bar's plan and\s+is never cached\. Cached reports count for the cycle's first entry only: after a\s+`trade-executor` call, the next entry needs every role again, and where the\s+harness refuses a cached role's launch \(opencode\) that is the next cycle: a\s+`trade-executor` call ends this cycle's entries\./,
    /gate refuses an entry \(`\[roles-ran\]`\) until `market-structure-analyst`,\s+`trend-momentum-analyst`, `volume-liquidity-analyst` and `risk-manager` have\s+returned as subagents this cycle or were given under "Cached reports",\s+`risk-manager` twice \(phase 1, then phase 2 once phase 1 and the analysts\s+that ran have returned; phase 2 alone when phase 1 was cached\), each in the foreground/,
    /since the last `trade-executor` call:\s+each entry has its own round of reports/,
    /the refused `trade-executor` call itself ends the round, so\s+report the block and end the cycle \(step 6\)/,
    /in an autonomous\s+run there is no stand-in: without the roles' reports, no entry/,
    /until\s+`risk-manager` has returned twice this cycle \(phase 1 and phase 2\)/,
    /structure bias and the level the entry and stop sit against/, /the VWAP side, the value area or POC, the nearest\s+liquidity in the trade's way \(`inTheWay`, the compose record's or a\s+candidate's: the first level in its direction in points and R, where 1R is\s+its own stop/,
    /multi-timeframe alignment for the side \(aligned, pullback, mixed, counter\)\s+and the size it implies/, /A plan\s+that can't name them isn't ready/,
  ]) assert.match(ts, re);
  assert.match(read('skills/gate-refusals-cycle/SKILL.md'), /\| `\[roles-ran\] … not returned yet: <roles>` \|[^\n]*End the cycle \(trade-session step 6\): the refused `trade-executor` call ends the round/);
});

test('the roles start from the bar briefing, reuse it, and say which versions they used', () => {
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const a of ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst']) {
    const t = read(`agents/${a}.md`);
    assert.match(t, /^tools: .*mcp__harness__bar_briefing/m, a);
    assert.match(t, /Start from the bar briefing: `bar_briefing \{"symbol": "<SYMBOL>"\}`[^]*?don't run\s+`market_snapshot`, `mtf_read`, `strategies_scan` or `bars_fetch` for what it\s+already holds/, a);
    assert.match(t, /```text\n## [^\n]*\nData: bar_briefing m3@<\.\.\.>, m15@<\.\.\.>, h1@<\.\.\.>, day@<\.\.\.> \(the versions you used\)/, a);
  }
  assert.match(read('skills/setup-judgment/SKILL.md'), /\*\*Read each setup's facts first\*\*[^]*?They are context, not a verdict: judge by\s+the side rule \(`htf-to-ltf`\) and its alignment table[^]*?A valid setup on that side\s+\(`confluence-counting`\) is the trade this harness looks for, when\s+it isn't `blocked`[^]*?The priority order decides: a policy strategy's verdict\s+too\./);
  assert.match(read('skills/strategy-library/SKILL.md'), /### The priority order: the rule for every setup[^]*?A\s+verdict\s+is\s+a\s+ceiling\s+on\s+size,\s+never\s+an\s+order\.\s+A\s+valid\s+setup\s+is\s+the\s+trade\s+\(`confluence-counting`\)\.[^]*?1\. \*\*Hard stops → no trade\*\*[^]*?2\. \*\*The trend rule\*\*[^]*?3\. \*\*Room\*\*[^]*?4\. \*\*The multi-timeframe read for its side\*\*[^]*?`mixed` → half[^]*?5\. \*\*The strategy's own context filter and skip rules\*\*[^]*?6\. \*\*Confluence\*\*[^]*?7\. \*\*Secondary context\*\*[^]*?cuts to half, never vetoes alone\./);
  for (const f of [...TRADE_SESSION_SPLIT, 'skills/prop-challenge-pacing/SKILL.md', 'skills/multi-timeframe-analysis/SKILL.md', 'skills/htf-to-ltf/SKILL.md', 'skills/daily-bias/SKILL.md', 'agents/risk-manager.md', 'strategies/prop_portfolio/STRATEGY.md']) {
    assert.doesNotMatch(read(f), /Place exactly the verdict|the facts never\s+change it|doesn't halve the verdict|is already sized: don't halve it|Never argue with\s+it/, f);
  }
  assert.match(read('agents/risk-manager.md'), /Judge every setup, a policy verdict too, by the priority order \(the\s+strategy-library skill, "The priority order"\)/);
  assert.match(read('skills/prop-challenge-pacing/SKILL.md'), /\*\*A verdict is a ceiling, never an order\*\*/);
  // Interactive management (no runner) closes through the trade-executor too (it holds the order tools in every harness config).
  assert.match(read('skills/manage-position/SKILL.md'), /close at\s+market \(time stop\)\. Each stop move and close goes through the\s+trade-executor role, as all management does\./);
  // Step 6 has no exception: a conflict is no trade, a reversal too.
  assert.match(read('agents/risk-manager.md'), /`confluence\.against`\):\s+its step 6\./);
  assert.match(read('skills/setup-judgment/SKILL.md'), /firing both sides \(`confluence\.against`\):\s+stand aside \(priority step 6: no exception\)\./);
  assert.match(read('agents/risk-manager.md'), /The briefing's `m3`\s+`candidates` give each setup's facts[^]*?context for the checks below, never a check of their own\./);
  for (const f of ['agents/risk-manager.md', ...TRADE_SESSION_SPLIT, 'skills/multi-timeframe-analysis/SKILL.md', 'skills/htf-to-ltf/SKILL.md', 'skills/daily-bias/SKILL.md', 'skills/tool-arguments/SKILL.md', 'skills/strategy-tools/SKILL.md', 'skills/bar-briefing/SKILL.md', 'skills/strategy-library/SKILL.md', 'skills/order-plan/SKILL.md', 'skills/reason-check/SKILL.md']) assert.doesNotMatch(read(f), /\bgrade [ABC]\b|`grade`/, f);
  const rm = read('agents/risk-manager.md');
  assert.match(rm, /the priority order's step 2 \(the gate refuses an entry against it\s+anyway, a composed one with step 2's CHoCH tier excepted\)/);
  assert.match(rm, /within the verdict for a policy strategy; the priority order's size\./);
  assert.match(read('skills/strategy-library/SKILL.md'), /Halvings don't compound: however many\s+steps halve, the size is halved once\./);
  // The example's short against the trend is the priority order's step 2 (crt_1h retired; D2 for a composed one).
  assert.match(read('skills/multi-timeframe-analysis/SKILL.md'), /a composed\s+short needs a 1h CHoCH down and a 4h rejection \(`trade-lifecycle`\)\./);
  assert.match(rm, /`m3` `candidates` is `null` \(the scan failed or the bar wasn't\s+scanned\): VETO a rules strategy/);
  assert.match(read('skills/htf-to-ltf/SKILL.md'), /\| `mixed` \|[^\n]*Priority step 4 sets the size/);
  assert.match(read('skills/strategy-library/SKILL.md'), /Wherever a step halves, half is `floor\(size \/ 2\)`, and 0 means no trade \(so\s+at size 1 every halving is a skip\)\./);
  assert.match(read('skills/strategy-library/SKILL.md'), /`pullback` → no trade until the trigger timeframe turns back with the\s+bias \(a shift, a reclaim\), then full; `mixed` → half;/);
  assert.match(read('skills/strategy-library/SKILL.md'), /fade it only at a higher-timeframe level, at half size and the nearest\s+target; a composed one needs `trade-lifecycle`'s tier: vs a 15m trend a\s+15m or 1h CHoCH; vs 1h a 1h CHoCH; vs 4h a 1h CHoCH plus a 4h rejection\./);
  for (const a of ['trend-momentum-analyst', 'volume-liquidity-analyst']) assert.match(read(`agents/${a}.md`), /\nBias: long \| short \| neutral \(confidence: low \| medium \| high\)\n/, a);
  assert.match(rm, /^tools: .*mcp__harness__bar_briefing/m);
  assert.match(rm, /The market facts come from the bar briefing[^]*?don't fetch bars or run\s+`strategies_scan`, `market_snapshot` or `mtf_read` again for what they hold/);
  const ts = read('skills/trade-session/SKILL.md');
  assert.match(ts, /\*\*Every cycle, first:\*\* the bar briefing \(`bar_briefing \{"symbol": "<SYMBOL>"\}`/);
  assert.match(ts, /Read it once per role and reuse it: no role re-runs\s+`market_snapshot`, `mtf_read` or `strategies_scan` for what it holds/);
  assert.match(read('skills/role-round/SKILL.md'), /Each report opens with a `Data:` line: the briefing versions it used, or,\s+without a current briefing, the tools it called\. A report with no `Data:`\s+line, or naming another bar's `m3` version while this bar's briefing is\s+current, didn't read this bar: run that analyst again once; if it still\s+doesn't, stand aside\. An old briefing \(the tool says so\) counts as none/);
  assert.match(read('skills/timeframe-sources/SKILL.md'), /The briefing's fields per timeframe and the `mtf_read` calls: the `bar-briefing`\s+skill \(use a current briefing; `mtf_read`[^)]*only for what it lacks:\s[^]*?`mtf_read` json's\)/);
  assert.match(read('skills/htf-to-ltf/SKILL.md'), /The alignment and the trend rule in a trade plan are the briefing's \(intraday\s+frames\); a daily read, if you have one \(premarket's\), is context only, never a\s+second alignment/);
  assert.match(read('skills/autonomous-trading/SKILL.md'), /The bar briefing \(`bar_briefing`\) is the\s+runner's file for this bar: read it once per role and reuse it \(it doesn't\s+change during the cycle\)/);
  const ht = read('skills/bar-briefing/SKILL.md');
  // The briefing's m3 cisd (briefing.js cisdBlock), after the trend rule as m3 builds it; a frame points to it.
  assert.match(ht, /`location`, `candidates` \(a rules strategy's setups[^]*?\), `trendRule`, `cisd` \(the latest CISD per timeframe, 3m, 5m, 15m and 1h, on completed candles:[^)]*; a read, not a signal\), `candles` \(per timeframe,[^]*?`swingTargets` \([^)]*\)\. `m15`/);
  assert.match(ht, /with a pointer to the runner's `candles`, `swingTargets` and `cisd`/);
  assert.match(ht, /\| `bar_briefing` \| `symbol` \(a root, or a contract by month\), `timeframe`\?, `json`\? \| the bar briefing the autonomous runner built for the bar this cycle decides, opening with a plain-language summary \(price and 1R, trend rule, alignment, regime, VWAP, news, the room above and below, a line per timeframe for its last completed candle, the next swing targets, the latest CISD per timeframe, the rules setups, the setups to check\), times in ET, distances in points and R \(1R is a setup's own stop, else the reference stop, 0\.5 x ATR\(20\)/);
  assert.match(ht, /`candidates` \(a rules strategy's setups, none active: each with its stop, exit, room and `facts`; `null`: not scanned; `blocked`: a no-entry window, a news blackout or the news unknown\)/);
  assert.match(ht, /`day`, until the first bar after 16:00 ET: the prior RTH day and its profile\. Each part has a version and changes only on expiry/);
  assert.match(ht, /When it answers that there is no current briefing, or that it is old, read the bars yourself/);
  assert.match(read('agents/risk-manager.md'), /When the briefing\s+answers that there is no current one, take the candidates, the trend rule\s+and the alignment from the plan the caller gives you and the analysts'\s+reports instead; don't fetch bars for them\./);
  assert.match(read('agents/market-structure-analyst.md'), /the latest BOS or CHoCH with how many candles ago \(the\s+briefing's `lastBreak` in `m3`, `m15` and `h1`: computed from confirmed\s+swings, never by eye\)/);
  assert.match(read('agents/volume-liquidity-analyst.md'), /recent sweeps \(the briefing's `m3` `sweeps`/);
  // Codex can't take Read away (its sandbox reads files): a role without Read is told not to read files.
  // Its core skills, then its index (role-index), all readable.
  assert.match(read('.codex/agents/market-structure-analyst.toml'), /Do not read files \(no shell reads either\), except your skills \(skills\/multi-timeframe-analysis\/SKILL\.md, [^)]*skills\/tool-arguments\/SKILL\.md[^)]*skills\/fair-value-gaps\/SKILL\.md[^)]* under the harness root\): take bars and market data only through the tools above\./);
  assert.match(read('.codex/agents/trade-executor.toml'), /except your skills \(skills\/broker-mcp\/SKILL\.md, skills\/order-types\/SKILL\.md, skills\/order-mechanics\/SKILL\.md, skills\/order-failures\/SKILL\.md, skills\/order-rationale\/SKILL\.md, skills\/trade-journal\/SKILL\.md, skills\/gate-refusals\/SKILL\.md, skills\/gate-refusals-positions\/SKILL\.md, skills\/broker-refusals\/SKILL\.md under the harness root\)/, 'the executor can still load its skills');
  assert.doesNotMatch(read('.codex/agents/risk-manager.toml'), /Do not read files/, 'a role that has Read may');
  // The analysts read bars only through the harness tools: no raw file reads, no raw get_bars dumps.
  for (const a of ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst']) {
    const tools = /^tools: (.*)$/m.exec(read(`agents/${a}.md`))[1].split(',').map(t => t.trim());
    assert.ok(!tools.includes('Read') && !tools.includes('mcp__broker__get_bars'), a);
  }
});

test('the session hours read unambiguously (a small local model read "18:00 ET to 16:00 ET" as "opens at 18:00"), and a role is never a reader', () => {
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  assert.match(read('rules/trading/execution.md'), /opens at 18:00 ET\s+and runs overnight until 16:00 ET the next day[^]*?the regular session\s+09:30-16:00 ET included; it is closed only from 16:00 to 18:00 ET and on\s+weekends/);
  assert.match(read('skills/session-timing/SKILL.md'), /a time\s+like 10:00 ET is inside the session, not before it, and so is 08:00 ET \(the\s+18:00 ET open\s+was the evening before; 09:30 ET is only the RTH cash open\)/);
  // Replays read "opening drive" as the no-entry opening print and invented its end: the skill says which windows
  // forbid entries, that the opening drive allows them, and to take a window's end from the briefing.
  assert.match(read('skills/session-timing/SKILL.md'), /By default only three windows forbid entries by the clock: the opening\s+print \(09:30-09:35\), into the close \(15:45-16:00\), and the daily break\s+\(16:00-18:00, the market closed\)\. The opening drive is not the opening\s+print: from 09:35 entries are allowed\. The gate's configured windows apply\s+in their place/);
  assert.match(read('skills/session-timing/SKILL.md'), /Take\s+a window's end from it; never infer one/);
  // The owner's rule: the prop firm's trading day, not CME's.
  assert.match(read('skills/session-timing/SKILL.md'), /The harness follows the\s+prop firm's trading day, not CME's: it starts at 18:00 ET \(the firm's\s+daily reset\), and the harness trades it until 16:00 ET the next day[^]*?stopping before\s+the firm's own flatten deadline, which comes after 16:00 ET/);
  assert.match(read('workspace/AGENTS.md'), /runs overnight until 16:00 ET the next day/, 'the generated operator instructions carry it');
  assert.match(require('../../scripts/lib/trading/clock').MARKET_HOURS_LABEL, /^the harness's hours inside the Topstep trading day \(17:00 CT reset\): from 18:00 ET until 16:00 ET the next day[^]*09:30-16:00 ET included; closed only 16:00-18:00 ET and weekends; Topstep's own flatten is 16:10 ET$/);
  assert.match(read('skills/role-round/SKILL.md'), /A role's call is that\s+role's own analysis \(the order gate counts it as its report\): never ask a role\s+to read, load or summarize skills or files for you; load skills yourself \(your\s+skill tool; none: skill_lookup or `SKILL\.md`\)\./);
  assert.match(read('workspace/AGENTS.md'), /load the skill you need yourself \(your skill tool; without one,\s+the `skill_lookup` tool or `<root>\/skills\/<name>\/SKILL\.md`\), never through a\s+role/);
  assert.match(read('skills/strategy-authoring/SKILL.md'), /the whole market session, from 18:00 ET until 16:00 ET the next day \(closed only 16:00-18:00 ET/);
  assert.match(read('skills/premarket/SKILL.md'), /^description: .*Use at the start of the trading day \(just after the 18:00 ET open\)/m);
  for (const f of ['rules/trading/execution.md', 'rules/trading/prop-firm.md', 'skills/session-timing/SKILL.md', 'skills/news-blackouts/SKILL.md', 'skills/exchange-holidays/SKILL.md', 'skills/contract-roll/SKILL.md', 'skills/autonomous-trading/SKILL.md', 'skills/strategy-authoring/SKILL.md', 'skills/strategy-rules/SKILL.md', 'skills/strategy-backtest/SKILL.md', 'strategies/_template/STRATEGY.md']) {
    assert.doesNotMatch(read(f), /18:00 ET to 16:00 ET|18:00-16:00 ET session/, f);
  }
});

test('the prop policy is active (live and replay), and the replay skill says a paper policy with an attempt refuses every entry', () => {
  const { loadStrategies, RETIRED } = require('../../scripts/lib/trading/strategies');
  const { strategies } = loadStrategies(ROOT, {});
  const p = strategies.find(s => s.name === 'prop_portfolio');
  assert.ok(p && p.valid && p.status === 'active', 'prop_portfolio');
  // prop_flow_1m retired on 2026-10-14 (its components went). The prop-challenge-pacing skill still names it as an
  // active policy: skills are kept as they are by the owner's decision, so that sentence is no longer checked here.
  assert.ok(!strategies.some(s => s.name === 'prop_flow_1m') && Object.hasOwn(RETIRED, 'prop_flow_1m'));
  const r = fs.readFileSync(path.join(ROOT, 'skills/replay/SKILL.md'), 'utf8');
  assert.match(r, /The policy strategy must be `active` \(`prop_portfolio` is\)[^]*?so with a `paper` policy every entry is refused\.\s+The policy strategy sizes each setup by its `sizing` rules: full within\s+the budget, or skip\./);
});

test('the order-flow activation says what holds: one runner per broker account, value_area\'s expansion branch, the fast backtest\'s blind spot', () => {
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  // The gate holds one cushion and one position per account within one runner only: no claim of more.
  for (const f of ['skills/prop-challenge-pacing/SKILL.md', 'strategies/README.md']) {
    const t = read(f).replace(/\s+/g, ' ');
    assert.match(t, /Within one runner \(one harness home\) the gate holds one cushion and one position at a time across the account/, f);
    assert.match(t, /second runner on the same broker account must not be started|never start a second runner on the same broker account/, f);
    // The account lock (account-lock.js) is built: the skill says it refuses a second runner; the README still says coming.
    assert.match(t, f.startsWith('skills/') ? /the account lock refuses one/ : /a per-account lock is coming/, f);
  }
  // Without flow the flow conditions are false; value_area can still confirm by range expansion.
  for (const f of ['docs/OPERATING.md', 'docs/ORDER-FLOW.md', 'docs/HARNESS-DESIGN.md']) {
    const t = read(f).replace(/\s+/g, ' ');
    assert.match(t, /`value_area` can (still )?confirm (only )?(through its range-expansion branch|through its other branch|by range expansion)/, f);
    assert.doesNotMatch(t, /`value_area` strategies read them with the rules' `field\("path"\)`; a bar without them gives no signal/, f);
  }
  const bt = read('docs/BACKTESTING.md').replace(/\s+/g, ' ');
  // The backtester's prop runs are retired (docs/research/mechanical-prop-backtester.md): no doc example runs one.
  assert.match(bt, /### Prop challenges \(retired\)/);
  assert.doesNotMatch(bt, /backtest\.js [^`\n]*--prop/);
  assert.match(bt, /a walk-forward run only logs it\./);
  assert.doesNotMatch(bt, /promotion runs included/);
});

test('the trained PPO policy is retired: no instruction file points to its trainer, bundles, or skill', () => {
  const walk = d => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = ['skills', 'agents', 'commands', 'rules', 'strategies', 'accounts'].flatMap(walk).filter(f => f.endsWith('.md'))
    .concat(['CLAUDE.md', 'README.md', 'workspace/AGENTS.md']);
  const retired = /policy: \{ bundle|policy bundle|rl\/ship\.py|rl\/configs|train-policy|policy-training|RL-DESIGN|rl-dataset|rl-env-server|scripts\/lib\/rl\/|models\/<|FTH_MODELS_DIRS|FTH_PYTHON/;
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), retired, f);
  for (const gone of ['rl', 'models', 'skills/policy-training', 'commands/train-policy.md', 'docs/RL-DESIGN.md', 'scripts/lib/rl']) {
    assert.ok(!fs.existsSync(path.join(ROOT, gone)), `${gone} is retired`);
  }
});

test('the priority order is written once, in strategy-library, and every role that decides has it', () => {
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const sl = read('skills/strategy-library/SKILL.md');
  assert.match(sl, /### The priority order: the rule for every setup/);
  // Its rule text appears nowhere else: the other skills and agents point to it.
  const RULE = [/`mixed` → half/, /floor\(size \/ 2\)/, /\*\*Hard stops → no trade\*\*/, /\*\*Secondary context\*\*/, /The priority order: the rule for every setup/, /trade-session(\s+skill's)?\s+priority\s+order/, /half\s+size\s+and\s+the\s+nearest\s+target/, /never\s+twice/, /step\s+2\W+sizes/];
  const dir = (d, pick) => (fs.existsSync(path.join(ROOT, d)) ? fs.readdirSync(path.join(ROOT, d)).map(pick).filter(Boolean) : []);
  const docs = [...dir('skills', d => `skills/${d}/SKILL.md`), ...dir('agents', f => `agents/${f}`), ...dir('rules/trading', f => `rules/trading/${f}`),
    ...dir('strategies', d => `strategies/${d}/STRATEGY.md`), ...dir('commands', f => (f.endsWith('.md') ? `commands/${f}` : null)), ...dir('docs', f => (f.endsWith('.md') ? `docs/${f}` : null))]
    .filter(f => f !== 'skills/strategy-library/SKILL.md' && fs.existsSync(path.join(ROOT, f)));
  for (const f of docs) for (const re of RULE) assert.doesNotMatch(read(f), re, `${f} restates the priority order (${re}): point to strategy-library instead`);
  // Who decides has it: trade-session names it (a rules entry loads strategy-library); the roles that judge a setup carry
  // it. A trade_lifecycle entry is sized by the model under the caps: no priority order halves it (the owner's D1).
  assert.match(read('skills/trade-session/SKILL.md'), /The priority order\*\* \(the `strategy-library` skill, "The priority order"\)/);
  assert.match(require('../../scripts/lib/autotrader').prompts(require('../../scripts/lib/autotrader').validateConfig({}), new Date('2026-10-07T14:30:00Z')).trade([{ symbol: 'MNQ', bar: { t: '2026-10-07T14:27:00Z', c: 1, file: '/b.json', contractId: 'MNQ' } }]), /multi-timeframe-analysis, and trade-lifecycle \(the order gate refuses an entry without them\); also load htf-to-ltf, confluence-counting, setup-judgment, and trade-plan before deciding/);
  for (const role of ['risk-manager', 'market-structure-analyst', 'trend-momentum-analyst']) {
    // Its core (role-skills): never only in its index (role-index).
    assert.match(read(`agents/${role}.md`), /^role-skills: \[[^\]]*\bstrategy-library\b/m, role);
  }
  // And opencode's generated roles carry it in full in their prompts.
  const oc = JSON.parse(read('workspace/opencode.json'));
  assert.match(oc.agent['risk-manager'].prompt, /### The priority order: the rule for every setup[^]*?7\. \*\*Secondary context\*\*/);
});

test('fact-checked reasons: the risk manager and the head trader check every reason with reason_check before they decide, in every adapter', () => {
  // Line breaks fall differently in each document: compare with the whitespace collapsed.
  const flat = text => text.replace(/\s+/g, ' ');
  const step = /\*\*Check every reason against the facts\*\* before you [^]*?`reason_check \{"symbol": "<SYMBOL>", "reasons": "<your (?:VERDICT|CYCLE RESULT) line>(?:\\n<your FACTS line>)?"\}` once\. It checks each reason against the bar briefing \(the session window and whether it allows entries, the trend rule per side, the candidates and verdict, the first level ahead in R against the R it aims for, the multi-timeframe read for the side\) and the attempt line, and lists each setup's priority-order steps as the facts answer them: judge each step on its own[^]*?A reason marked FALSE: name it, drop it, and decide again from the facts\. Check UNCHECKED and UNPARSED reasons yourself[^.]*?; they aren't false for that alone\./;
  // Only a FALSE reason is dropped: a true one the checker can't read (UNPARSED) stays.
  for (const doc of ['agents/risk-manager.md', ...TRADE_SESSION_SPLIT, 'skills/autonomous-trading/SKILL.md']) assert.doesNotMatch(flat(read(doc)), /no fact supports/, doc);
  const rm = read('agents/risk-manager.md');
  assert.match(rm, /^tools: .*mcp__harness__reason_check/m);
  // The risk manager states the call and its FACTS line; what reason_check checks and what to do with each result are the
  // reason-check skill's (in its core): one copy, not two.
  assert.match(flat(rm), /\*\*Check every reason against the facts\*\* before you approve or veto [^]*?`reason_check \{"symbol": "<SYMBOL>", "reasons": "<your VERDICT line>\\n<your FACTS line>"\}` once \(what it checks, and what to do with each result: the `reason-check` skill\); judge each priority-order step it lists on its own, not only the final call\./);
  assert.match(flat(rm), /it checks each FACTS claim as the order gate will, and a FACTS claim marked FALSE is a reason marked FALSE\./);
  assert.doesNotMatch(flat(rm), /Check UNCHECKED and UNPARSED|A reason marked FALSE: name it/, 'the handling is reason-check\'s, once');
  assert.match(read('agents/risk-manager.md'), /^role-skills: \[[^\]]*\breason-check\b/m);
  assert.match(flat(read('skills/reason-check/SKILL.md')), /A reason marked FALSE: name it, drop it, and decide again from the facts\. Check UNCHECKED and UNPARSED reasons yourself against the briefing; they aren't false for that alone\. Without a current briefing, check them against the plan and the reports\. In an autonomous cycle the order gate checks phase 2's FACTS line itself \(`\[phase2-facts\]`\)\./);
  // After the checks, before the verdict line; the checks and the gate unchanged.
  assert.ok(rm.indexOf('8. The analysts\' red flags') < rm.indexOf('**Check every reason') && rm.indexOf('**Check every reason') < rm.indexOf('Output exactly one of:'));
  assert.match(rm, /\(after\s+the checks above; they and the order gate's checks don't change\)/);
  // The head trader's step 3 checks are the setup-judgment skill (trade-session-split.test.js), which step 3 names.
  const sj = read('skills/setup-judgment/SKILL.md');
  assert.match(flat(sj), step);
  assert.match(flat(sj), /The order gate's checks still come first and don't change\./);
  // In step 3, before the no-trade note and the plan.
  const ts = read('skills/trade-session/SKILL.md');
  assert.ok(ts.indexOf('### 3. Head-trader synthesis') < ts.indexOf('the `setup-judgment`') && ts.indexOf('the `setup-judgment`') < ts.indexOf('an event within 15 minutes\n  → **no trade**'));
  assert.match(read('skills/autonomous-trading/SKILL.md'), /Check its reasons against the facts before you write it \(`reason_check`,\s+setup-judgment\): a reason marked FALSE is dropped and the decision\s+made again\./);
  assert.match(read('skills/reason-check/SKILL.md'), /\| `reason_check` \| `symbol`, `reasons` [^\n]*\| `reason-check\.js --symbol MNQ --reasons "<line>" \[--json\]` \|/);
  // Wired: Codex's and Qwen's risk manager, opencode's risk manager and head trader; no other role holds it.
  assert.match(read('.codex/agents/risk-manager.toml'), /harness MCP tools you may use: [^\n]*\breason_check\b/);
  assert.match(read('qwen-extension/agents/risk-manager.md'), /- mcp__harness__reason_check\n/);
  const oc = JSON.parse(read('workspace/opencode.json'));
  assert.strictEqual(oc.agent['risk-manager'].permission.harness_reason_check, 'allow');
  const head = Object.values(oc.agent).find(a => a.permission && a.permission['harness_*'] === 'allow' && a.mode === 'primary');
  assert.ok(head, 'the head trader holds every harness tool');
  for (const name of agents.filter(a => a !== 'risk-manager')) assert.notStrictEqual(oc.agent[name].permission.harness_reason_check, 'allow', name);
  assert.match(oc.agent['risk-manager'].prompt, /\*\*Check every reason against the facts\*\*/);
  // The head trader reads the skills from their files; the workspace instructions list the tool's skill.
  assert.match(read('workspace/AGENTS.md'), /`reason-check` \(skills\/reason-check\/SKILL\.md\): Use when checking stated reasons vs the facts\./);
});

test('fact-checked reasons: phase 2 states its FACTS in the forms the code checks (fact-claims.js), in every adapter', () => {
  const { parseClaim, checkFacts } = require('../../scripts/lib/trading/fact-claims');
  const flat = text => text.replace(/\s+/g, ' ');
  const rm = read('agents/risk-manager.md');
  const list = rm.slice(rm.indexOf('**State the facts your verdict rests on**'), rm.indexOf('**Check every reason'));
  assert.ok(list.length > 0, 'the FACTS forms come before the reason check');
  // Every concrete form the agent teaches parses as a claim (none is "unknown"), and every claim type is taught.
  const forms = [...list.matchAll(/^- `([^`]+)`/gm)].map(m => m[1]).concat([...list.matchAll(/, `((?:trend|room|window) [a-z ]+)`/g)].map(m => m[1]));
  const concrete = forms.filter(f => !/[<>]/.test(f));
  for (const f of concrete) assert.notStrictEqual(parseClaim(f).type, 'unknown', f);
  assert.deepStrictEqual([...new Set(concrete.map(f => parseClaim(f).type))].sort(), ['entries', 'news', 'read', 'room', 'tf', 'trend', 'value', 'vwap', 'window']);
  // The example's FACTS line is read whole.
  const example = /^FACTS: .*$/m.exec(rm.slice(rm.indexOf('Output exactly one of:')))[0];
  assert.ok(checkFacts(example, null).claims.every(c => c.type !== 'unknown'), example);
  assert.match(flat(rm), /The order gate refuses an entry approved on a fact the briefing contradicts or can't confirm \(write `unknown` instead\), on fewer than two facts the briefing checks, or on facts it can't check \(no current briefing: write `FACTS: none`\)\./);
  // The reason_check template carries the FACTS line, as the text says.
  assert.match(rm, /`reason_check \{"symbol": "<SYMBOL>", "reasons": "<your VERDICT line>\\n<your FACTS line>"\}`/);
  assert.match(flat(rm), /Always write at least two: start with the window and the trend rule for your side, e\.g\. `FACTS: window opening drive; trend long allowed`\./);
  // Synced: Codex's and Qwen's risk manager and opencode's carry it.
  for (const text of [read('.codex/agents/risk-manager.toml'), read('qwen-extension/agents/risk-manager.md'), JSON.parse(read('workspace/opencode.json')).agent['risk-manager'].prompt]) {
    assert.match(flat(text), /\*\*State the facts your verdict rests on\*\* in one `FACTS:` line/);
  }
  // The head trader hands the line on and reads the gate's refusal.
  assert.match(flat(read('skills/role-round/SKILL.md')), /checks the `FACTS:` line of the phase-2 report that approved the entry against the bar briefing \(`\[phase2-facts\]`\)/);
  assert.match(read('skills/gate-refusals-cycle/SKILL.md'), /\| `\[phase2-facts\] Risk-manager phase 2 approved on a fact the bar briefing contradicts: <fact>` \|/);
});

test('the reasons check example in reason-check has the form the check prints ("the <account> attempt is active")', () => {
  const line = read('skills/reason-check/SKILL.md').split('\n').find(l => l.includes('FALSE no-attempt'));
  const m = /- the (\S+) attempt is active$/.exec(line || '');
  assert.ok(m, line);
  // reasons.js prints `the ${account} attempt is active`: the example names an account the same way.
  assert.match(read('scripts/lib/trading/reasons.js'), /`the \$\{facts\.attempt\.account\} attempt is active`/);
  assert.match(m[1], /^[a-z0-9_]+$/, 'an account name, not a phrase');
});

test('the analysts report reads for or against the trend rule\'s side, never advice; the head trader loads the count every cycle in every harness', () => {
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const role of ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst']) {
    const t = read(`agents/${role}.md`);
    const out = t.slice(t.indexOf('## Output'));
    assert.match(out, /\nReads for <the trend rule's side>: <category: fact, level, number>; against: <same>\n```/, role);
    assert.doesNotMatch(out, /^(?:Red flags|Implication):/m, role);
    assert.ok(t.replace(/\s+/g, ' ').includes('Facts, never advice ("wait", "chase") or an R:R verdict.'), role);
  }
  // The count is in every cycle's load: the prompt's list (Claude Code, Qwen Code, Codex), opencode's head prompt (CORE),
  // and trade-session step 0; the rule itself in trade-session and trade-lifecycle, which the gate requires every entry.
  assert.ok(require('../../scripts/lib/head-prompt').CORE.includes('confluence-counting'));
  assert.match(read('skills/trade-session/SKILL.md'), /Load\s+`confluence-counting` every cycle too/);
  assert.match(read('skills/trade-session/SKILL.md'), /the trigger closed → `compose_check`, never your own R:R\.\s+OK → take: full, half on serious against, pass on a 1h CHoCH against\./);
  assert.match(read('skills/trade-lifecycle/SKILL.md'), /trend side, a reaction at a level, the trigger closed →\s+compose \(`confluence-counting`\); the plan, never you, works out R:R\./);
});

test('the count is of independent categories, never labels, and every restatement says the same (the owner\'s duplicated-evidence principle)', () => {
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const flat = t => t.replace(/\s+/g, ' ');
  const cc = flat(read('skills/confluence-counting/SKILL.md'));
  // The six categories, in order, each once; labels of one price move are one piece of evidence.
  assert.deepStrictEqual([...cc.matchAll(/\| (\w+) \| [^|]+ \|/g)].map(m => m[1]).filter(c => c !== 'Category'), ['structure', 'location', 'liquidity', 'trigger', 'participation', 'context']);
  // A valid setup is the trade (the owner, 2026-10-21): the categories describe the evidence; the against sets the size.
  for (const rule of ['**Compose first.**', 'the trigger closed → call `compose_check`.', 'Never estimate room or R:R: the briefing\'s "Standard plan" line states it',
    'refused → pass, naming it.', 'OK → **a valid setup is the trade**: full size within the verdict\'s ceiling; the against sets the size:',
    'never a reason not to compose', 'no pullback yet',
    '**Decisive** → pass: a real HTF reversal against the side (a 1h CHoCH against: the trend rule\'s tier, `trade-lifecycle`), or a hard step fails.', '**Serious** → half (`floor`, at least 1): 2+ categories against, location against',
    'or a 3m close beyond the leg\'s 15m swing (`m3.htfLevels` `brokenAt`). Closed back inside, it is a sweep (`breakout-vs-fakeout`): liquidity for.',
    '**Minor** → full size, never a reason not to compose: thin volume, the first level ahead, VWAP distance or "chasing"', 'A missing read is no reason to pass.',
    'reads of one price move are one piece of evidence.', 'mixed, none or `unknown` → neutral',
    'a 3m BOS, an EMA slope and ADX are one structure vote', 'the trend rule and the 1h and 4h direction (the side rule;',
    '**The pullback is neutral** (`pullback-vs-reversal`)']) assert.ok(cc.includes(rule), rule);
  // Each restatement: categories, the same threshold, and no against category a pass alone.
  const ts = flat(read('skills/trade-session/SKILL.md'));
  assert.ok(ts.includes('**Compose first** (`confluence-counting`): trend side, a reaction at a key level, the trigger closed → `compose_check`, never your own R:R. OK → take: full, half on serious against, pass on a 1h CHoCH against.'));
  assert.ok(flat(read('skills/trade-lifecycle/SKILL.md')).includes('trend side, a reaction at a level, the trigger closed → compose (`confluence-counting`); the plan, never you, works out R:R.'));
  const tp = flat(read('skills/trader-process/SKILL.md'));
  // take or pass first: the decision word the verdict parser reads (roles-ran.js: "take" agrees, a "valid" first word
  // read as a veto in a phase-2 report).
  assert.ok(tp.includes('8 Decision: <take|pass> - <full|half|the failed step>, <one main reason>'));
  const { verdictOf } = require('../../scripts/lib/trading/roles-ran');
  assert.strictEqual(verdictOf('8 Decision: take - full, compose_check OK\nVERDICT: APPROVE - size 1'), 'APPROVE');
  // The PLAN's R:R and target are the compose record's, never the model's estimate.
  assert.ok(tp.includes('7 Risk: stop <ticks>, target <R> (compose_check), size <n>, ahead <level R|none>') && tp.includes('R:R: the compose record\'s, never yours.'));
  assert.ok(flat(read('skills/strategy-library/SKILL.md')).includes("Hard: R:R to the target at least `risk.min_rr` (compose_check's)."));
  assert.ok(flat(read('rules/trading/risk-management.md')).includes('measured from the entry to the plan\'s target; `compose_check` computes and enforces it, never your estimate'));
  // No number for the model to apply by hand: the minimum is the strategy's, checked in code (a Sonnet replay passed on
  // "room 1.21R, below the 1.5R minimum" measured to the first level ahead).
  assert.ok(!/\b1\.5R\b/.test(read('rules/trading/risk-management.md')), 'no hand-applied R:R number in the always-on rule');
  assert.ok(flat(read('skills/htf-to-ltf/SKILL.md')).includes('in the count it is neutral.'));
  assert.ok(flat(read('skills/trader-process/SKILL.md')).includes('The six categories of `confluence-counting`.'));
  assert.ok(flat(read('agents/risk-manager.md')).includes('then (`confluence-counting`): compose OK (its R:R the record\'s, never an estimate) → APPROVE, full size, half on serious against; VETO only on a 1h CHoCH against the side or a failed hard step.'));
  assert.ok(flat(read('skills/setup-judgment/SKILL.md')).includes('A valid setup on that side (`confluence-counting`) is the trade'));
  for (const role of ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst']) {
    assert.ok(read(`agents/${role}.md`).includes("Reads for <the trend rule's side>: <category: fact, level, number>; against: <same>"), role);
  }
  // No restatement keeps the old label count.
  for (const f of ['skills/trade-session/SKILL.md', 'skills/trade-lifecycle/SKILL.md', 'skills/trader-process/SKILL.md', 'agents/risk-manager.md', 'skills/setup-judgment/SKILL.md']) {
    assert.doesNotMatch(read(f), /six items|item [1-6]\b|No against read is|for minus against|margin of/, f);
  }
});

test('the decision is an always-on rule (rules/trading/decision.md) every harness carries in context, so a head trader that skips its skills still has it', () => {
  const flat = text => text.replace(/\s+/g, ' ');
  const r = flat(read('rules/trading/decision.md'));
  for (const s of ['call `compose_check`', 'Never estimate room, R:R or the target yourself', 'a valid setup is the trade', 'never a reason not to compose']) assert.ok(r.includes(s), s);
  // Embedded where each harness reads it: AGENTS.md (Codex, opencode), QWEN.md (Qwen Code; Claude Code imports it).
  for (const f of ['workspace/AGENTS.md', 'workspace/QWEN.md']) assert.ok(flat(read(f)).includes('Never estimate room, R:R or the target yourself'), f);
  assert.match(read('workspace/CLAUDE.md'), /@QWEN\.md/);
});

test('compose first: the decision rule and every restatement send a setup to compose_check and never ask the model to work out room or R:R itself', () => {
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const flat = t => t.replace(/\s+/g, ' ');
  const FILES = ['skills/confluence-counting/SKILL.md', 'skills/trade-session/SKILL.md', 'skills/trade-lifecycle/SKILL.md', 'skills/trader-process/SKILL.md',
    'skills/setup-judgment/SKILL.md', 'skills/strategy-library/SKILL.md', 'agents/risk-manager.md', 'rules/trading/risk-management.md',
    'agents/market-structure-analyst.md', 'agents/trend-momentum-analyst.md', 'agents/volume-liquidity-analyst.md', 'skills/top-down-entry/SKILL.md', 'skills/trade-plan/SKILL.md'];
  // What made a model pass a with-trend setup on its own arithmetic (the 2021-07-12 replay): room or R:R checked, needed or
  // estimated by the model, to the first level ahead.
  const SELF = /check (?:that )?(?:there is )?(?:the )?room|room (?:it )?needs|(?:enough|insufficient|not enough) room|room to the (?:target|next)|(?:estimate|work out|compute|calculate)s? (?:the )?(?:room|R:R|target)(?! yourself: the plan)|R:R to the first level/i;
  for (const f of FILES) assert.doesNotMatch(flat(read(f)).replace(/never (?:estimate|your own|an estimate|you)[^.;]*/gi, ''), SELF, f);
  // Each restatement says the plan does it: compose_check, never the model's own estimate.
  const NEVER = {
    'skills/confluence-counting/SKILL.md': 'Never estimate room or R:R: the briefing\'s "Standard plan" line states it; OK → compose with its reads, refused → pass, naming it.',
    'skills/trade-session/SKILL.md': '→ `compose_check`, never your own R:R.',
    'skills/trade-lifecycle/SKILL.md': 'the plan, never you, works out R:R.',
    'skills/trader-process/SKILL.md': "R:R: the compose record's, never yours.",
    'skills/setup-judgment/SKILL.md': "the min R:R (compose_check's;",
    'skills/strategy-library/SKILL.md': "Hard: R:R to the target at least `risk.min_rr` (compose_check's).",
    'agents/risk-manager.md': "compose OK (its R:R the record's, never an estimate)",
    'rules/trading/decision.md': 'the briefing\'s "Standard plan" line states them, and the refusal is the R:R check.',
    'rules/trading/risk-management.md': "measured from the entry to the plan's target; `compose_check` computes and enforces it, never your estimate",
  };
  for (const [f, s] of Object.entries(NEVER)) assert.ok(flat(read(f)).includes(s), `${f}: ${s}`);
  // The minor reads the replay passed on are named as never a reason not to compose.
  assert.ok(flat(read('skills/confluence-counting/SKILL.md')).includes('**Minor** → full size, never a reason not to compose: thin volume, the first level ahead, VWAP distance or "chasing" (no edge in the census), no pullback yet, mixed reads.'));
  // Self-test: the old wording would fail.
  assert.match('with order_plan\'s stop, check there is room to the target', SELF);
  assert.match('only 1.17R ahead: estimate the R:R to the first level ahead', SELF);
});

test('decisive is a real HTF reversal (a 1h CHoCH against), never a 15m swing broken: that is serious (half), and closed back inside a sweep for the trend side', () => {
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const flat = t => t.replace(/\s+/g, ' ');
  const cc = flat(read('skills/confluence-counting/SKILL.md'));
  assert.ok(cc.includes('**Decisive** → pass: a real HTF reversal against the side (a 1h CHoCH against: the trend rule\'s tier, `trade-lifecycle`), or a hard step fails.'));
  assert.ok(cc.includes('or a 3m close beyond the leg\'s 15m swing (`m3.htfLevels` `brokenAt`). Closed back inside, it is a sweep (`breakout-vs-fakeout`): liquidity for.'));
  const restated = {
    'rules/trading/decision.md': ['serious against (a 3m close beyond the leg\'s 15m swing among them) → half', 'decisive against (a 1h CHoCH against the side) → pass'],
    'skills/trade-session/SKILL.md': ['pass on a 1h CHoCH against.'],
    'agents/risk-manager.md': ['VETO only on a 1h CHoCH against the side or a failed hard step.'],
  };
  for (const [f, list] of Object.entries(restated)) for (const s of list) assert.ok(flat(read(f)).includes(s), `${f}: ${s}`);
  // No rule or restatement keeps a swing broken as a pass.
  for (const f of ['skills/confluence-counting/SKILL.md', 'rules/trading/decision.md', 'skills/trade-session/SKILL.md', 'agents/risk-manager.md', 'skills/htf-to-ltf/SKILL.md', 'skills/pullback-vs-reversal/SKILL.md']) {
    assert.doesNotMatch(flat(read(f)), /(?:decisive|→ pass)[^.;]*(?:swing|brokenAt)|(?:swing|brokenAt)[^.;]*(?:decisive|→ pass)/, f);
  }
  // Self-test: the old rule fails it.
  assert.match('decisive against (a reversal: a 3m close broke the leg\'s 15m/1h swing) → pass', /(?:decisive|→ pass)[^.;]*(?:swing|brokenAt)/);
});
