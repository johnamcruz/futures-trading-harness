'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { syncHarness, expectedFiles, qwenCommandMd, QWEN_TOOLS } = require('../../scripts/lib/harness-sync');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');

test('generated Codex, Qwen, and workspace files are up to date', () => {
  assert.deepStrictEqual(syncHarness(ROOT, { check: true }), [], 'run: node scripts/sync-harness.js');
});

test('generated files parse in their harness formats', () => {
  const files = expectedFiles(ROOT);
  for (const [rel, content] of Object.entries(files)) {
    if (rel.startsWith('qwen/')) {
      const { data } = parseFrontmatter(content);
      assert.ok(data.description, `${rel}: description`);
      if (rel.startsWith('qwen/agents/')) {
        assert.ok(Array.isArray(data.tools) && data.tools.length > 0, `${rel}: tools`);
        for (const t of data.tools) assert.ok(!Object.keys(QWEN_TOOLS).includes(t), `${rel}: untranslated tool ${t}`);
      }
    }
    if (rel.endsWith('.toml')) assert.match(content, /^sandbox_mode = "(read-only|workspace-write)"$/m);
  }
  assert.match(files['workspace/AGENTS.md'], /## Risk Management/);
});

test('qwen commands use {{args}}', () => {
  assert.match(qwenCommandMd('---\ndescription: x\n---\nRun for: $ARGUMENTS\n'), /Run for: \{\{args\}\}/);
});

test('sync writes missing files and removes orphans', () => {
  const root = tmpDir();
  for (const d of ['agents', 'commands', 'rules', 'skills']) fs.cpSync(path.join(ROOT, d), path.join(root, d), { recursive: true });
  fs.mkdirSync(path.join(root, 'qwen', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'qwen', 'agents', 'old-role.md'), 'x');
  const changed = syncHarness(root);
  assert.ok(changed.includes('qwen/agents/old-role.md (orphan)'));
  assert.ok(!fs.existsSync(path.join(root, 'qwen', 'agents', 'old-role.md')));
  assert.deepStrictEqual(syncHarness(root, { check: true }), []);
});
