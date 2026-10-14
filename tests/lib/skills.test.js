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
  // trade-session's pieces (tests/plugin/trade-session-split.test.js) and the refusal row of the gate's entry check.
  'skills/role-round/SKILL.md', 'skills/lean-cycle/SKILL.md', 'skills/manage-position/SKILL.md', 'skills/leftover-orders/SKILL.md',
  'skills/setup-judgment/SKILL.md', 'skills/day-context/SKILL.md', 'skills/trade-plan/SKILL.md', 'skills/entry-outcome/SKILL.md',
  'skills/gate-refusals-skills/SKILL.md',
  'skills/runner-lanes/SKILL.md', 'skills/kill-switch/SKILL.md', 'skills/runner-logs/SKILL.md',
  'skills/end-of-day/SKILL.md', 'skills/market-snapshot/SKILL.md', 'skills/multi-timeframe-analysis/SKILL.md',
  'skills/strategy-library/SKILL.md', 'skills/strategy-scan/SKILL.md', 'skills/strategy-gate-checks/SKILL.md', 'skills/harness-root/SKILL.md',
  'skills/htf-to-ltf/SKILL.md', 'skills/daily-bias/SKILL.md', 'skills/top-down-entry/SKILL.md', 'skills/timeframe-sources/SKILL.md',
  'skills/trade-review/SKILL.md', 'skills/prop-challenge-pacing/SKILL.md',
  'skills/session-timing/SKILL.md', 'skills/news-blackouts/SKILL.md', 'skills/exchange-holidays/SKILL.md',
  'skills/contract-roll/SKILL.md', 'skills/position-sizing/SKILL.md', 'skills/micro-mini-specs/SKILL.md',
  'skills/prop-evaluator/SKILL.md', 'skills/prop-pacing-judgment/SKILL.md',
  'agents/market-structure-analyst.md', 'agents/trend-momentum-analyst.md', 'agents/volume-liquidity-analyst.md',
  'agents/news-calendar-analyst.md', 'agents/risk-manager.md', 'agents/trade-executor.md', 'agents/trade-reviewer.md',
];
// Commands the docs give to the user (the skill says so where it names them); agents never run them.
const USER_ONLY = new Set(['combine.js start', 'combine.js stop', 'combine.js record-day', 'backtest.js', 'evaluate.js', 'check-secrets.js', 'sync-harness.js', 'install.js', 'autotrader.js']);

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
  const table = ref.slice(ref.indexOf('### Tools'), ref.indexOf('### Where the rest is'));
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
// The scripts behind the harness tools: people run them; agents use the tools. Not after a hyphen:
// compare-bars.js is a script of its own, not bars.js.
const AGENT_RUN_SCRIPT = /(?<![\w-])(?:strategies|market-snapshot|mtf|blackouts|bars|lessons|reconcile)\.js\b|combine\.js status/;
// Each tool's home: the one skill that holds its row (tests/plugin/harness-tools-split.test.js keeps it to one). The
// row names, in its last cell, the script a person runs for the tool. Only that row, in that skill, may name such a script.
const TOOL_HOMES = (() => {
  const homes = new Map();
  for (const t of HARNESS_TOOLS) {
    const at = DOCS.filter(d => d.rel.startsWith('skills/') && d.text.split('\n').some(l => l.startsWith(`| \`${t.name}\` |`))).map(d => d.rel);
    if (at.length === 1) homes.set(t.name, at[0]);
  }
  return homes;
})();
// The skill for people at a terminal (no role loads it): it names the scripts on purpose.
const PEOPLE = 'skills/user-commands/SKILL.md';
/** The lines of a doc that send an agent to a script a harness tool replaces (a home's tool row may name it in its last cell). */
function agentScriptLines(rel, text) {
  const bad = [];
  text.split('\n').forEach((line, i) => {
    if (!AGENT_RUN_SCRIPT.test(line)) return;
    const m = /^\| `([a-z_]+)` \|(.*)\|\s*$/.exec(line);
    const cells = m && HARNESS_NAMES.has(m[1]) ? m[2].split(' | ') : null;
    if (cells && TOOL_HOMES.get(m[1]) === rel && !AGENT_RUN_SCRIPT.test(cells.slice(0, -1).join(' | '))) return;
    bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
  });
  return bad;
}

test('skills: every harness tool the docs name exists, and a skill lists every tool with its arguments in a tool table', () => {
  const FAMILY = /^(?:strategies|market|mtf|blackouts|bars|combine)_[a-z_]+$/;
  const NOT_TOOLS = new Set(['mtf_bias']); // a rules-language series
  const bad = new Set();
  for (const d of DOCS) {
    for (const m of d.text.matchAll(/mcp__harness__([a-z_]+)/g)) if (!HARNESS_NAMES.has(m[1])) bad.add(`${d.rel}: mcp__harness__${m[1]}`);
    for (const m of d.text.matchAll(/`([a-z_]+)(?:[ {(][^`]*)?`/g)) if (FAMILY.test(m[1]) && !HARNESS_NAMES.has(m[1]) && !NOT_TOOLS.has(m[1])) bad.add(`${d.rel}: ${m[1]}`);
    for (const m of d.text.matchAll(/^([a-z_]+) \{/gm)) if (FAMILY.test(m[1]) && !HARNESS_NAMES.has(m[1])) bad.add(`${d.rel}: ${m[1]}`);
  }
  assert.deepStrictEqual([...bad], []);
  // Each tool's row is in the skill of its topic (tests/plugin/harness-tools-split.test.js). lessons and reconcile have
  // only the people's mirror (user-commands): their arguments are in their MCP schemas.
  const rows = DOCS.filter(d => d.rel.startsWith('skills/')).flatMap(d => d.text.split('\n'));
  const MIRROR_ONLY = new Set(['lessons', 'reconcile']);
  // compose_check gets its row with the skills that teach the trade lifecycle (the skills stay as they are until then:
  // the owner's call); its MCP schema carries its arguments. Drop it here once its row is written.
  const NO_ROW_YET = new Set(['compose_check']);
  for (const t of HARNESS_TOOLS) {
    const row = rows.find(l => l.startsWith(`| \`${t.name}\` |`));
    if (NO_ROW_YET.has(t.name)) { assert.ok(!row, `${t.name} has its row now: drop the exception`); continue; }
    assert.ok(row, `a skill lists ${t.name} in a tool table`);
    if (MIRROR_ONLY.has(t.name)) continue;
    for (const arg of Object.keys(t.inputSchema.properties)) assert.ok(row.includes(`\`${arg}\``), `${t.name}: argument ${arg} in its row`);
  }
});

test('skills: no doc sends an agent to a script a harness tool replaces; only user-only commands stay scripts', () => {
  const bad = DOCS.filter(x => x.rel !== PEOPLE).flatMap(d => agentScriptLines(d.rel, d.text));
  assert.deepStrictEqual(bad, []);
  // The exemption is only a tool's row in its own home skill, with the script in its last cell: the same row in a role, a script
  // in another cell, or a tool row in a skill that isn't the tool's home is caught.
  const row = '| `bars_fetch` | `symbol` | writes bars | `bars.js --symbol MNQ` |';
  assert.deepStrictEqual(agentScriptLines('skills/bar-briefing/SKILL.md', row), []);
  assert.strictEqual(agentScriptLines('agents/risk-manager.md', row).length, 1);
  assert.strictEqual(agentScriptLines('skills/bar-briefing/SKILL.md', '| `bars_fetch` | run bars.js yourself | x | `bars.js` |').length, 1);
  assert.strictEqual(agentScriptLines('skills/trader-process/SKILL.md', row).length, 1);
  // Only in the tool's own home: a bars_fetch row in order-plan (another tool's home) is caught.
  assert.strictEqual(agentScriptLines('skills/order-plan/SKILL.md', row).length, 1);
  assert.strictEqual(TOOL_HOMES.get('bars_fetch'), 'skills/bar-briefing/SKILL.md');
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

// A valid value per argument, for a placeholder (<SYMBOL>, <minutes>) in a documented call.
const SAMPLE = {
  symbol: 'MNQ', bars: '/h/bars-scratch/a.json', daily: '/h/bars-scratch/a.json', timeframe: 3, count: 5, timeframes: [15], start: '2026-01-02T10:00:00Z',
  end: '2026-01-02T10:30:00Z', reason: 'x', account: 'test_50k', day: '2026-01-02', top: 5, json: true, record: true, params: {},
  strategy: 'orb', side: 'long', accountId: 7, reasons: 'no-trade - no candidates',
};
const sampleFor = (tool, key) => (key === 'name' ? (tool === 'strategies_show' ? 'orb' : 'trend') : SAMPLE[key]);

/** The balanced {...} at the start of text (after spaces), or null. */
function leadingObject(text) {
  const i = text.search(/\S/);
  if (i === -1 || text[i] !== '{') return null;
  let depth = 0;
  let inString = false;
  for (let k = i; k < text.length; k += 1) {
    const ch = text[k];
    if (inString) {
      if (ch === '\\') k += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(i, k + 1);
    }
  }
  return null;
}

/** A documented call's object as a value: unquoted keys quoted, placeholders (<...>) replaced by valid samples. */
function callObject(tool, raw) {
  const json = raw.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":').replace(/:\s*<[^>]*>/g, ': "<placeholder>"');
  let obj;
  try {
    obj = JSON.parse(json);
  } catch (_err) {
    return { error: `not a readable object: ${raw.slice(0, 60)}` };
  }
  const fill = (o, top) => {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && v.includes('<')) o[k] = top ? sampleFor(tool, k) : 1;
      else if (v && typeof v === 'object' && !Array.isArray(v)) fill(v, false);
    }
    return o;
  };
  return { obj: fill(obj, true) };
}

test('skills: every harness tool call a doc writes is valid for the tool (names, types, ranges, required); tool-like names exist', () => {
  const { validate } = require('../../scripts/lib/harness-tools/validate');
  const bad = [];
  for (const d of DOCS) {
    for (const name of HARNESS_NAMES) {
      const schema = BY_NAME_SCHEMA(name);
      for (const m of d.text.matchAll(new RegExp(`(?<![A-Za-z0-9])(?:mcp__harness__)?${name}(?![A-Za-z0-9_])`, 'g'))) {
        const rest = d.text.slice(m.index + m[0].length, m.index + m[0].length + 600);
        const where = `${d.rel}: ${name}`;
        // `tool {...}`, `tool` `{...}`, `tool`: `{...}`, `tool` with (arguments) `{...}`, `tool` (`{...}`), and a fenced block after it.
        const lead = /^`?\s*:?\s*(?:with\s+(?:arguments\s+)?)?\(?(?:`(?!``))?\s*(?:```(?:json)?\s*\n)?/.exec(rest);
        let raw = leadingObject(rest.slice(lead[0].length));
        if (!raw) {
          // Further along the clause (a table cell, "passing `{...}`", "(arguments: `{...}`)"), before any other tool is named.
          const clause = rest.slice(0, 300).split(/\.\s|\n\s*\n|;\s/)[0];
          const next = clause.search(new RegExp(`(?<![A-Za-z0-9])(${[...HARNESS_NAMES].join('|')})(?![A-Za-z0-9_])`));
          const scope = next === -1 ? clause : clause.slice(0, next);
          const at = scope.search(/[`(:]\s*\{/);
          if (at !== -1) raw = leadingObject(rest.slice(at + 1));
        }
        if (raw) {
          const { obj, error } = callObject(name, raw);
          if (error) {
            bad.push(`${where}: ${error}`);
            continue;
          }
          const errs = validate(schema, obj);
          if (errs.length) bad.push(`${where} ${raw.slice(0, 80)}: ${errs.join('; ')}`);
          continue;
        }
        // `tool` with `arg`, `arg: value` and `arg` (to the end of the clause)
        if (!/^`?\s*with\s/.test(rest)) continue;
        const clause = rest.split(/[.;)]\s|\n\s*\n/)[0];
        for (const a of clause.matchAll(/`([a-z_]+)(?::\s*([^`]+))?`/g)) {
          if (HARNESS_NAMES.has(a[1])) continue; // another tool named in the clause
          if (!schema.properties[a[1]]) bad.push(`${where} with \`${a[1]}\`: no such argument`);
        }
      }
    }
    // Names that look like a harness tool (singular or plural of a tool's family) must be one.
    for (const m of d.text.matchAll(/`([a-z]+_[a-z_]+)(?:[ {(][^`]*)?`/g)) {
      const looks = /^(strateg(y|ies)|markets?|mtfs?|blackouts?|bars?|combines?|lessons?|reconciles?|harness)_/.test(m[1]);
      if (looks && !HARNESS_NAMES.has(m[1]) && m[1] !== 'mtf_bias') bad.push(`${d.rel}: \`${m[1]}\` is not a harness tool`);
    }
  }
  assert.deepStrictEqual(bad, []);
});

function BY_NAME_SCHEMA(name) {
  return HARNESS_TOOLS.find(t => t.name === name).inputSchema;
}

test('skills: messages an agent reads from the gate and the hooks name the harness tools, not the scripts', () => {
  const files = ['scripts/lib/trading', 'scripts/hooks', 'scripts/lib/harness-tools'].flatMap(dir => fs.readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith('.js')).map(f => path.join(dir, f)))
    .concat(['scripts/lib/bars-fetch.js']); // what bars_fetch's operation calls
  assert.ok(files.length > 30);
  const bad = [];
  for (const f of files) {
    fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) return; // comments are for people
      if (/USAGE|usage:/.test(line)) return; // a script's own usage line (its argv parsing; no tool reaches it)
      if (AGENT_RUN_SCRIPT.test(line) || /node <root>\/scripts\//.test(line)) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
      // A message a tool can return names the caller's words: say(c, '--flag ...', 'argument ...') or a tool flag,
      // never a bare script flag. Exempt: argv parsing, lines marked `// cli-only:` (the tool's schema refuses first).
      // Messages a tool or the gate returns: the harness tools' own, and the gate's and the briefing's (scripts/lib/trading, hooks).
      const toolPath = true;
      const flagString = /(['"`])[^'"`]*--(?:[a-z]|\$\{)[^'"`]*\1|`[^`]*--(?:[a-z]|\$\{)/.test(line);
      const parsing = /flag ===|\ba === '--|options\(|o\['--|argv/.test(line);
      // A user-only command may be named, as the user's (the line says so).
      if (toolPath && flagString && !parsing && !/say\(c,|\btool \?|\/\/ cli-only: |the user/.test(line)) bad.push(`${f}:${i + 1}: a script flag in a message: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepStrictEqual(bad, []);
});
