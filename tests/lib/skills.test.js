'use strict';

/**
 * The skills, agents, rules, and commands tell the LLM which scripts, flags,
 * and MCP tools to use. These tests check those names against the code and
 * the autonomous allowlists, so a skill can't send an agent to a script that
 * doesn't exist, a flag a script doesn't parse, or a command an autonomous
 * run isn't allowed to run.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { claudeTools } = require('../../scripts/lib/autotrader');
const { qwenWorkspaceSettings } = require('../../scripts/lib/install');

const ROOT = path.resolve(__dirname, '..', '..');

function docs() {
  const out = [];
  const add = (dir, pick) => {
    const abs = path.join(ROOT, dir);
    for (const name of fs.readdirSync(abs).sort()) {
      const file = pick(name);
      if (file && fs.existsSync(path.join(abs, file))) out.push(path.join(dir, file));
    }
  };
  add('skills', name => path.join(name, 'SKILL.md'));
  add('agents', name => (name.endsWith('.md') ? name : null));
  add('rules/trading', name => (name.endsWith('.md') ? name : null));
  add('commands', name => (name.endsWith('.md') ? name : null));
  return out.map(rel => ({ rel, text: fs.readFileSync(path.join(ROOT, rel), 'utf8') }));
}

const DOCS = docs();

/** Every `node <root>/scripts/<script> [sub] [--flags]` command written in the docs. */
function commands() {
  const out = [];
  for (const d of DOCS) {
    d.text.split('\n').forEach((line, i) => {
      const re = /node (?:<root>|\$FTH_ROOT|\/abs\/path)\/scripts\/([a-z0-9-]+\.js)((?:[ \t]+[^\s`|;]+)*)/g;
      let m;
      while ((m = re.exec(line))) {
        const args = m[2].trim().split(/\s+/).filter(Boolean);
        const sub = args[0] && /^[a-z][a-z-]*$/.test(args[0]) ? args[0] : null;
        const flags = args.filter(a => a.startsWith('--')).map(a => a.replace(/=.*$/, ''));
        out.push({ where: `${d.rel}:${i + 1}`, doc: d.rel, script: m[1], sub, flags });
      }
    });
  }
  return out;
}

const COMMANDS = commands();
// A CLI and its operations (scripts/lib/harness-tools/<script>, which parses its argv).
const source = script => [path.join(ROOT, 'scripts', script), path.join(ROOT, 'scripts', 'lib', 'harness-tools', script)]
  .filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f, 'utf8')).join('\n');

test('skills: every script and rl entry point the docs name exists', () => {
  const missing = [];
  for (const d of DOCS) {
    for (const m of d.text.matchAll(/\b((?:scripts|rl)\/[a-z0-9_-]+\.(?:js|py))\b/g)) {
      if (!fs.existsSync(path.join(ROOT, m[1]))) missing.push(`${d.rel}: ${m[1]}`);
    }
  }
  assert.deepStrictEqual(missing, []);
  // Agents use the harness tools; the docs name scripts only for the user's commands (combine start/record-day, backtests).
  assert.ok(COMMANDS.length >= 3, `found ${COMMANDS.length} commands; the parser is broken`);
});

test('skills: every subcommand the docs give a script is one it handles', () => {
  const bad = COMMANDS.filter(c => c.sub && !new RegExp(`['"]${c.sub}['"]`).test(source(c.script)))
    .map(c => `${c.where}: ${c.script} ${c.sub}`);
  assert.deepStrictEqual(bad, []);
});

test('skills: every flag the docs give a script is one it (or its library) reads', () => {
  const lib = fs.readdirSync(path.join(ROOT, 'scripts', 'lib'), { recursive: true })
    .filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(ROOT, 'scripts', 'lib', f), 'utf8'))
    .join('\n');
  // market-snapshot takes any parameter as --name=value.
  const generic = new Set(['market-snapshot.js']);
  const bad = [];
  for (const c of COMMANDS) {
    if (generic.has(c.script)) continue;
    const src = source(c.script);
    for (const f of c.flags) {
      const name = f.slice(2);
      const known = src.includes(f) || lib.includes(f) || new RegExp(`['"]${name}['"]`).test(src);
      if (!known) bad.push(`${c.where}: ${c.script} ${f}`);
    }
  }
  assert.deepStrictEqual(bad, []);
});

// What an autonomous run reads: these skills and agents may only name commands it is allowed to run.
const AUTONOMOUS = [
  'skills/trade-session/SKILL.md', 'skills/autonomous-trading/SKILL.md', 'skills/premarket/SKILL.md',
  'skills/end-of-day/SKILL.md', 'skills/market-snapshot/SKILL.md', 'skills/multi-timeframe-analysis/SKILL.md',
  'skills/strategy-library/SKILL.md', 'skills/trade-review/SKILL.md', 'skills/prop-challenge-pacing/SKILL.md',
  'skills/session-timing/SKILL.md', 'skills/position-sizing/SKILL.md',
  'agents/market-structure-analyst.md', 'agents/trend-momentum-analyst.md', 'agents/volume-liquidity-analyst.md',
  'agents/news-calendar-analyst.md', 'agents/risk-manager.md', 'agents/trade-executor.md', 'agents/trade-reviewer.md',
];
// Commands the docs give to the user (the skill says so where it names them); agents never run them.
const USER_ONLY = new Set(['combine.js start', 'combine.js stop', 'combine.js record-day', 'backtest.js', 'check-secrets.js', 'sync-harness.js', 'install.js', 'autotrader.js']);

test('skills: every command an autonomous skill or agent names is allowed for Claude and Qwen runs', () => {
  for (const f of AUTONOMOUS) assert.ok(DOCS.some(d => d.rel === f), `${f} is missing; update the list`);
  const claude = claudeTools('/fth', { home: '/home/u' });
  const qwen = qwenWorkspaceSettings('/fth', '/home/u').permissions.allow;
  const bad = [];
  for (const c of COMMANDS.filter(x => AUTONOMOUS.includes(x.doc))) {
    const key = c.sub ? `${c.script} ${c.sub}` : c.script;
    if (USER_ONLY.has(key) || USER_ONLY.has(c.script)) continue;
    const okClaude = claude.includes(`Bash(node /fth/scripts/${c.script}:*)`)
      || (c.sub && claude.includes(`Bash(node /fth/scripts/${c.script} ${c.sub}:*)`));
    const okQwen = qwen.includes(`Bash(node /fth/scripts/${c.script} *)`)
      || (c.sub && qwen.includes(`Bash(node /fth/scripts/${c.script} ${c.sub} *)`));
    if (!okClaude) bad.push(`${c.where}: ${key} (not allowed for Claude autonomous runs)`);
    if (!okQwen) bad.push(`${c.where}: ${key} (not allowed for Qwen workspaces)`);
  }
  assert.deepStrictEqual(bad, []);
});

test('skills: a user-only command an autonomous doc names is marked as the user\'s', () => {
  const bad = [];
  for (const c of COMMANDS.filter(x => AUTONOMOUS.includes(x.doc) && (USER_ONLY.has(`${x.script} ${x.sub}`) || USER_ONLY.has(x.script)))) {
    const text = DOCS.find(d => d.rel === c.doc).text.split('\n');
    const line = Number(c.where.split(':').pop()) - 1;
    const near = text.slice(Math.max(0, line - 3), line + 4).join(' ');
    if (!/user/i.test(near)) bad.push(`${c.where}: ${c.script} ${c.sub || ''}`.trim());
  }
  assert.deepStrictEqual(bad, []);
});

test('skills: every broker tool the docs name is in the broker-mcp tool table', () => {
  const ref = DOCS.find(d => d.rel === 'skills/broker-mcp/SKILL.md').text;
  const table = ref.slice(ref.indexOf('### Tools'), ref.indexOf('### Order mechanics'));
  const known = new Set([...table.matchAll(/`([a-z_]+)`/g)].map(m => m[1]));
  assert.ok(known.has('place_order') && known.size > 15, 'the tool table moved; update this test');
  const TOOL = /^(get|list|search|place|modify|cancel|close|partial|journal)_[a-z_]+$/;
  // Names in backticks that look like tools but are not (fields, kinds, keys).
  const NOT_TOOLS = new Set(['search_space']); // a sweep config key
  const bad = new Set();
  for (const d of DOCS) {
    for (const m of d.text.matchAll(/`([a-z_]+)(?:[ {(][^`]*)?`/g)) {
      if (TOOL.test(m[1]) && !known.has(m[1]) && !NOT_TOOLS.has(m[1])) bad.add(`${d.rel}: ${m[1]}`);
    }
    for (const m of d.text.matchAll(/mcp__broker__([a-z_]+)/g)) {
      if (!known.has(m[1])) bad.add(`${d.rel}: mcp__broker__${m[1]}`);
    }
  }
  assert.deepStrictEqual([...bad], []);
});

test('skills: autonomous scripts the docs rely on are in both allowlists', () => {
  const claude = claudeTools('/fth', { home: '/home/u' });
  const qwen = qwenWorkspaceSettings('/fth', '/home/u').permissions.allow;
  for (const s of ['strategies.js', 'market-snapshot.js', 'mtf.js', 'blackouts.js']) {
    assert.ok(claude.includes(`Bash(node /fth/scripts/${s}:*)`), `claude: ${s}`);
    assert.ok(qwen.includes(`Bash(node /fth/scripts/${s} *)`), `qwen: ${s}`);
  }
  assert.ok(claude.includes('Bash(node /fth/scripts/combine.js status:*)'));
  assert.ok(qwen.includes('Bash(node /fth/scripts/combine.js status *)'));
  // Start, stop, and record-day stay the user's.
  assert.ok(!claude.some(t => /combine\.js (start|stop|record-day)|combine\.js:\*/.test(t)));
  assert.ok(!qwen.some(t => /combine\.js (start|stop|record-day)|combine\.js \*/.test(t)));
});

// The harness tools (scripts/lib/harness-tools/registry.js): what agents use instead of the scripts.
const { TOOLS: HARNESS_TOOLS } = require('../../scripts/lib/harness-tools/registry');
const HARNESS_NAMES = new Set(HARNESS_TOOLS.map(t => t.name));
// The scripts behind the harness tools: people run them; agents use the tools.
const AGENT_RUN_SCRIPT = /\b(?:strategies|market-snapshot|mtf|blackouts|bars|lessons|reconcile)\.js\b|combine\.js status/;

test('skills: every harness tool the docs name exists, and the harness-tools skill lists every tool with its arguments', () => {
  const FAMILY = /^(?:strategies|market|mtf|blackouts|bars|combine)_[a-z_]+$/;
  const NOT_TOOLS = new Set(['mtf_bias']); // a rules-language series
  const bad = new Set();
  for (const d of DOCS) {
    for (const m of d.text.matchAll(/mcp__harness__([a-z_]+)/g)) if (!HARNESS_NAMES.has(m[1])) bad.add(`${d.rel}: mcp__harness__${m[1]}`);
    for (const m of d.text.matchAll(/`([a-z_]+)(?:[ {(][^`]*)?`/g)) if (FAMILY.test(m[1]) && !HARNESS_NAMES.has(m[1]) && !NOT_TOOLS.has(m[1])) bad.add(`${d.rel}: ${m[1]}`);
    for (const m of d.text.matchAll(/^([a-z_]+) \{/gm)) if (FAMILY.test(m[1]) && !HARNESS_NAMES.has(m[1])) bad.add(`${d.rel}: ${m[1]}`);
  }
  assert.deepStrictEqual([...bad], []);
  const ref = DOCS.find(d => d.rel === 'skills/harness-tools/SKILL.md').text;
  for (const t of HARNESS_TOOLS) {
    const row = ref.split('\n').find(l => l.startsWith(`| \`${t.name}\` |`));
    assert.ok(row, `skills/harness-tools/SKILL.md lists ${t.name}`);
    for (const arg of Object.keys(t.inputSchema.properties)) assert.ok(row.includes(`\`${arg}\``), `${t.name}: argument ${arg} in its row`);
  }
});

test('skills: no doc sends an agent to a script a harness tool replaces; only user-only commands stay scripts', () => {
  const bad = [];
  for (const d of DOCS.filter(x => x.rel !== 'skills/harness-tools/SKILL.md')) {
    d.text.split('\n').forEach((line, i) => { if (AGENT_RUN_SCRIPT.test(line)) bad.push(`${d.rel}:${i + 1}: ${line.trim().slice(0, 100)}`); });
  }
  assert.deepStrictEqual(bad, []);
  const scripted = COMMANDS.filter(c => AUTONOMOUS.includes(c.doc) && !USER_ONLY.has(`${c.script} ${c.sub}`) && !USER_ONLY.has(c.script));
  assert.deepStrictEqual(scripted.map(c => `${c.where}: ${c.script}`), [], 'an autonomous doc names `node <root>/scripts/` only for the user\'s commands');
});

test('agents: every mcp__harness__ tool a role lists exists; analysts, risk-manager and trade-reviewer have no shell or file writes', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  const tools = {};
  for (const d of DOCS.filter(x => x.rel.startsWith('agents/'))) {
    const list = String(parseFrontmatter(d.text).data.tools || '').split(',').map(s => s.trim()).filter(Boolean);
    tools[path.basename(d.rel, '.md')] = list;
    for (const t of list.filter(x => x.startsWith('mcp__harness__'))) assert.ok(HARNESS_NAMES.has(t.slice('mcp__harness__'.length)), `${d.rel}: ${t}`);
  }
  for (const role of ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager', 'trade-reviewer']) {
    assert.ok(!tools[role].includes('Bash') && !tools[role].includes('Write') && !tools[role].includes('Edit'), `${role}: no Bash, Write or Edit`);
    assert.ok(tools[role].some(t => t.startsWith('mcp__harness__')), `${role}: uses the harness tools`);
  }
  for (const role of ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst']) {
    for (const t of ['bars_fetch', 'market_snapshot']) assert.ok(tools[role].includes(`mcp__harness__${t}`), `${role}: ${t}`);
  }
  assert.ok(tools['risk-manager'].includes('mcp__harness__combine_status'));
  assert.ok(tools['trade-reviewer'].includes('mcp__harness__lessons'));
  // No role holds a harness tool that writes the gate's state except through record (refused in autonomous runs) and
  // blackouts_add, which only the head trader uses.
  for (const [role, list] of Object.entries(tools)) assert.ok(!list.includes('mcp__harness__blackouts_add'), `${role}: blackouts_add is the head trader's`);
});
