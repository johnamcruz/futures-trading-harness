'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { syncHarness, expectedFiles, qwenCommandMd, QWEN_TOOLS, QWEN_LINKS, QWEN_DROPPED_LINKS } = require('../../scripts/lib/harness-sync');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');

test('generated Codex, Qwen, and workspace files are up to date', () => {
  assert.deepStrictEqual(syncHarness(ROOT, { check: true }), [], 'run: node scripts/sync-harness.js');
});

test('generated files parse in their harness formats', () => {
  const files = expectedFiles(ROOT);
  for (const [rel, content] of Object.entries(files)) {
    if (rel.startsWith('qwen-extension/') && rel.endsWith('.md') && !rel.endsWith('QWEN.md')) {
      const { data } = parseFrontmatter(content);
      assert.ok(data.description, `${rel}: description`);
      if (rel.startsWith('qwen-extension/agents/')) {
        assert.ok(Array.isArray(data.tools) && data.tools.length > 0, `${rel}: tools`);
        for (const t of data.tools) assert.ok(!Object.keys(QWEN_TOOLS).includes(t), `${rel}: untranslated tool ${t}`);
        // Without it Qwen runs the subagent in auto-edit, auto-approving writes the allowlist doesn't cover.
        assert.strictEqual(data.approvalMode, 'default', `${rel}: approvalMode`);
      }
    }
    if (rel.endsWith('.toml')) assert.match(content, /^sandbox_mode = "(read-only|workspace-write)"$/m);
  }
  assert.match(files['workspace/AGENTS.md'], /## Risk Management/);
  const ext = JSON.parse(files['qwen-extension/qwen-extension.json']);
  assert.strictEqual(ext.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  assert.match(ext.mcpServers.broker.args[0], /^\$\{extensionPath\}/);
  for (const l of QWEN_LINKS) assert.ok(fs.existsSync(path.join(ROOT, 'qwen-extension', l, '.')), `qwen-extension/${l} resolves`);
});

test('qwen extension ships no rules: QWEN.md embeds every always-on rule instead', () => {
  // Qwen skips extension rules without `paths:`; the rules reach it through the context file.
  assert.ok(QWEN_DROPPED_LINKS.includes('rules') && !QWEN_LINKS.includes('rules'));
  assert.ok(!fs.existsSync(path.join(ROOT, 'qwen-extension', 'rules')));
  const ctx = expectedFiles(ROOT)['qwen-extension/QWEN.md'];
  const rules = fs.readdirSync(path.join(ROOT, 'rules', 'trading')).filter(f => f.endsWith('.md'));
  assert.ok(rules.length >= 5);
  for (const f of rules) {
    const body = fs.readFileSync(path.join(ROOT, 'rules', 'trading', f), 'utf8').trim().replace(/^# /m, '## ');
    assert.ok(ctx.includes(body), `qwen-extension/QWEN.md embeds rules/trading/${f}`);
  }
});

test('sync removes an obsolete qwen-extension/rules link', () => {
  const root = tmpDir();
  for (const d of ['agents', 'commands', 'rules', 'skills']) fs.cpSync(path.join(ROOT, d), path.join(root, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
  syncHarness(root);
  fs.symlinkSync('../rules', path.join(root, 'qwen-extension', 'rules'), 'dir');
  assert.deepStrictEqual(syncHarness(root, { check: true }), ['qwen-extension/rules (obsolete)']);
  assert.ok(fs.lstatSync(path.join(root, 'qwen-extension', 'rules')).isSymbolicLink(), 'check does not write');
  assert.deepStrictEqual(syncHarness(root), ['qwen-extension/rules (obsolete)']);
  assert.ok(!fs.existsSync(path.join(root, 'qwen-extension', 'rules')));
  assert.ok(fs.existsSync(path.join(root, 'rules', 'trading')), 'the canonical rules stay');
  // A real directory there is reported, not deleted.
  fs.mkdirSync(path.join(root, 'qwen-extension', 'rules'));
  assert.deepStrictEqual(syncHarness(root), ['qwen-extension/rules (obsolete)']);
  assert.ok(fs.existsSync(path.join(root, 'qwen-extension', 'rules')));
});

test('qwen commands use {{args}}', () => {
  assert.match(qwenCommandMd('---\ndescription: x\n---\nRun for: $ARGUMENTS\n'), /Run for: \{\{args\}\}/);
});

test('sync writes missing files and removes orphans', () => {
  const root = tmpDir();
  for (const d of ['agents', 'commands', 'rules', 'skills']) fs.cpSync(path.join(ROOT, d), path.join(root, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
  fs.mkdirSync(path.join(root, 'qwen-extension', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'qwen-extension', 'agents', 'old-role.md'), 'x');
  const changed = syncHarness(root);
  assert.ok(changed.includes('qwen-extension/agents/old-role.md (orphan)'));
  assert.ok(changed.includes('qwen-extension/skills -> ../skills'));
  assert.ok(!fs.existsSync(path.join(root, 'qwen-extension', 'agents', 'old-role.md')));
  assert.strictEqual(fs.readlinkSync(path.join(root, 'qwen-extension', 'skills')), '../skills');
  assert.deepStrictEqual(syncHarness(root, { check: true }), []);
});
