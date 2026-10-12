'use strict';

// The opencode adapter: the generated workspace/opencode.json (roles, permissions, MCP servers) and
// what the runner adds per run. `decide` evaluates rules as opencode 1.x does: every rule's
// permission and pattern are wildcards (* any text, ? one character), and the last match wins.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const oc = require('../../scripts/lib/opencode');
const { loadAgents, expectedFiles } = require('../../scripts/lib/harness-sync');
const { TOOLS: BROKER_TOOLS } = require('../../scripts/lib/broker/interface');

const ROOT = path.resolve(__dirname, '..', '..');
const agents = loadAgents(ROOT);
const roles = agents.map(a => a.name);
const config = JSON.parse(expectedFiles(ROOT)['workspace/opencode.json']);
const ORDER_TOOLS = Object.entries(BROKER_TOOLS).filter(([, t]) => t.role === 'order').map(([n]) => `broker_${n}`);

const wildcard = (text, pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's').test(text);
/** A permission map as opencode's ordered rules ({ "*": x } for a plain action). */
const rules = map => Object.entries(map).flatMap(([permission, v]) => Object.entries(typeof v === 'string' ? { '*': v } : v).map(([pattern, action]) => ({ permission, pattern, action })));
/** opencode's decision: the last rule matching both (no match: undefined, which a headless run refuses). */
const decide = (ruleList, permission, pattern = '*') => {
  const hit = ruleList.filter(r => wildcard(permission, r.permission) && wildcard(pattern, r.pattern)).pop();
  return hit ? hit.action : undefined;
};
/** Merging configs as opencode does: objects key by key (a known key keeps its place), anything else replaced. */
const merge = (a, b) => {
  if (!a || typeof a !== 'object' || !b || typeof b !== 'object') return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v);
  return out;
};

test('the generated config: the harness\'s two MCP servers from FTH_ROOT, its skills, and no provider or model', () => {
  assert.deepStrictEqual(config.mcp.broker, { type: 'local', command: ['node', '{env:FTH_ROOT}/scripts/mcp-gateway.js'], enabled: true, timeout: 60000 });
  assert.deepStrictEqual(config.mcp.harness, { type: 'local', command: ['node', '{env:FTH_ROOT}/scripts/harness-tools-mcp.js'], enabled: true, timeout: 60000 });
  assert.deepStrictEqual(config.skills, { paths: ['{env:FTH_ROOT}/skills'] });
  for (const k of ['provider', 'model', 'small_model', 'plugin', 'instructions']) assert.ok(!(k in config), `no ${k}: the user's own opencode config holds it`);
  assert.strictEqual(config.autoupdate, false);
  assert.strictEqual(config.share, 'disabled');
  // Nothing machine-specific: no absolute path, no URL but the schema's.
  const text = expectedFiles(ROOT)['workspace/opencode.json'];
  assert.doesNotMatch(text.replace(oc.SCHEMA, ''), /https?:\/\/|\/Users\/|\/home\/|127\.0\.0\.1|localhost/);
  assert.ok(!text.includes(ROOT));
  for (const a of [...oc.BUILTIN_AGENTS, 'build']) assert.deepStrictEqual(config.agent[a], { disable: true }, `${a} disabled`);
  assert.strictEqual(config.default_agent, oc.HEAD_AGENT);
  assert.strictEqual(config.agent[oc.HEAD_AGENT].mode, 'primary');
  // No language servers, formatters or snapshots in a trading run.
  assert.deepStrictEqual([config.lsp, config.formatter, config.snapshot], [false, false, false]);
});

/** The head trader's rules, as opencode builds them: the top-level permission, then the agent's own. */
const headRules = merged => [...rules(merged.permission), ...rules(merged.agent[oc.HEAD_AGENT].permission)];

test('the main session gets what the other adapters allow an autonomous run: no shell, no edits, no fetch', () => {
  const session = headRules(config);
  for (const p of ['bash', 'edit', 'webfetch', 'question', 'lsp', 'codesearch', 'doom_loop', 'some_future_tool']) assert.strictEqual(decide(session, p), 'deny', p);
  for (const p of ['skill', 'websearch', 'todowrite', 'glob', 'grep', 'list']) assert.strictEqual(decide(session, p), 'allow', p);
  // The broker (orders through the gateway's gate) and the harness tools.
  for (const t of [...ORDER_TOOLS, 'broker_get_bars', 'harness_strategies_scan', 'harness_blackouts_list']) assert.strictEqual(decide(session, t), 'allow', t);
  // Reading: anything inside the project but a .env; outside it, nothing (the runner adds its directories).
  assert.strictEqual(decide(session, 'read', 'strategies/orb/STRATEGY.md'), 'allow');
  for (const f of ['.env', 'workspace/.env', '../x/.env.local']) assert.strictEqual(decide(session, 'read', f), 'deny', f);
  assert.strictEqual(decide(session, 'external_directory', '/home/u/.ssh/*'), 'deny');
  // The harness's roles by name; opencode's own and any other agent are refused.
  for (const r of roles) assert.strictEqual(decide(session, 'task', r), 'allow', r);
  for (const r of ['general', 'explore', 'build', 'evil']) assert.strictEqual(decide(session, 'task', r), 'deny', r);
  // Everything denied first, so no earlier rule (opencode's defaults, the user's global config) survives.
  assert.deepStrictEqual(Object.entries(config.permission)[0], ['*', 'deny']);
  assert.deepStrictEqual(Object.entries(config.agent[oc.HEAD_AGENT].permission)[0], ['*', 'deny']);
});

test('a hostile user config (everything allowed, its own default agent, rules for opencode\'s agents and the harness\'s) changes nothing', () => {
  const user = {
    default_agent: 'build',
    permission: { '*': 'allow', bash: 'allow', webfetch: 'allow', broker_place_order: 'allow' },
    agent: {
      build: { permission: { '*': 'allow', bash: 'allow' } },
      [oc.HEAD_AGENT]: { permission: { '*': 'allow', bash: 'allow', edit: 'allow', task: 'allow' } },
      'risk-manager': { permission: { '*': 'allow', bash: 'allow', task: 'allow', broker_place_order: 'allow' } },
    },
  };
  const run = oc.runConfig({ root: '/r', dataDir: '/r/bars', stateDir: '/s', agents });
  // The user's config is loaded first; the project's and the run's after it (or the run's alone).
  for (const merged of [merge(merge(user, config), run), merge(user, run)]) {
    assert.strictEqual(merged.default_agent, oc.HEAD_AGENT);
    assert.strictEqual(merged.agent.build.disable, true);
    const head = headRules(merged);
    for (const p of ['bash', 'edit', 'webfetch']) assert.strictEqual(decide(head, p), 'deny', p);
    assert.strictEqual(decide(head, 'task', 'general'), 'deny');
    const risk = [...rules(merged.permission), ...rules(merged.agent['risk-manager'].permission)];
    for (const p of ['bash', 'task', 'broker_place_order']) assert.strictEqual(decide(risk, p), 'deny', `risk-manager: ${p}`);
    assert.strictEqual(decide(risk, 'broker_get_account_snapshot'), 'allow');
  }
});

test('badExtraArgs: only a model variant and logging; approvals, another directory, agent, server or session are refused', () => {
  assert.deepStrictEqual(oc.badExtraArgs(['--variant', 'high', '--thinking', '--log-level=DEBUG', '--print-logs']), []);
  for (const a of [['--auto'], ['--yolo'], ['--dangerously-skip-permissions'], ['--attach', 'http://x'], ['--dir', '/x'], ['--agent', 'build'], ['-c'], ['--session', 's'], ['--share'], ['--port', '1'], ['--thinking=false'], ['--variant'], ['--variant', '--auto']]) {
    assert.ok(oc.badExtraArgs(a).length > 0, a.join(' '));
  }
});

test('roles: everything denied, then their own tools; only trade-executor holds order tools', () => {
  assert.deepStrictEqual(Object.keys(config.agent).sort(), [...oc.DISABLED_AGENTS, oc.HEAD_AGENT, ...roles].sort());
  for (const a of agents) {
    const entry = config.agent[a.name];
    assert.strictEqual(entry.mode, 'subagent');
    assert.strictEqual(entry.description, a.description);
    assert.ok(entry.prompt.includes(a.body.slice(0, 200)), `${a.name}: its instructions are the prompt`);
    assert.deepStrictEqual(Object.entries(entry.permission)[0], ['*', 'deny'], `${a.name}: denied first`);
    // A role's rules come after the session's: they decide alone.
    const role = [...rules(config.permission), ...rules(entry.permission)];
    for (const p of ['bash', 'edit', 'webfetch', 'task', 'question']) assert.strictEqual(decide(role, p), 'deny', `${a.name}: ${p}`);
    for (const t of ORDER_TOOLS) assert.strictEqual(decide(role, t), a.name === 'trade-executor' ? 'allow' : 'deny', `${a.name}: ${t}`);
    // Its own MCP tools and nothing else of either server.
    for (const t of Object.keys(BROKER_TOOLS)) assert.strictEqual(decide(role, `broker_${t}`), a.tools.includes(`mcp__broker__${t}`) ? 'allow' : 'deny', `${a.name}: broker_${t}`);
    assert.strictEqual(decide(role, 'harness_blackouts_add'), a.tools.includes('mcp__harness__blackouts_add') ? 'allow' : 'deny');
    assert.strictEqual(decide(role, 'read', 'x/.env'), 'deny');
    assert.strictEqual(decide(role, 'read', 'strategies/orb/STRATEGY.md'), a.tools.includes('Read') ? 'allow' : 'deny');
  }
  // A role with a shell and edits in its Claude tools gets neither here (strategy-researcher).
  const researcher = rules(config.agent['strategy-researcher'].permission);
  assert.ok(agents.find(a => a.name === 'strategy-researcher').tools.includes('Bash'));
  assert.strictEqual(decide(researcher, 'bash'), 'deny');
  assert.strictEqual(decide(researcher, 'edit', 'strategies/x/STRATEGY.md'), 'deny');
});

test('permissionKeys: Claude tool names to opencode keys; a tool it does not know is an error', () => {
  assert.deepStrictEqual(oc.permissionKeys(['Read', 'Skill', 'mcp__broker__get_bars', 'mcp__harness__mtf_read', 'WebSearch']), ['read', 'list', 'skill', 'broker_get_bars', 'harness_mtf_read', 'websearch']);
  assert.deepStrictEqual(oc.permissionKeys(['Bash', 'Write', 'Edit', 'WebFetch']), []);
  assert.throws(() => oc.permissionKeys(['NotebookEdit']), /no opencode permission/);
  assert.throws(() => oc.permissionKeys(['mcp__github__create_issue']), /no opencode permission/);
});

test('the run\'s config: the session locked down again, and the runner\'s directories readable by the session and every role', () => {
  const run = oc.runConfig({ root: '/r', dataDir: '/data/bars', stateDir: '/s', agents });
  const dirs = ['/r/*', '/data/bars/*', '/s/logs/*', '/s/bars-scratch/*'];
  // Merged over the project file, and alone (a directory with no opencode.json, or another one).
  for (const merged of [merge(config, run), run]) {
    const session = headRules(merged);
    for (const d of dirs) assert.strictEqual(decide(session, 'external_directory', d.replace('*', 'a/b/*')), 'allow', d);
    for (const d of ['/s/*', '/s/.env', '/home/u/.ssh/*']) assert.strictEqual(decide(session, 'external_directory', d), 'deny', d);
    assert.strictEqual(decide(session, 'bash'), 'deny');
    assert.strictEqual(decide(session, 'edit', 'x'), 'deny');
    assert.strictEqual(decide(session, 'read', '../../s/.env'), 'deny');
  }
  // Each role, over the project file and alone: the same tools, and the runner's directories.
  for (const merged of [merge(config, run), run]) {
    for (const a of agents) {
      const r = a.name;
      const role = [...rules(merged.permission), ...rules(merged.agent[r].permission)];
      assert.strictEqual(merged.agent[r].mode, 'subagent');
      for (const d of ['/data/bars/*', '/r/strategies/orb/*', '/s/logs/*', '/s/bars-scratch/*']) assert.strictEqual(decide(role, 'external_directory', d), 'allow', `${r}: ${d}`);
      for (const d of ['/home/u/*', '/s/*', '/home/u/.ssh/*']) assert.strictEqual(decide(role, 'external_directory', d), 'deny', `${r}: ${d}`);
      assert.strictEqual(decide(role, 'read', '../../s/.env'), 'deny', r);
      for (const p of ['bash', 'edit', 'task', 'webfetch']) assert.strictEqual(decide(role, p), 'deny', `${r}: ${p}`);
      for (const t of ORDER_TOOLS) assert.strictEqual(decide(role, t), r === 'trade-executor' ? 'allow' : 'deny', `${r}: ${t}`);
      for (const k of ['read', 'glob', 'grep', 'list']) assert.strictEqual(decide(role, k, 'x'), a.tools.some(t => ({ read: 'Read', list: 'Read', glob: 'Glob', grep: 'Grep' })[k] === t) ? 'allow' : 'deny', `${r}: ${k}`);
    }
  }
});

test('runEnv: no update check, sharing, Claude Code or external skills; PWD is the run\'s directory; unsafe variables dropped', () => {
  const env = oc.runEnv({ PATH: '/bin', PWD: '/repo', OPENCODE_PERMISSION: '{"bash":"allow"}', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_CONFIG_CONTENT: '{"permission":"allow"}', OPENCODE_CONFIG_DIR: '/u/oc', OPENCODE_CONFIG: '/u/oc.json' },
    { root: '/r', dataDir: '/r/bars', stateDir: '/s', agents, dir: '/r/workspace' });
  assert.strictEqual(env.PWD, '/r/workspace');
  for (const k of ['OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_SHARE', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_EXTERNAL_SKILLS', 'OPENCODE_DISABLE_LSP_DOWNLOAD']) assert.strictEqual(env[k], '1', k);
  assert.ok(!('OPENCODE_PERMISSION' in env) && !('OPENCODE_DISABLE_PROJECT_CONFIG' in env) && !('OPENCODE_CONFIG_DIR' in env));
  assert.deepStrictEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT), oc.runConfig({ root: '/r', dataDir: '/r/bars', stateDir: '/s', agents }));
  // The user's own config file (their provider) stays.
  assert.strictEqual(env.OPENCODE_CONFIG, '/u/oc.json');
  assert.strictEqual(env.PATH, '/bin');
});

test('denyTools: the tools denied for the session, the head trader and every role, trade-executor included, after everything else', () => {
  const base = oc.runEnv({}, { root: '/r', dataDir: '/r/bars', stateDir: '/s', agents, dir: '/r/workspace' });
  const env = oc.denyTools(base, ORDER_TOOLS);
  const merged = merge(config, JSON.parse(env.OPENCODE_CONFIG_CONTENT));
  for (const r of roles) {
    const role = [...rules(merged.permission), ...rules(merged.agent[r].permission)];
    for (const t of ORDER_TOOLS) assert.strictEqual(decide(role, t), 'deny', `${r}: ${t}`);
    assert.strictEqual(decide(role, 'external_directory', '/r/bars/*'), 'allow', `${r}: keeps the run's directories`);
  }
  for (const t of ORDER_TOOLS) assert.strictEqual(decide(headRules(merged), t), 'deny');
  assert.strictEqual(decide(headRules(merged), 'broker_get_bars'), 'allow');
  assert.strictEqual(merged.agent.build.disable, true, 'disabled agents stay disabled');
});

test('the committed workspace/opencode.json is the generated one', () => {
  assert.strictEqual(fs.readFileSync(path.join(ROOT, 'workspace', 'opencode.json'), 'utf8'), expectedFiles(ROOT)['workspace/opencode.json']);
});
