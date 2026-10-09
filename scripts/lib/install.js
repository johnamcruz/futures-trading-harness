'use strict';

/**
 * Install helpers per harness target. Plugin-native parts (skills, agents,
 * commands, hooks) are installed by each harness's own plugin/extension
 * command; this module writes what those can't: always-on rules (Claude), the
 * broker MCP server (named `broker`, the one in the broker config) behind the
 * order gateway with absolute paths, the chosen server's entry, agent
 * roles (Codex), and the autonomous-run permission allowlist (Qwen, scoped to
 * workspace/). Every write is idempotent and confined to a marked block or
 * keyed entries owned by the harness. A file's first backup is never overwritten.
 */

const fs = require('fs');
const path = require('path');
const { loadAgents, codexAgentsTable } = require('./harness-sync');
const { NEWS_DOMAINS } = require('./autotrader');
const { SERVER_NAME } = require('./broker/config');

const MARK_BEGIN = '# >>> futures-trading-harness >>>';
const MARK_END = '# <<< futures-trading-harness <<<';
// Order-gate settings the gateway reads; Codex forwards only listed variables.
const FTH_ENV = [
  'FTH_AUTONOMOUS', 'FTH_PAPER', 'FTH_KILL_SWITCH_FILE', 'FTH_STRATEGIES_DIRS', 'FTH_BLACKOUTS_FILE', 'FTH_GATE_LOG',
  'FTH_NO_ENTRY_WINDOWS', 'FTH_ENTRY_HOURS', 'FTH_PLAN_MAX_AGE_MIN', 'FTH_MAX_CONSECUTIVE_LOSSES', 'FTH_LOSS_COOLDOWN_MIN',
  'FTH_MAX_DAILY_LOSSES', 'FTH_MAX_ENTRIES_PER_DAY', 'FTH_ORDER_GATE_SKIP', 'FTH_ACCOUNTS_DIRS', 'FTH_MODELS_DIRS',
  'FTH_HOME',
];
// The read-only (or append-only) scripts the skills tell an autonomous run to use.
const HARNESS_SCRIPTS = ['strategies.js', 'market-snapshot.js', 'mtf.js', 'blackouts.js', 'bars.js', 'reconcile.js', 'lessons.js'];

// The gateway starts the server named in the broker config, so switching brokers is a config change.
function gatewayArgs(root) {
  return [path.join(root, 'scripts', 'mcp-gateway.js')];
}

/** Variables a harness must forward to the gateway: the broker server's own, then the harness's. */
function forwardedEnv(broker) {
  return [...new Set([...broker.env, ...[broker.entryEnv, broker.journalEnv].filter(Boolean), 'FTH_BROKER', 'FTH_BROKERS_FILE', ...FTH_ENV])];
}

/**
 * <FTH_HOME>/brokers.json with this broker's server entry set (keeps the rest of the file),
 * or null when no entry was given.
 */
function planBrokerEntry({ home, brokerName, entry, stateDir = path.join(home, '.futures-trading-harness') }) {
  if (!entry) return null;
  const file = path.join(stateDir, 'brokers.json');
  let current = {};
  if (fs.existsSync(file)) {
    try {
      current = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`${file} is not valid JSON (${err.message}); fix it before installing`, { cause: err });
    }
  }
  const brokers = { ...(current.brokers || {}) };
  brokers[brokerName] = { ...(brokers[brokerName] || {}), entry };
  return { file, content: `${JSON.stringify({ ...current, broker: current.broker || brokerName, brokers }, null, 2)}\n` };
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

function codexConfigBlock(root, broker) {
  const args = gatewayArgs(root).map(a => JSON.stringify(a)).join(', ');
  return [
    '# Managed by scripts/install.js --target codex. Re-run it to update; edits inside this block are overwritten.',
    `[mcp_servers.${SERVER_NAME}]`,
    'command = "node"',
    `args = [${args}]`,
    'startup_timeout_sec = 30',
    '# The broker server marks order tools destructive; under approval_policy "never" (codex exec)',
    '# Codex would refuse them. The gateway enforces the order gate on every call instead.',
    'default_tools_approval_mode = "approve"',
    '# Forward credentials, guardrails, and order-gate settings from the launching environment.',
    `env_vars = [${forwardedEnv(broker).map(v => JSON.stringify(v)).join(', ')}]`,
    '',
    codexAgentsTable(loadAgents(root), path.join(root, '.codex', 'agents').split(path.sep).join('/')),
  ].join('\n');
}

function planCodex({ root, home, broker }) {
  const file = path.join(home, '.codex', 'config.toml');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (new RegExp(`^\\s*\\[mcp_servers\\.${SERVER_NAME}\\]`, 'm').test(outsideBlock(current))) {
    throw new Error(`${file} already defines [mcp_servers.${SERVER_NAME}] outside the harness block; remove it first`);
  }
  return {
    writes: [{ file, content: upsertBlock(current, codexConfigBlock(root, broker)) }],
    next: [
      `codex plugin marketplace add ${root}`,
      'codex plugin add futures-trading-harness@futures-trading-harness',
      'Open /hooks in Codex once and trust the harness hooks (the MCP gateway enforces the order gate either way).',
      `Run trading sessions from ${path.join(root, 'workspace')} so Codex reads workspace/AGENTS.md (its sandbox keeps writes inside workspace/ and /tmp).`,
      'Interactive sessions: let the sandbox write the multi-timeframe record the order gate reads (scripts/mtf.js --record) and news blackouts: '
        + 'codex --add-dir ~/.futures-trading-harness/mtf --add-dir ~/.futures-trading-harness/blackouts (autonomous runs need nothing: the runner records the read).',
    ],
  };
}

const isOurHook = group => (group.hooks || []).some(h => /run-with-flags\.js"? (pre|session-start|stop):trading:/.test(String(h.command || '')));

/**
 * User-level Qwen settings: the broker MCP server behind the gateway. Hooks
 * come from the extension (qwen-extension/hooks); any harness hooks an older
 * install merged here are removed so they don't run twice, and so is the
 * gateway an older install registered under another name.
 */
function mergeQwenSettings(settings, root) {
  const next = { ...settings };
  if (settings.hooks) {
    next.hooks = {};
    for (const [event, groups] of Object.entries(settings.hooks)) {
      const kept = (groups || []).filter(g => !isOurHook(g));
      if (kept.length) next.hooks[event] = kept;
    }
    if (Object.keys(next.hooks).length === 0) delete next.hooks;
  }
  const isGateway = s => Boolean(s) && (s.args || []).some(a => String(a).endsWith('mcp-gateway.js'));
  const existing = settings.mcpServers && settings.mcpServers[SERVER_NAME];
  const ours = { command: 'node', args: gatewayArgs(root), timeout: 60000 };
  if (existing && !isGateway(existing)) {
    throw new Error(`settings.json already has an mcpServers.${SERVER_NAME} that does not use the harness gateway; remove it first`);
  }
  const servers = { ...(settings.mcpServers || {}) };
  for (const [name, server] of Object.entries(servers)) if (name !== SERVER_NAME && isGateway(server)) delete servers[name];
  next.mcpServers = { ...servers, [SERVER_NAME]: { ...(existing || {}), ...ours } };
  return next;
}

/**
 * Project settings for workspace/ (where autonomous Qwen runs start): allow the
 * broker tools, reading, scratch files, and the harness's own scripts; deny
 * edits to the harness, its state, and harness configs, so a run can't loosen
 * its own limits.
 */
function qwenWorkspaceSettings(root, home, { dataDir = path.join(home, '.futures-trading-harness', 'bars'), stateDir = path.join(home, '.futures-trading-harness'), journalDir = path.join(home, '.futures-trading-harness') } = {}) {
  const abs = p => `/${p}`; // Qwen rules use //absolute/path
  const h = p => abs(path.join(home, p));
  const state = stateDir === path.join(home, '.futures-trading-harness') ? [] : [`Edit(${abs(stateDir)}/**)`];
  return {
    permissions: {
      allow: [
        `mcp__${SERVER_NAME}`, 'Skill', 'Agent', 'web_search',
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
        // The broker server's journal (the order gate reads it).
        `Edit(${abs(journalDir)}/**)`,
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

function planQwen({ root, home, broker }) {
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
      { file, content: `${JSON.stringify(mergeQwenSettings(settings, root), null, 2)}\n` },
      { file: path.join(root, 'workspace', '.qwen', 'settings.json'), content: `${JSON.stringify(qwenWorkspaceSettings(root, home, { journalDir: path.dirname(broker.journalPath) }), null, 2)}\n` },
    ],
    next: [
      `qwen extensions link ${path.join(root, 'qwen-extension')}   (link, not install: the extension uses symlinks to this checkout)`,
      credentialsStep(broker),
      `Run trading sessions from ${path.join(root, 'workspace')}; its .qwen/settings.json holds the autonomous-run allowlist.`,
    ],
  };
}

function credentialsStep(broker) {
  return `Put the ${broker.name} server's settings in ~/.futures-trading-harness/.env (the gateway loads it): ${broker.env.join(', ') || 'see its repo'}.`;
}

function planClaude({ root, home, broker }) {
  const rulesDir = path.join(root, 'rules', 'trading');
  const writes = fs.readdirSync(rulesDir).filter(f => f.endsWith('.md')).sort()
    .map(f => ({ file: path.join(home, '.claude', 'rules', 'trading', f), content: fs.readFileSync(path.join(rulesDir, f), 'utf8') }));
  const mcp = [`claude mcp add ${SERVER_NAME} --scope user`, '--', 'node', ...gatewayArgs(root).map(a => JSON.stringify(a))].join(' ');
  return {
    writes,
    next: [
      `/plugin marketplace add ${root}`,
      '/plugin install futures-trading-harness@futures-trading-harness',
      mcp,
      credentialsStep(broker),
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
  forwardedEnv,
  planBrokerEntry,
  mergeQwenSettings,
  qwenWorkspaceSettings,
  stripJsonComments,
  planClaude,
  planCodex,
  planQwen,
  applyPlan,
};
