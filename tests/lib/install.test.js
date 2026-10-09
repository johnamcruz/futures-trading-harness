'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { upsertBlock, MARK_BEGIN, MARK_END, codexConfigBlock, mergeQwenSettings, qwenWorkspaceSettings, planCodex, planQwen, planClaude, applyPlan, planBrokerEntry } = require('../../scripts/lib/install');
const { activeBroker } = require('../../scripts/lib/broker/config');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const ENTRY = '/opt/projectx-mcp/dist/index.js';
const BROKER = activeBroker({ FTH_HOME: tmpDir() });

test('upsertBlock appends once and replaces in place', () => {
  const once = upsertBlock('model = "x"\n', 'a = 1');
  assert.match(once, /^model = "x"\n\n# >>> futures-trading-harness >>>\na = 1\n# <<< futures-trading-harness <<<\n$/);
  const twice = upsertBlock(`${once}tail = 2\n`, 'a = 2');
  assert.strictEqual(twice.split(MARK_BEGIN).length, 2);
  assert.match(twice, /a = 2\n# <<< futures-trading-harness <<<\ntail = 2/);
  assert.throws(() => upsertBlock(`${MARK_BEGIN}\nx\n`, 'a'), /unbalanced/);
  assert.strictEqual(upsertBlock('', 'a').startsWith(MARK_BEGIN), true);
  assert.ok(MARK_END);
});

test('codex block wires the gateway and every agent role', () => {
  const block = codexConfigBlock(ROOT, BROKER);
  assert.match(block, /\[mcp_servers\.broker\]/);
  // The gateway alone: it starts the server named in the broker config.
  assert.ok(block.includes(`args = [${JSON.stringify(path.join(ROOT, 'scripts', 'mcp-gateway.js'))}]`));
  // The broker server's variables (from the broker config) and the harness's are forwarded.
  assert.match(block, /"PROJECTX_API_KEY"/);
  assert.match(block, /"PROJECTX_MCP_ENTRY"/);
  assert.match(block, /"FTH_BROKER"/);
  assert.match(block, /\[agents\.trade_executor\]/);
  assert.match(block, /^default_tools_approval_mode = "approve"$/m);
  assert.match(block, /"FTH_KILL_SWITCH_FILE"/);
  assert.match(block, /config_file = ".*\/\.codex\/agents\/trade-executor\.toml"/);
});

test('codex refuses to clobber a user-defined broker server', () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.broker]\ncommand = "node"\n');
  assert.throws(() => planCodex({ root: ROOT, home, broker: BROKER }), /already defines/);
});

test('qwen settings merge is idempotent, keeps user entries, and removes old harness hooks and the old projectx gateway', () => {
  const oldHarnessHook = { matcher: 'mcp__.*projectx.*__place_order', hooks: [{ type: 'command', command: 'node "/x/scripts/hooks/run-with-flags.js" pre:trading:order-gate scripts/hooks/trading-order-gate.js minimal' }] };
  const user = {
    hooks: { PreToolUse: [{ matcher: 'write_file', hooks: [{ type: 'command', command: 'echo user' }] }, oldHarnessHook] },
    mcpServers: { other: { command: 'x' }, projectx: { command: 'node', args: ['/x/scripts/mcp-gateway.js', '--', 'node', ENTRY] } },
  };
  const once = mergeQwenSettings(user, ROOT);
  const twice = mergeQwenSettings(once, ROOT);
  assert.deepStrictEqual(twice, once);
  assert.deepStrictEqual(once.hooks.PreToolUse.map(g => g.hooks[0].command), ['echo user']);
  assert.deepStrictEqual(once.mcpServers.other, { command: 'x' });
  assert.ok(once.mcpServers.broker.args[0].endsWith('mcp-gateway.js'));
  assert.strictEqual(once.mcpServers.projectx, undefined, 'the old gateway entry is replaced');
  assert.throws(() => mergeQwenSettings({ mcpServers: { broker: { command: 'node', args: ['/x/index.js'] } } }, ROOT), /does not use the harness gateway/);
  // A projectx server of the user's own (not the harness gateway) is kept.
  assert.ok(mergeQwenSettings({ mcpServers: { projectx: { command: 'node', args: ['/x/index.js'] } } }, ROOT).mcpServers.projectx);
});

test('qwen workspace permissions allow harness scripts and deny edits to the harness and its state', () => {
  const p = qwenWorkspaceSettings('/fth', '/home/u', { journal: '/home/u/.projectx-mcp/journal.jsonl' }).permissions;
  // The skills' scripts (multi-timeframe read, prop status) and the runner's logs are allowed; credentials are not.
  assert.ok(p.allow.includes('Bash(node /fth/scripts/mtf.js *)') && p.allow.includes('Bash(node /fth/scripts/combine.js status *)'));
  assert.ok(p.allow.includes('Read(//home/u/.futures-trading-harness/logs/**)'));
  assert.ok(p.deny.includes('Read(//home/u/.futures-trading-harness/.env)'));
  assert.ok(p.allow.includes('mcp__broker'));
  assert.ok(p.allow.includes('Bash(node /fth/scripts/strategies.js *)'));
  assert.ok(p.allow.includes('Edit(//tmp/fth/**)'));
  assert.ok(p.allow.includes('Read(//fth/**)') && p.allow.includes('Read(//home/u/.futures-trading-harness/bars/**)'));
  assert.ok(p.allow.includes('WebFetch(bls.gov)'));
  assert.ok(!p.allow.some(r => ['Bash', 'Edit', 'Read', 'WebFetch'].includes(r)), 'no unscoped tools');
  for (const rule of ['Edit(//fth/**)', 'Edit(//home/u/.futures-trading-harness/**)', 'Edit(//home/u/.projectx-mcp/journal.jsonl)', 'Edit(//home/u/.qwen/**)',
    'Read(//proc/**)', 'Read(//home/u/.claude.json)', 'Read(//fth/**/.env)']) assert.ok(p.deny.includes(rule), rule);
});

test('plans write to the right files and backups are made', () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, '.qwen'));
  fs.writeFileSync(path.join(home, '.qwen', 'settings.json'), '{"theme":"dark"}');
  const qwenPlan = planQwen({ root: ROOT, home, broker: BROKER });
  qwenPlan.writes = qwenPlan.writes.filter(w => w.file.startsWith(home)); // don't write into the repo
  applyPlan(qwenPlan);
  applyPlan(qwenPlan);
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.qwen', 'settings.json'), 'utf8'));
  assert.strictEqual(settings.theme, 'dark');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, '.qwen', 'settings.json.fth-backup'), 'utf8')), { theme: 'dark' }, 'first backup is kept');
  applyPlan(planClaude({ root: ROOT, home, broker: BROKER }));
  assert.ok(fs.existsSync(path.join(home, '.claude', 'rules', 'trading', 'risk-management.md')));
  applyPlan(planCodex({ root: ROOT, home, broker: BROKER }));
  assert.match(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), /mcp_servers\.broker/);
  fs.writeFileSync(path.join(home, '.qwen', 'settings.json'), '{bad');
  assert.throws(() => planQwen({ root: ROOT, home, broker: BROKER }), /not valid JSON/);
});

test('CLI validates arguments and supports --dry-run', () => {
  const cli = path.join(ROOT, 'scripts', 'install.js');
  const home = tmpDir();
  const bad = spawnSync(process.execPath, [cli, '--target', 'cursor', '--entry', ENTRY], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  const dry = spawnSync(process.execPath, [cli, '--target', 'all', '--entry', ENTRY, '--dry-run', '--home', home], { encoding: 'utf8', env: { ...process.env, FTH_HOME: home } });
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /would write .*brokers\.json \(broker topstepx: \/opt\/projectx-mcp\/dist\/index\.js\)/);
  assert.match(dry.stdout, /would write .*config\.toml/);
  assert.deepStrictEqual(fs.readdirSync(home), []);
  const old = spawnSync(process.execPath, [cli, '--target', 'all', '--projectx', ENTRY, '--dry-run', '--home', home], { encoding: 'utf8', env: { ...process.env, FTH_HOME: home } });
  assert.strictEqual(old.status, 1);
  assert.match(old.stderr, /--projectx is gone: .*--entry/);
  // --entry goes where the harness reads it: <FTH_HOME>/brokers.json.
  const state = path.join(home, 'state');
  const wrote = spawnSync(process.execPath, [cli, '--target', 'claude', '--entry', ENTRY, '--home', home], { encoding: 'utf8', env: { ...process.env, FTH_HOME: state } });
  assert.strictEqual(wrote.status, 0, wrote.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(state, 'brokers.json'), 'utf8')).brokers.topstepx.entry, ENTRY);
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home);
  const unknown = spawnSync(process.execPath, [cli, '--target', 'all', '--broker', 'nope', '--dry-run', '--home', home], { encoding: 'utf8', env: { ...process.env, FTH_HOME: home } });
  assert.strictEqual(unknown.status, 1);
  assert.match(unknown.stderr, /unknown broker "nope"/);
});

test('--entry records the server in your brokers.json and keeps the rest of it', () => {
  const home = tmpDir();
  assert.strictEqual(planBrokerEntry({ home, brokerName: 'topstepx', entry: null }), null);
  const dir = path.join(home, '.futures-trading-harness');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'brokers.json'), JSON.stringify({ broker: 'other', brokers: { other: { command: ['o'] } } }));
  const w = planBrokerEntry({ home, brokerName: 'topstepx', entry: ENTRY });
  assert.deepStrictEqual(JSON.parse(w.content), { broker: 'other', brokers: { other: { command: ['o'] }, topstepx: { entry: ENTRY } } });
});

test('Qwen settings with comments are read; a file the installer created is not later backed up as the original', () => {
  const { stripJsonComments } = require('../../scripts/lib/install');
  assert.deepStrictEqual(JSON.parse(stripJsonComments('{\n  // model\n  "model": "qwen", /* x */ "url": "http://a//b"\n}')), { model: 'qwen', url: 'http://a//b' });
  const dir = tmpDir();
  const file = path.join(dir, 'x', 'settings.json');
  applyPlan({ writes: [{ file, content: '1' }] });
  applyPlan({ writes: [{ file, content: '2' }] });
  assert.strictEqual(fs.existsSync(`${file}.fth-backup`), false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '2');
});

test('the Qwen allowlist follows the configured bar and state directories', () => {
  const p = qwenWorkspaceSettings('/fth', '/home/u', { dataDir: '/data/bars', stateDir: '/srv/fth' }).permissions;
  assert.ok(p.allow.includes('Read(//data/bars/**)'));
  assert.ok(p.deny.includes('Edit(//srv/fth/**)'));
});
