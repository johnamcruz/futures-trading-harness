'use strict';

/**
 * Install helpers per harness target. Plugin-native parts (skills, agents,
 * commands, hooks) are installed by each harness's own plugin/extension
 * command; this module writes what those can't: always-on rules (Claude),
 * the projectx MCP server behind the order gateway with absolute paths, agent
 * roles (Codex), and hooks (Qwen settings). Every write is idempotent and
 * confined to a marked block or keyed entries owned by the harness.
 */

const fs = require('fs');
const path = require('path');
const { loadAgents, codexAgentsTable } = require('./harness-sync');

const MARK_BEGIN = '# >>> futures-trading-harness >>>';
const MARK_END = '# <<< futures-trading-harness <<<';
const PROJECTX_ENV = [
  'PROJECTX_USERNAME', 'PROJECTX_API_KEY', 'PROJECTX_TRADING_ENABLED', 'PROJECTX_ALLOWED_ACCOUNT_IDS',
  'PROJECTX_ALLOWED_SYMBOLS', 'PROJECTX_MAX_ORDER_SIZE', 'PROJECTX_MAX_POSITION_SIZE', 'PROJECTX_MAX_DAILY_LOSS',
  'PROJECTX_JOURNAL_PATH', 'PROJECTX_API_URL', 'PROJECTX_MARKET_HUB_URL',
];

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
    '# Forward credentials and guardrails from the environment that launches Codex.',
    `env_vars = [${PROJECTX_ENV.map(v => JSON.stringify(v)).join(', ')}]`,
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
      `Run trading sessions from ${path.join(root, 'workspace')} so Codex reads workspace/AGENTS.md.`,
    ],
  };
}

function hookCommand(root, id, script, profiles) {
  return `node ${JSON.stringify(path.join(root, 'scripts', 'hooks', 'run-with-flags.js'))} ${id} ${script} ${profiles}`;
}

/** Hooks in settings.json shape, with absolute paths (no plugin root variable outside plugins). */
function settingsHooks(root) {
  const source = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const out = {};
  for (const [event, groups] of Object.entries(source)) {
    out[event] = groups.map(g => ({
      ...g,
      hooks: g.hooks.map(h => {
        const m = /run-with-flags\.js" (\S+) (\S+) (\S+)$/.exec(h.command);
        if (!m) throw new Error(`unexpected hook command in hooks.json: ${h.command}`);
        return { ...h, command: hookCommand(root, m[1], m[2], m[3]) };
      }),
    }));
  }
  return out;
}

const isOurs = (group, root) => (group.hooks || []).some(h => String(h.command || '').includes(path.join(root, 'scripts', 'hooks', 'run-with-flags.js'))
  || /run-with-flags\.js"? (pre|session-start|stop):trading:/.test(String(h.command || '')));

/** Merge harness hooks and the projectx MCP server into a Qwen settings object. */
function mergeQwenSettings(settings, root, projectxEntry) {
  const next = { ...settings };
  next.hooks = { ...(settings.hooks || {}) };
  for (const [event, groups] of Object.entries(settingsHooks(root))) {
    const kept = (next.hooks[event] || []).filter(g => !isOurs(g, root));
    next.hooks[event] = [...kept, ...groups];
  }
  const existing = settings.mcpServers && settings.mcpServers.projectx;
  const ours = { command: 'node', args: gatewayArgs(root, projectxEntry), timeout: 60000 };
  if (existing && !(existing.args || []).some(a => String(a).endsWith('mcp-gateway.js'))) {
    throw new Error('settings.json already has an mcpServers.projectx that does not use the harness gateway; remove it first');
  }
  next.mcpServers = { ...(settings.mcpServers || {}), projectx: { ...(existing || {}), ...ours } };
  return next;
}

function planQwen({ root, home, projectxEntry }) {
  const file = path.join(home, '.qwen', 'settings.json');
  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`${file} is not valid JSON (${err.message}); fix it before installing`, { cause: err });
    }
  }
  return {
    writes: [{ file, content: `${JSON.stringify(mergeQwenSettings(settings, root, projectxEntry), null, 2)}\n` }],
    next: [
      `qwen extensions install ${root}`,
      'Set credentials: qwen extensions settings set futures-trading-harness "TopstepX API key" (and username), or export PROJECTX_* in your shell.',
      `Run trading sessions from ${path.join(root, 'workspace')} so Qwen reads workspace/QWEN.md.`,
    ],
  };
}

function planClaude({ root, home, projectxEntry }) {
  const rulesDir = path.join(root, 'rules', 'trading');
  const writes = fs.readdirSync(rulesDir).filter(f => f.endsWith('.md')).sort()
    .map(f => ({ file: path.join(home, '.claude', 'rules', 'trading', f), content: fs.readFileSync(path.join(rulesDir, f), 'utf8') }));
  const mcp = ['claude mcp add projectx --scope user', ...PROJECTX_ENV.slice(0, 3).map(v => `--env ${v}=...`), '--', 'node', ...gatewayArgs(root, projectxEntry).map(a => JSON.stringify(a))].join(' ');
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
    if (fs.existsSync(w.file)) fs.copyFileSync(w.file, `${w.file}.fth-backup`);
    fs.writeFileSync(w.file, w.content);
  }
}

module.exports = {
  MARK_BEGIN,
  MARK_END,
  TARGETS,
  upsertBlock,
  codexConfigBlock,
  settingsHooks,
  mergeQwenSettings,
  planClaude,
  planCodex,
  planQwen,
  applyPlan,
};
