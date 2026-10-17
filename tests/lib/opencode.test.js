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
  // (The roles' embedded skills are the canonical skills, shipped as they are: their example paths are placeholders.)
  const parsed = JSON.parse(expectedFiles(ROOT)['workspace/opencode.json']);
  for (const a of Object.values(parsed.agent)) if (a.prompt) a.prompt = a.prompt.split('\n## Your skills (already loaded)')[0];
  const text = JSON.stringify(parsed);
  // The whole file, embedded skills included, never names this machine's checkout.
  assert.ok(!expectedFiles(ROOT)['workspace/opencode.json'].includes(ROOT));
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
  for (const p of ['websearch', 'todowrite', 'glob', 'grep', 'list']) assert.strictEqual(decide(session, p), 'allow', p);
  // Its skills: in index mode (the committed file) embedded, any other through skill_lookup, no skill tool (head-prompt.js).
  assert.strictEqual(decide(session, 'skill'), 'deny');
  assert.strictEqual(decide(session, 'harness_skill_lookup'), 'allow');
  // The broker (orders through the gateway's gate) and the harness tools.
  for (const t of [...ORDER_TOOLS.filter(t => t !== 'broker_place_order'), 'broker_get_bars', 'harness_strategies_scan', 'harness_blackouts_list']) assert.strictEqual(decide(session, t), 'allow', t);
  // An entry is the trade-executor's alone: the main session (the head trader) can't place one; it keeps the reads
  // and the risk-reducing calls (close, partial close, cancel, modify).
  assert.strictEqual(decide(session, 'broker_place_order'), 'deny');
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
    assert.strictEqual(decide(head, 'broker_place_order'), 'deny', 'a hostile config can\'t give the head trader entries');
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
    // Its instructions are the prompt: its body (the skills sentence pointing below) and its skills, in the default
    // mode (role-skills.js: index, its core embedded and its index listed).
    const skillDocs = require('../../scripts/lib/harness-sync').agentSkills(ROOT, a);
    const RS = require('../../scripts/lib/role-skills');
    assert.strictEqual(entry.prompt, oc.agentPrompt({ ...a, skillDocs, skillPlan: RS.skillPlan(a, skillDocs, RS.DEFAULT_MODE) }), `${a.name}: its instructions are the prompt`);
    assert.ok(entry.prompt.includes(a.body.slice(-200)), `${a.name}: its body in full`);
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

test('each role\'s prompt carries its declared skills in full (full mode), so a role never decides without them', () => {
  const { agentSkills } = require('../../scripts/lib/harness-sync');
  // Full mode, on request (FTH_ROLE_SKILLS=full; the committed file is index, the default: role-skills.test.js).
  const generated = JSON.parse(expectedFiles(ROOT, { mode: 'full' })['workspace/opencode.json']);
  for (const a of agents) {
    assert.ok(a.skills.length > 0, `agents/${a.file} declares its skills (frontmatter role-skills)`);
    // The declared list is the one its body tells other harnesses to load: they can't drift apart.
    const said = /Load the\s+skills?\s+([^.]*)\./.exec(a.body.replace(/\s+/g, ' '));
    assert.ok(said, `agents/${a.file} says which skills to load`);
    // Its core (role-skills) and its index (role-index) together: the body loads them all for every other adapter.
    assert.deepStrictEqual([...said[1].matchAll(/`([a-z-]+)`/g)].map(m => m[1]).sort(), [...a.skills, ...a.index].sort(), `agents/${a.file}`);
    const prompt = generated.agent[a.name].prompt;
    assert.doesNotMatch(prompt, /Look up as needed/, `${a.name}: full mode embeds its index skills too`);
    // The role's own text first, its "Load the skills" sentence saying they are below: nothing tells it to load them again.
    assert.ok(prompt.startsWith(a.body.slice(0, 40)), `${a.name}: the role's own text first`);
    assert.doesNotMatch(prompt, /Load the\s+skills?\b/, `${a.name}`);
    assert.match(prompt, /Your skills `[a-z-]+`[^.]* are below, already loaded/, `${a.name}`);
    assert.match(prompt, /## Your skills \(already loaded\)[^]*don't load them again with the skill tool/);
    for (const d of agentSkills(ROOT, a)) {
      assert.ok(prompt.includes(`<skill name="${d.name}">\n${d.body}\n</skill>`), `${a.name}: ${d.name} in full`);
    }
  }
  // The head trader's prompt is opencode's own plus workspace/AGENTS.md: it loads its skills with the tool (the gate checks).
  assert.strictEqual(generated.agent[oc.HEAD_AGENT].prompt, undefined);
  // A role without skills keeps its body alone; an unknown skill is an error, never a silent gap.
  assert.strictEqual(oc.agentPrompt({ body: 'Body.' }), 'Body.\n');
  assert.throws(() => agentSkills(ROOT, { file: 'x.md', skills: ['no-such-skill'] }), /skill "no-such-skill" has no skills\/no-such-skill\/SKILL\.md/);
});

test('runEnv strips opencode\'s background subagents: a role must report in the foreground (roles-ran.js)', () => {
  const env = oc.runEnv({ OPENCODE_EXPERIMENTAL: 'true', OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'true', KEEP: '1' }, { root: '/r', dataDir: '/d', stateDir: '/s', agents, dir: '/r/workspace' });
  assert.strictEqual(env.OPENCODE_EXPERIMENTAL, undefined);
  assert.strictEqual(env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS, undefined);
  assert.strictEqual(env.KEEP, '1');
});

test('a run\'s denied roles and the head trader\'s place_order deny hold through the merge with the project config and a hostile user config', () => {
  const run = oc.runConfig({ root: '/r', dataDir: '/d', stateDir: '/s', agents, deniedRoles: ['market-structure-analyst', 'strategy-researcher'] });
  const user = { permission: { broker_place_order: 'allow', task: { 'market-structure-analyst': 'allow' } }, agent: { [oc.HEAD_AGENT]: { permission: { broker_place_order: 'allow', task: { 'strategy-researcher': 'allow' } } } } };
  for (const merged of [merge(config, run), merge(merge(user, config), run), merge(user, run)]) {
    // The denials hold whatever the other configs say (a hostile one can only deny more, never allow).
    const head = headRules(merged);
    assert.strictEqual(decide(head, 'task', 'market-structure-analyst'), 'deny');
    assert.strictEqual(decide(head, 'task', 'strategy-researcher'), 'deny');
    assert.strictEqual(decide(head, 'broker_place_order'), 'deny');
    assert.strictEqual(decide([...rules(merged.permission), ...rules(merged.agent['trade-executor'].permission)], 'broker_place_order'), 'allow');
  }
  // Accepted, pinned: a user config that names the head trader's own broker tools (the harness's agent) leaves them
  // denied after the merge (opencode appends the run's '*' after the user's keys), the risk-reducing ones too; the
  // trade-executor keeps them by its own permissions, and the runner flattens and trails without the model.
  const named = { agent: { [oc.HEAD_AGENT]: { permission: { broker_close_position: 'allow', broker_cancel_order: 'allow', broker_place_order: 'allow' } } } };
  const hm = merge(merge(named, config), run);
  assert.strictEqual(decide(headRules(hm), 'broker_place_order'), 'deny');
  const exec = [...rules(hm.permission), ...rules(hm.agent['trade-executor'].permission)];
  for (const t of ['broker_close_position', 'broker_cancel_order', 'broker_place_order']) assert.strictEqual(decide(exec, t), 'allow', `trade-executor: ${t}`);
  // As the runner runs it (the project config, then the run's): the other roles and the risk-reducing calls stay allowed.
  const head = headRules(merge(config, run));
  for (const r of ['trend-momentum-analyst', 'volume-liquidity-analyst', 'risk-manager', 'trade-executor']) assert.strictEqual(decide(head, 'task', r), 'allow', r);
  for (const t of ['broker_close_position', 'broker_cancel_order', 'broker_partial_close_position', 'broker_modify_order', 'broker_get_bars']) assert.strictEqual(decide(head, t), 'allow', t);
});

test('index mode (the default): a role holding skill_lookup, and the head trader, are denied opencode\'s skill tool; the other roles and full mode keep it', () => {
  const full = JSON.parse(expectedFiles(ROOT, { mode: 'full' })['workspace/opencode.json']);
  // A role's skills are in its prompt and behind skill_lookup (any skill): while an agent may use the skill tool,
  // opencode puts every skill's name and description in its system prompt. Without skill_lookup the tool is its only way
  // to a skill its prompt names but doesn't embed.
  const lookup = agents.filter(a => a.tools.includes('mcp__harness__skill_lookup')).map(a => a.name);
  assert.ok(lookup.length > 0 && lookup.length < agents.length, 'both kinds of role exist');
  for (const a of agents) {
    assert.ok(a.tools.includes('Skill'), `${a.name}: its Claude tools hold Skill (the other adapters load its skills with it)`);
    const denied = lookup.includes(a.name);
    assert.strictEqual(oc.deniesSkillTool(a.tools, 'index'), denied, a.name);
    assert.strictEqual(oc.deniesSkillTool(a.tools, 'full'), false, a.name);
    assert.strictEqual(decide([...rules(config.permission), ...rules(config.agent[a.name].permission)], 'skill', 'market-structure'), denied ? 'deny' : 'allow', `index: ${a.name}`);
    assert.strictEqual(decide([...rules(full.permission), ...rules(full.agent[a.name].permission)], 'skill', 'market-structure'), 'allow', `full: ${a.name}`);
    // Nothing in a denied role's prompt sends it to a tool it can't use; the others' prompts are as before.
    if (denied) assert.doesNotMatch(config.agent[a.name].prompt, /skill tool/i, `index: ${a.name}`);
    else assert.match(config.agent[a.name].prompt, /don't load them again with the skill tool/, `index: ${a.name}`);
    assert.match(full.agent[a.name].prompt, /don't load them again with the skill tool/, `full: ${a.name}`);
  }
  // The head trader: in full mode it loads its skills with the tool (skill_lookup is the roles'); in index mode its
  // prompt embeds them and it reads any other with skill_lookup, the skill tool (and its listing) denied.
  assert.strictEqual(decide(headRules(full), 'skill', 'trade-session'), 'allow', 'full: the head trader loads its skills with the tool');
  assert.strictEqual(decide(headRules(full), 'harness_skill_lookup'), 'deny');
  assert.strictEqual(full.permission.skill, 'allow');
  assert.ok(!('prompt' in full.agent[oc.HEAD_AGENT]), 'full: no prompt of its own, as before');
  assert.strictEqual(decide(headRules(config), 'skill', 'trade-session'), 'deny', 'index: no skill tool');
  assert.strictEqual(decide(headRules(config), 'harness_skill_lookup'), 'allow');
  assert.strictEqual(config.permission.skill, 'deny');
  assert.match(config.agent[oc.HEAD_AGENT].prompt, /## Your skills \(already loaded\)/);
  // Index mode changes the two skill keys alone, in their places.
  const sIndex = oc.sessionPermission(roles, [], 'index');
  assert.deepStrictEqual(sIndex, { ...oc.sessionPermission(roles), skill: 'deny', harness_skill_lookup: 'allow' });
  assert.deepStrictEqual(Object.keys(sIndex), Object.keys(oc.sessionPermission(roles)));
  assert.deepStrictEqual(oc.sessionPermission(roles, [], 'full'), oc.sessionPermission(roles));
  // Full mode is the permission set as before: no mode is full mode.
  for (const a of agents) {
    assert.deepStrictEqual(oc.agentPermission(a.tools, 'full'), oc.agentPermission(a.tools), a.name);
    assert.deepStrictEqual(full.agent[a.name].permission, oc.agentPermission(a.tools), a.name);
  }
  // Index mode changes the skill key alone, in its place.
  const tools = agents.find(a => a.name === 'risk-manager').tools;
  assert.deepStrictEqual(oc.agentPermission(tools, 'index'), { ...oc.agentPermission(tools), skill: 'deny' });
  assert.deepStrictEqual(Object.keys(oc.agentPermission(tools, 'index')), Object.keys(oc.agentPermission(tools)));
  // Derived from the tools: skill_lookup alone decides, Skill or not.
  assert.strictEqual(oc.agentPermission(['mcp__harness__skill_lookup'], 'index').skill, 'deny');
  assert.deepStrictEqual(oc.agentPermission(['Read', 'Skill'], 'index'), oc.agentPermission(['Read', 'Skill']));
  assert.ok(!('skill' in oc.agentPermission(['Read'], 'index')));
});

test('index mode: every skill a role\'s prompt names is embedded in it, or reachable by it through skill_lookup or the skill tool', () => {
  const skillNames = new Set(fs.readdirSync(path.join(ROOT, 'skills')).filter(d => fs.existsSync(path.join(ROOT, 'skills', d, 'SKILL.md'))));
  for (const a of agents) {
    const entry = config.agent[a.name];
    const role = [...rules(config.permission), ...rules(entry.permission)];
    const embedded = new Set([...entry.prompt.matchAll(/<skill name="([a-z0-9-]+)">/g)].map(m => m[1]));
    const named = new Set([...entry.prompt.matchAll(/`([a-z0-9-]+)`/g)].map(m => m[1]).filter(s => skillNames.has(s)));
    assert.ok(named.size > 0, a.name);
    for (const s of named) {
      if (embedded.has(s)) continue;
      const reachable = decide(role, 'harness_skill_lookup') === 'allow' || decide(role, 'skill', s) === 'allow';
      assert.ok(reachable, `${a.name}: names \`${s}\`, which it neither embeds nor can read (skill_lookup or the skill tool)`);
    }
  }
});

test('index mode: the trade-executor embeds its skills, is denied the skill tool (no listing of every skill) and reads the others it names with skill_lookup', () => {
  const entry = config.agent['trade-executor'];
  const role = [...rules(config.permission), ...rules(entry.permission)];
  assert.strictEqual(decide(role, 'skill', 'gate-refusals-limits'), 'deny');
  assert.strictEqual(decide(role, 'harness_skill_lookup'), 'allow');
  // gate-refusals (embedded) points to its parts: each one a skill_lookup away, as the prompt says.
  for (const s of ['gate-refusals-limits', 'gate-refusals-cycle']) {
    assert.match(entry.prompt, new RegExp(`\`${s}\``), s);
    assert.ok(!entry.prompt.includes(`<skill name="${s}">`), s);
  }
  assert.match(entry.prompt, /Read them here; others they name: skill_lookup\./);
  // Order tools stay its own; skill_lookup is read-only.
  assert.strictEqual(decide(role, 'broker_place_order'), 'allow');
});

test('the run\'s config denies the skill tool to the roles holding skill_lookup in index mode, the same every run, over the project file and a hostile user config', () => {
  const user = { permission: { skill: 'allow' }, agent: { 'risk-manager': { permission: { skill: 'allow', '*': 'allow' } } } };
  const index = oc.runConfig({ root: '/r', dataDir: '/d', stateDir: '/s', agents, mode: 'index' });
  const full = oc.runConfig({ root: '/r', dataDir: '/d', stateDir: '/s', agents, mode: 'full' });
  // The same mode, the same roles' permissions every cycle, whichever roles a cycle denies the head trader.
  assert.deepStrictEqual(oc.runConfig({ root: '/r', dataDir: '/d', stateDir: '/s', agents, mode: 'index', deniedRoles: ['strategy-researcher'] }).agent['risk-manager'], index.agent['risk-manager']);
  assert.deepStrictEqual(oc.runConfig({ root: '/r', dataDir: '/d', stateDir: '/s', agents }), full, 'no mode: as before (full)');
  for (const merged of [merge(config, index), index, merge(merge(user, config), index), merge(user, index)]) {
    for (const a of agents) assert.strictEqual(decide([...rules(merged.permission), ...rules(merged.agent[a.name].permission)], 'skill', 'x'), a.tools.includes('mcp__harness__skill_lookup') ? 'deny' : 'allow', a.name);
    assert.strictEqual(decide(headRules(merged), 'skill', 'trade-session'), 'deny', 'index: the head trader has no skill tool');
    assert.strictEqual(decide(headRules(merged), 'harness_skill_lookup'), 'allow');
  }
  for (const merged of [full, merge(user, full)]) {
    assert.strictEqual(decide(headRules(merged), 'skill', 'trade-session'), 'allow', 'full: the head trader loads with the tool');
    assert.strictEqual(decide(headRules(merged), 'harness_skill_lookup'), 'deny');
  }
  // A full-mode run over a project file generated for index (the runner's start check refuses that mismatch): the run decides.
  const over = merge(config, full);
  for (const r of roles) assert.strictEqual(decide([...rules(over.permission), ...rules(over.agent[r].permission)], 'skill', 'x'), 'allow', r);
  // runEnv passes the mode through.
  const env = oc.runEnv({}, { root: '/r', dataDir: '/d', stateDir: '/s', agents, dir: '/r/workspace', mode: 'index' });
  assert.deepStrictEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT), index);
});

test('dropInventedTaskId: a task call\'s task_id that names no session (a label, a number, null, an object) is dropped in place; a session id, another tool, or no task_id is left as it is', () => {
  const { dropInventedTaskId } = require('../../scripts/lib/opencode');
  for (const id of ['msa', 'rm1', '', 7, null, {}, ['ses_x']]) {
    const args = { subagent_type: 'risk-manager', prompt: 'p', task_id: id };
    assert.strictEqual(dropInventedTaskId('task', args), true, JSON.stringify(id));
    assert.deepStrictEqual(args, { subagent_type: 'risk-manager', prompt: 'p' }, JSON.stringify(id));
  }
  const resume = { subagent_type: 'risk-manager', task_id: 'ses_eb993c3b1ffekqL45GDgHQpdeZ' };
  assert.strictEqual(dropInventedTaskId('task', resume), false);
  assert.strictEqual(resume.task_id, 'ses_eb993c3b1ffekqL45GDgHQpdeZ');
  const other = { task_id: 'msa' };
  assert.strictEqual(dropInventedTaskId('read', other), false);
  assert.strictEqual(other.task_id, 'msa');
  for (const args of [{ subagent_type: 'risk-manager' }, null, undefined, 'task_id']) assert.strictEqual(dropInventedTaskId('task', args), false);
});

test('stepCap: every role is capped at config/runner.json limits.roleSteps but a role holding an order tool (the trade-executor), in the workspace config and the run config', () => {
  const { stepCap, runConfig } = require('../../scripts/lib/opencode');
  const steps = require('../../scripts/lib/tunables').runner().limits.roleSteps;
  assert.ok(Number.isInteger(steps) && steps > 0);
  assert.deepStrictEqual(stepCap({ tools: ['Read', 'mcp__harness__bar_briefing', 'mcp__broker__get_bars'] }), { steps });
  for (const t of ['place_order', 'modify_order', 'cancel_order', 'close_position', 'partial_close_position']) assert.deepStrictEqual(stepCap({ tools: ['Read', `mcp__broker__${t}`] }), {}, t);
  assert.deepStrictEqual(stepCap({}), { steps });
  const agents = loadAgents(path.resolve(__dirname, '..', '..'));
  const run = runConfig({ root: '/r', dataDir: '/d', stateDir: '/s', agents });
  const ws = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'workspace', 'opencode.json'), 'utf8'));
  for (const a of agents) {
    const want = a.name === 'trade-executor' ? undefined : steps;
    assert.strictEqual(run.agent[a.name].steps, want, `run ${a.name}`);
    assert.strictEqual(ws.agent[a.name].steps, want, `workspace ${a.name}`);
  }
  assert.strictEqual(run.agent[oc.HEAD_AGENT].steps, undefined, 'the head trader is the run: its timeout bounds it');
});

test('toolNameHint: a call opencode sent to its invalid tool names the harness or broker tool meant; anything else is opencode\'s own answer', () => {
  const { toolNameHint, INVALID_TOOL } = require('../../scripts/lib/opencode');
  assert.strictEqual(toolNameHint(INVALID_TOOL, { tool: 'compose_check', error: 'x' }), '[tool-name] "compose_check" is not a tool here: call harness_compose_check with the same arguments.');
  assert.match(toolNameHint(INVALID_TOOL, { tool: 'mcp__harness__bar_briefing' }), /call harness_bar_briefing /);
  assert.match(toolNameHint(INVALID_TOOL, { tool: 'harness.order_plan' }), /call harness_order_plan /);
  assert.match(toolNameHint(INVALID_TOOL, { tool: 'get_account_snapshot' }), /call broker_get_account_snapshot /);
  for (const args of [{ tool: 'nope' }, { tool: 'harness_compose_check' }, {}, null, { tool: 7 }]) assert.strictEqual(toolNameHint(INVALID_TOOL, args), null, JSON.stringify(args));
  assert.strictEqual(toolNameHint('read', { tool: 'compose_check' }), null, 'only the invalid tool');
});

test('opencode\'s invalid tool (its repair of an unknown name) is allowed to the session, the head trader and every role, so the plugin can answer it', () => {
  const { INVALID_TOOL, runConfig } = require('../../scripts/lib/opencode');
  const agents = loadAgents(path.resolve(__dirname, '..', '..'));
  const run = runConfig({ root: '/r', dataDir: '/d', stateDir: '/s', agents });
  assert.strictEqual(run.permission[INVALID_TOOL], 'allow');
  for (const name of [oc.HEAD_AGENT, ...agents.map(a => a.name)]) assert.strictEqual(run.agent[name].permission[INVALID_TOOL], 'allow', name);
  const ws = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'workspace', 'opencode.json'), 'utf8'));
  for (const a of agents) assert.strictEqual(ws.agent[a.name].permission[INVALID_TOOL], 'allow', `workspace ${a.name}`);
});

test('repeatGuard: an identical call that failed is answered with the reminder from the first count on; one that succeeds gets it after its result at each count; per session; order tools and launches untouched', () => {
  const { repeatGuard } = require('../../scripts/lib/opencode');
  let t = 0;
  const clock = () => t;
  const g = repeatGuard([3, 5, 8], clock, 1000);
  // Retries a model step apart (5 s): each identical one after a failure.
  const failing = Array.from({ length: 6 }, () => { t += 5000; return g.before('harness_market_snapshot', { bars: '/workspace/x.json' }, 's1'); });
  assert.deepStrictEqual(failing.map(Boolean), [false, false, true, true, true, true]);
  assert.match(failing[2], /^\[repeat\] You are repeating the exact same tool call with identical arguments/);
  assert.match(failing[3], /^\[repeat\] You have called harness_market_snapshot 4 times in a row with the same arguments\. It will not change/);
  assert.strictEqual(g.before('harness_market_snapshot', { bars: '/right.json' }, 's1'), null, 'new arguments run');
  assert.strictEqual(g.before('harness_market_snapshot', { bars: '/workspace/x.json' }, 's2'), null, 'another session counts its own');
  // Identical calls sent together in one step (moments apart, still running): never taken for failed retries.
  const par = repeatGuard([3, 5, 8], clock, 1000);
  assert.deepStrictEqual([1, 2, 3, 4].map(i => par.before('harness_bar_briefing', { symbol: 'MNQ' }, 'p', `c${i}`)), [null, null, null, null]);
  // Two sent together, one returns and one fails: the failed one still counts for the retries that follow.
  const twin = repeatGuard([3, 5, 8], clock, 1000);
  twin.before('harness_market_snapshot', { bars: '/x' }, 'w', 'a');
  twin.before('harness_market_snapshot', { bars: '/x' }, 'w', 'b');
  twin.after('harness_market_snapshot', {}, 'w', 'b');
  t += 5000;
  assert.match(twin.before('harness_market_snapshot', { bars: '/x' }, 'w', 'c'), /^\[repeat\]/, 'a never returned');
  // Succeeding: it always runs; the reminder follows its result at 3, 5 and 8 only. Argument order doesn't matter.
  const ok = repeatGuard([3, 5, 8], clock, 1000);
  const notes = [];
  for (let i = 0; i < 8; i += 1) {
    assert.strictEqual(ok.before('harness_bar_briefing', i % 2 ? { json: true, symbol: 'MNQ' } : { symbol: 'MNQ', json: true }, 's'), null);
    notes.push(ok.after('harness_bar_briefing', {}, 's', null, 'the same briefing'));
  }
  assert.deepStrictEqual(notes.map(n => Boolean(n)), [false, false, true, false, true, false, false, true]);
  assert.match(notes[2], /^\n\n\[repeat\] You are repeating/);
  // A repeat whose answer moved (a poll that learns something): never reminded.
  const moving = repeatGuard([3, 5, 8], clock, 1000);
  const moved = [];
  for (let i = 0; i < 5; i += 1) {
    moving.before('harness_skill_lookup', { skill: 'x' }, 'm');
    moved.push(moving.after('harness_skill_lookup', {}, 'm', null, `answer ${i}`));
  }
  assert.deepStrictEqual(moved, [null, null, null, null, null]);
  // A call recorded without an id still returns when its after hook carries one: never taken for failed.
  const ids = repeatGuard([3, 5, 8], clock, 1000);
  for (let i = 0; i < 4; i += 1) { ids.before('harness_bar_briefing', { symbol: 'MNQ' }, 'i'); t += 5000; ids.after('harness_bar_briefing', {}, 'i', `late-${i}`, `b${i}`); }
  assert.strictEqual(ids.before('harness_bar_briefing', { symbol: 'MNQ' }, 'i'), null);
  // Every broker tool (an order, or a read whose answer moves while an exit fills) and a role launch: never refused,
  // never reminded, even after failing.
  const ord = repeatGuard([3, 5, 8], clock, 1000);
  for (let i = 0; i < 6; i += 1) {
    t += 5000;
    for (const tool of ['broker_close_position', 'broker_get_positions', 'broker_list_open_orders', 'broker_get_account_snapshot', 'task']) assert.strictEqual(ord.before(tool, { contractId: 'MNQ' }, 's'), null, tool);
  }
  assert.strictEqual(ord.after('broker_get_positions', {}, 's', null, 'same'), null);
});

test('deskGate: the head trader\'s compose_check waits until every role FTH_CYCLE_DESK names reported in its session; nothing else is held', () => {
  const { deskGate } = require('../../scripts/lib/opencode');
  const g = deskGate({ FTH_CYCLE_DESK: 'market-structure-analyst,trend-momentum-analyst,volume-liquidity-analyst,risk-manager' });
  assert.match(g.before('harness_compose_check', 'h'), /^\[desk\] compose_check composes the trade from the desk's reports: launch market-structure-analyst, trend-momentum-analyst, volume-liquidity-analyst, risk-manager first/);
  for (const r of ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst']) g.returned('task', { subagent_type: r }, 'h');
  assert.match(g.before('harness_compose_check', 'h'), /launch risk-manager first/);
  g.returned('task', { subagent_type: 'risk-manager' }, 'other');
  assert.match(g.before('harness_compose_check', 'h'), /launch risk-manager first/, 'a report in another session is not this one\'s');
  g.returned('task', { subagent_type: ' risk-manager ' }, 'h');
  assert.strictEqual(g.before('harness_compose_check', 'h'), null, 'the desk reported');
  // Never held: the executor, an exit, a stop, a read, the briefing, another harness tool.
  const fresh = deskGate({ FTH_CYCLE_DESK: 'risk-manager' });
  for (const t of ['task', 'broker_close_position', 'broker_cancel_order', 'broker_modify_order', 'broker_get_positions', 'harness_bar_briefing', 'harness_order_plan', 'compose_check']) assert.strictEqual(fresh.before(t, 'h'), null, t);
  // No desk this cycle (lean, manage-only, paper, all cached, another action): nothing held.
  for (const env of [{}, { FTH_CYCLE_DESK: '' }, { FTH_CYCLE_DESK: ' , ' }, null]) assert.strictEqual(deskGate(env).before('harness_compose_check', 'h'), null, JSON.stringify(env));
  // A role both expected and denied (it can't be launched) is never waited for, so compose never becomes impossible.
  const both = deskGate({ FTH_CYCLE_DESK: 'market-structure-analyst,risk-manager', FTH_DENIED_ROLES: 'market-structure-analyst' });
  assert.match(both.before('harness_compose_check', 'h'), /launch risk-manager first/);
  both.returned('task', { subagent_type: 'risk-manager' }, 'h');
  assert.strictEqual(both.before('harness_compose_check', 'h'), null);
});
