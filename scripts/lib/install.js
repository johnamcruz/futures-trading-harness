'use strict';

/**
 * Install helpers per harness target. Plugin-native parts (skills, agents,
 * commands, hooks) are installed by each harness's own plugin/extension
 * command; this module writes what those can't: always-on rules (Claude), the
 * projectx MCP server behind the order gateway with absolute paths, agent
 * roles (Codex), and the autonomous-run permission allowlist (Qwen, scoped to
 * workspace/). Every write is idempotent and confined to a marked block or
 * keyed entries owned by the harness. A file's first backup is never overwritten.
 */

const fs = require('fs');
const path = require('path');
const { loadAgents, codexAgentsTable } = require('./harness-sync');
const { NEWS_DOMAINS } = require('./autotrader');

const MARK_BEGIN = '# >>> futures-trading-harness >>>';
const MARK_END = '# <<< futures-trading-harness <<<';
const PROJECTX_ENV = [
  'PROJECTX_USERNAME', 'PROJECTX_API_KEY', 'PROJECTX_TRADING_ENABLED', 'PROJECTX_ALLOWED_ACCOUNT_IDS',
  'PROJECTX_ALLOWED_SYMBOLS', 'PROJECTX_MAX_ORDER_SIZE', 'PROJECTX_MAX_POSITION_SIZE', 'PROJECTX_MAX_DAILY_LOSS',
  'PROJECTX_JOURNAL_PATH', 'PROJECTX_API_URL', 'PROJECTX_MARKET_HUB_URL',
];
// Order-gate settings the gateway reads; Codex forwards only listed variables.
const FTH_ENV = [
  'FTH_AUTONOMOUS', 'FTH_PAPER', 'FTH_KILL_SWITCH_FILE', 'FTH_STRATEGIES_DIRS', 'FTH_BLACKOUTS_FILE', 'FTH_GATE_LOG',
  'FTH_NO_ENTRY_WINDOWS', 'FTH_ENTRY_HOURS', 'FTH_PLAN_MAX_AGE_MIN', 'FTH_MAX_CONSECUTIVE_LOSSES', 'FTH_LOSS_COOLDOWN_MIN',
  'FTH_MAX_DAILY_LOSSES', 'FTH_MAX_ENTRIES_PER_DAY', 'FTH_ORDER_GATE_SKIP', 'FTH_ACCOUNTS_DIRS', 'FTH_MODELS_DIRS',
  'FTH_HOME',
];
// The read-only (or append-only) scripts the skills tell an autonomous run to use.
const HARNESS_SCRIPTS = ['strategies.js', 'market-snapshot.js', 'mtf.js', 'blackouts.js'];

function gatewayArgs(root, projectxEntry) {
  return [path.join(root, 'scripts', 'mcp-gateway.js'), '--', 'node', projectxEntry];
}

/** Replace (or append) the marked block in a text file's content. */
function upsertBlock(content, block) {
  const text = content || '';
  const start = text.indexOf(MARK_BEGIN);
  const end = text.indexOf(MARK_END);
  const wrapped = `${MARK_BEGIN}\n${block.trim()}\n${MARK_END}\n`;
  if (start !== -1 && end > start) {
    return text.slice(0, start) + wrapped + text.slice(end + MARK_END.length).replace(/^\n/, '');
  }
  if (start !== -1 || end !== -1) throw new Error('found an unbalanced futures-trading-harness block; fix it by hand');
  return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${wrapped}`;
}

function outsideBlock(content) {
  const start = content.indexOf(MARK_BEGIN);
  const end = content.indexOf(MARK_END);
  return start === -1 || end === -1 ? content : content.slice(0, start) + content.slice(end + MARK_END.length);
}

function codexConfigBlock(root, projectxEntry) {
  const args = gatewayArgs(root, projectxEntry).map(a => JSON.stringify(a)).join(', ');
  return [
    '# Managed by scripts/install.js --target codex. Re-run it to update; edits inside this block are overwritten.',
    '[mcp_servers.projectx]',
    'command = "node"',
    `args = [${args}]`,
    'startup_timeout_sec = 30',
    '# projectx marks order tools destructive; under approval_policy "never" (codex exec)',
    '# Codex would refuse them. The gateway enforces the order gate on every call instead.',
    'default_tools_approval_mode = "approve"',
    '# Forward credentials, guardrails, and order-gate settings from the launching environment.',
    `env_vars = [${[...PROJECTX_ENV, ...FTH_ENV].map(v => JSON.stringify(v)).join(', ')}]`,
    '',
    codexAgentsTable(loadAgents(root), path.join(root, '.codex', 'agents').split(path.sep).join('/')),
  ].join('\n');
}

function planCodex({ root, home, projectxEntry }) {
  const file = path.join(home, '.codex', 'config.toml');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (/^\s*\[mcp_servers\.projectx\]/m.test(outsideBlock(current))) {
    throw new Error(`${file} already defines [mcp_servers.projectx] outside the harness block; remove it first`);
  }
  return {
    writes: [{ file, content: upsertBlock(current, codexConfigBlock(root, projectxEntry)) }],
    next: [
      `codex plugin marketplace add ${root}`,
      'codex plugin add futures-trading-harness@futures-trading-harness',
      'Open /hooks in Codex once and trust the harness hooks (the MCP gateway enforces the order gate either way).',
      `Run trading sessions from ${path.join(root, 'workspace')} so Codex reads workspace/AGENTS.md (its sandbox keeps writes inside workspace/ and /tmp).`,
    ],
  };
}

const isOurHook = group => (group.hooks || []).some(h => /run-with-flags\.js"? (pre|session-start|stop):trading:/.test(String(h.command || '')));

/**
 * User-level Qwen settings: the projectx MCP server behind the gateway. Hooks
 * come from the extension (qwen-extension/hooks); any harness hooks an older
 * install merged here are removed so they don't run twice.
 */
function mergeQwenSettings(settings, root, projectxEntry) {
  const next = { ...settings };
  if (settings.hooks) {
    next.hooks = {};
    for (const [event, groups] of Object.entries(settings.hooks)) {
      const kept = (groups || []).filter(g => !isOurHook(g));
      if (kept.length) next.hooks[event] = kept;
    }
    if (Object.keys(next.hooks).length === 0) delete next.hooks;
  }
  const existing = settings.mcpServers && settings.mcpServers.projectx;
  const ours = { command: 'node', args: gatewayArgs(root, projectxEntry), timeout: 60000 };
  if (existing && !(existing.args || []).some(a => String(a).endsWith('mcp-gateway.js'))) {
    throw new Error('settings.json already has an mcpServers.projectx that does not use the harness gateway; remove it first');
  }
  next.mcpServers = { ...(settings.mcpServers || {}), projectx: { ...(existing || {}), ...ours } };
  return next;
}

/**
 * Project settings for workspace/ (where autonomous Qwen runs start): allow the
 * projectx tools, reading, scratch files, and the harness's own scripts; deny
 * edits to the harness, its state, and harness configs, so a run can't loosen
 * its own limits.
 */
function qwenWorkspaceSettings(root, home, { dataDir = path.join(home, '.futures-trading-harness', 'bars'), stateDir = path.join(home, '.futures-trading-harness') } = {}) {
  const abs = p => `/${p}`; // Qwen rules use //absolute/path
  const h = p => abs(path.join(home, p));
  const state = stateDir === path.join(home, '.futures-trading-harness') ? [] : [`Edit(${abs(stateDir)}/**)`];
  return {
    permissions: {
      allow: [
        'mcp__projectx', 'Skill', 'Agent', 'web_search',
        ...NEWS_DOMAINS.map(d => `WebFetch(${d})`),
        `Read(${abs(root)}/**)`, `Read(${abs(dataDir)}/**)`, `Read(${abs(stateDir)}/logs/**)`, `Read(${abs('/tmp/fth')}/**)`,
        'Bash(mkdir -p /tmp/fth)', `Edit(${abs('/tmp/fth/**')})`,
        ...HARNESS_SCRIPTS.map(s => `Bash(node ${root}/scripts/${s} *)`),
        // The prop attempt's state and verdicts, read-only (start/stop/record-day stay the user's).
        `Bash(node ${root}/scripts/combine.js status *)`,
      ],
      deny: [
        `Edit(${abs(`${root}/**`)})`,
        `Edit(${h('.futures-trading-harness')}/**)`,
        ...state,
        `Edit(${h('.projectx-mcp')}/**)`,
        `Edit(${h('.qwen')}/**)`,
        `Read(${abs('/proc')}/**)`,
        `Read(${h('.qwen')}/**)`, `Read(${h('.claude')}/**)`, `Read(${h('.claude.json')})`,
        `Read(${h('.codex')}/**)`, `Read(${h('.ssh')}/**)`, `Read(${abs(root)}/**/.env)`,
        // Credentials (.env in the state dir).
        `Read(${abs(stateDir)}/.env)`,
      ],
    },
  };
}

/** Remove line and block comments outside strings (Qwen settings files allow them). */
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] || ''; i += 1; } else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

function planQwen({ root, home, projectxEntry }) {
  const file = path.join(home, '.qwen', 'settings.json');
  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
    } catch (err) {
      throw new Error(`${file} is not valid JSON (${err.message}); fix it before installing`, { cause: err });
    }
  }
  return {
    writes: [
      { file, content: `${JSON.stringify(mergeQwenSettings(settings, root, projectxEntry), null, 2)}\n` },
      { file: path.join(root, 'workspace', '.qwen', 'settings.json'), content: `${JSON.stringify(qwenWorkspaceSettings(root, home), null, 2)}\n` },
    ],
    next: [
      `qwen extensions link ${path.join(root, 'qwen-extension')}   (link, not install: the extension uses symlinks to this checkout)`,
      'Export PROJECTX_USERNAME, PROJECTX_API_KEY and the PROJECTX_* guardrails in the shell that launches qwen (extension settings do not reach MCP servers).',
      `Run trading sessions from ${path.join(root, 'workspace')}; its .qwen/settings.json holds the autonomous-run allowlist.`,
    ],
  };
}

function planClaude({ root, home, projectxEntry }) {
  const rulesDir = path.join(root, 'rules', 'trading');
  const writes = fs.readdirSync(rulesDir).filter(f => f.endsWith('.md')).sort()
    .map(f => ({ file: path.join(home, '.claude', 'rules', 'trading', f), content: fs.readFileSync(path.join(rulesDir, f), 'utf8') }));
  const guardrails = PROJECTX_ENV.filter(v => !/(JOURNAL_PATH|API_URL|HUB_URL)$/.test(v));
  const mcp = ['claude mcp add projectx --scope user', ...guardrails.map(v => `--env ${v}=...`), '--', 'node', ...gatewayArgs(root, projectxEntry).map(a => JSON.stringify(a))].join(' ');
  return {
    writes,
    next: [
      `/plugin marketplace add ${root}`,
      '/plugin install futures-trading-harness@futures-trading-harness',
      mcp,
      'Merge mcp-configs/settings.example.json into ~/.claude/settings.json (order tools on "ask" until you trust the setup).',
    ],
  };
}

const TARGETS = { claude: planClaude, codex: planCodex, qwen: planQwen };

function applyPlan(plan) {
  for (const w of plan.writes) {
    fs.mkdirSync(path.dirname(w.file), { recursive: true });
    // Keep the first backup: it is the user's file from before any install.
    // A file the installer created itself is marked instead, so a later run
    // doesn't take our own output for the user's original.
    const created = `${w.file}.fth-created`;
    if (!fs.existsSync(w.file)) {
      if (!fs.existsSync(`${w.file}.fth-backup`)) fs.writeFileSync(created, 'created by scripts/install.js; there was no original\n');
    } else if (!fs.existsSync(`${w.file}.fth-backup`) && !fs.existsSync(created)) {
      fs.copyFileSync(w.file, `${w.file}.fth-backup`);
    }
    fs.writeFileSync(w.file, w.content);
  }
}

module.exports = {
  MARK_BEGIN,
  MARK_END,
  TARGETS,
  upsertBlock,
  codexConfigBlock,
  mergeQwenSettings,
  qwenWorkspaceSettings,
  stripJsonComments,
  planClaude,
  planCodex,
  planQwen,
  applyPlan,
};
