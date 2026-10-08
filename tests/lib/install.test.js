'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { upsertBlock, MARK_BEGIN, MARK_END, codexConfigBlock, mergeQwenSettings, planCodex, planQwen, planClaude, applyPlan } = require('../../scripts/lib/install');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const ENTRY = '/opt/projectx-mcp/dist/index.js';

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
  const block = codexConfigBlock(ROOT, ENTRY);
  assert.match(block, /\[mcp_servers\.projectx\]/);
  assert.ok(block.includes(JSON.stringify(path.join(ROOT, 'scripts', 'mcp-gateway.js'))));
  assert.ok(block.includes(`"--", "node", "${ENTRY}"`));
  assert.match(block, /\[agents\.trade_executor\]/);
  assert.match(block, /config_file = ".*\/\.codex\/agents\/trade-executor\.toml"/);
});

test('codex refuses to clobber a user-defined projectx server', () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.projectx]\ncommand = "node"\n');
  assert.throws(() => planCodex({ root: ROOT, home, projectxEntry: ENTRY }), /already defines/);
});

test('qwen settings merge is idempotent and keeps user hooks and servers', () => {
  const user = {
    hooks: { PreToolUse: [{ matcher: 'write_file', hooks: [{ type: 'command', command: 'echo user' }] }] },
    mcpServers: { other: { command: 'x' } },
  };
  const once = mergeQwenSettings(user, ROOT, ENTRY);
  const twice = mergeQwenSettings(once, ROOT, ENTRY);
  assert.deepStrictEqual(twice, once);
  assert.strictEqual(once.hooks.PreToolUse.length, 2);
  assert.strictEqual(once.hooks.PreToolUse[0].hooks[0].command, 'echo user');
  assert.match(once.hooks.PreToolUse[1].hooks[0].command, /run-with-flags\.js" pre:trading:order-gate scripts\/hooks\/trading-order-gate\.js/);
  assert.deepStrictEqual(once.mcpServers.other, { command: 'x' });
  assert.ok(once.mcpServers.projectx.args[0].endsWith('mcp-gateway.js'));
  assert.throws(() => mergeQwenSettings({ mcpServers: { projectx: { command: 'node', args: ['/x/index.js'] } } }, ROOT, ENTRY), /does not use the harness gateway/);
});

test('plans write to the right files and backups are made', () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, '.qwen'));
  fs.writeFileSync(path.join(home, '.qwen', 'settings.json'), '{"theme":"dark"}');
  applyPlan(planQwen({ root: ROOT, home, projectxEntry: ENTRY }));
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.qwen', 'settings.json'), 'utf8'));
  assert.strictEqual(settings.theme, 'dark');
  assert.ok(fs.existsSync(path.join(home, '.qwen', 'settings.json.fth-backup')));
  applyPlan(planClaude({ root: ROOT, home, projectxEntry: ENTRY }));
  assert.ok(fs.existsSync(path.join(home, '.claude', 'rules', 'trading', 'risk-management.md')));
  applyPlan(planCodex({ root: ROOT, home, projectxEntry: ENTRY }));
  assert.match(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), /mcp_servers\.projectx/);
  fs.writeFileSync(path.join(home, '.qwen', 'settings.json'), '{bad');
  assert.throws(() => planQwen({ root: ROOT, home, projectxEntry: ENTRY }), /not valid JSON/);
});

test('CLI validates arguments and supports --dry-run', () => {
  const cli = path.join(ROOT, 'scripts', 'install.js');
  const home = tmpDir();
  const bad = spawnSync(process.execPath, [cli, '--target', 'cursor', '--projectx', ENTRY], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  const dry = spawnSync(process.execPath, [cli, '--target', 'all', '--projectx', ENTRY, '--dry-run', '--home', home], { encoding: 'utf8' });
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /would write .*config\.toml/);
  assert.deepStrictEqual(fs.readdirSync(home), []);
});
