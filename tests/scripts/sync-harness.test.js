'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { syncHarness, expectedFiles, qwenCommandMd, QWEN_TOOLS, QWEN_LINKS, QWEN_STALE_LINKS } = require('../../scripts/lib/harness-sync');
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
        assert.strictEqual(data.approvalMode, 'default', `${rel}: headless roles ask, so the workspace allowlist decides`);
        assert.strictEqual(data.background, false, `${rel}: runs in the foreground (Qwen's default for a named subagent is the background)`);
      }
    }
    if (rel.endsWith('.toml')) assert.match(content, /^sandbox_mode = "(read-only|workspace-write)"$/m);
  }
  assert.match(files['workspace/AGENTS.md'], /## Risk Management/);
  // opencode's project config is JSON (no comments), one entry per role.
  const opencode = JSON.parse(files['workspace/opencode.json']);
  assert.deepStrictEqual(Object.keys(opencode.mcp), ['broker', 'harness']);
  for (const f of fs.readdirSync(path.join(ROOT, 'agents')).filter(n => n.endsWith('.md'))) assert.strictEqual(opencode.agent[f.replace(/\.md$/, '')].mode, require('../../scripts/lib/opencode').RUNNER_RUN_ROLES().includes(f.replace(/\.md$/, '')) ? 'all' : 'subagent', f);
  const ext = JSON.parse(files['qwen-extension/qwen-extension.json']);
  assert.strictEqual(ext.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  assert.match(ext.mcpServers.broker.args[0], /^\$\{extensionPath\}/);
  assert.deepStrictEqual(ext.mcpServers.harness, { command: 'node', args: ['${extensionPath}${/}scripts${/}harness-tools-mcp.js'], cwd: '${extensionPath}', timeout: 60000 });
  for (const l of QWEN_LINKS) assert.ok(fs.existsSync(path.join(ROOT, 'qwen-extension', l, '.')), `qwen-extension/${l} resolves`);
  assert.ok(!QWEN_LINKS.includes('rules') && QWEN_STALE_LINKS.includes('rules'));
  assert.ok(!QWEN_LINKS.includes('models') && QWEN_STALE_LINKS.includes('models'), 'the policy bundles are retired');
});

test('the Qwen extension embeds every always-on rule in QWEN.md (its rules are not linked)', () => {
  const files = expectedFiles(ROOT);
  const dir = path.join(ROOT, 'rules', 'trading');
  const rules = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  assert.ok(rules.length > 0);
  for (const f of rules) {
    const body = fs.readFileSync(path.join(dir, f), 'utf8').trim().replace(/^# /m, '## ');
    assert.ok(files['qwen-extension/QWEN.md'].includes(body), `rules/trading/${f} is embedded in qwen-extension/QWEN.md`);
    assert.ok(files['workspace/QWEN.md'].includes(body), `rules/trading/${f} is embedded in workspace/QWEN.md`);
  }
  assert.strictEqual(JSON.parse(files['qwen-extension/qwen-extension.json']).contextFileName, 'QWEN.md');
});

test('the skill catalog: in AGENTS.md (Codex\'s only list, opencode\'s head trader\'s index), not in QWEN.md or CLAUDE.md (they list skills themselves)', () => {
  const files = expectedFiles(ROOT);
  const skills = fs.readdirSync(path.join(ROOT, 'skills')).filter(d => fs.existsSync(path.join(ROOT, 'skills', d, 'SKILL.md')));
  const line = s => new RegExp(`^- \`${s}\` \\(skills/${s}/SKILL\\.md\\): `, 'm');
  for (const s of skills) assert.match(files['workspace/AGENTS.md'], line(s), s);
  for (const f of ['workspace/QWEN.md', 'qwen-extension/QWEN.md']) {
    for (const s of skills) assert.doesNotMatch(files[f], line(s), `${f}: ${s}`);
    assert.match(files[f], /## Skills\n\nYour harness lists every skill \(its skill tool\); each is `<root>\/skills\/<name>\/SKILL\.md`\.\n/);
    // Otherwise the same instructions: AGENTS.md with its catalog cut out.
    const agents = files['workspace/AGENTS.md'];
    assert.strictEqual(files[f].slice(0, files[f].indexOf('## Skills\n')), agents.slice(0, agents.indexOf('## Skills\n')), f);
    assert.strictEqual(files[f].slice(files[f].indexOf('## Agent roles\n')), agents.slice(agents.indexOf('## Agent roles\n')), f);
  }
  // Claude Code reads CLAUDE.md, which imports the catalog-less instructions (its plugin lists every skill).
  assert.match(files['workspace/CLAUDE.md'], /^@QWEN\.md$/m);
  assert.doesNotMatch(files['workspace/CLAUDE.md'], /@AGENTS\.md/);
  assert.ok(Buffer.byteLength(files['workspace/QWEN.md']) < Buffer.byteLength(files['workspace/AGENTS.md']) / 2);
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
  fs.symlinkSync('../rules', path.join(root, 'qwen-extension', 'rules'), 'dir');
  const changed = syncHarness(root);
  assert.ok(changed.includes('qwen-extension/agents/old-role.md (orphan)'));
  assert.ok(changed.includes('qwen-extension/skills -> ../skills'));
  assert.ok(!fs.existsSync(path.join(root, 'qwen-extension', 'agents', 'old-role.md')));
  assert.ok(changed.includes('qwen-extension/rules (stale link)'));
  assert.throws(() => fs.lstatSync(path.join(root, 'qwen-extension', 'rules')), /ENOENT/, 'the stale rules link is removed');
  assert.strictEqual(fs.readlinkSync(path.join(root, 'qwen-extension', 'skills')), '../skills');
  assert.deepStrictEqual(syncHarness(root, { check: true }), []);
  // A real directory named like a stale link is never removed.
  fs.mkdirSync(path.join(root, 'qwen-extension', 'rules'));
  assert.deepStrictEqual(syncHarness(root, { check: true }), []);
  assert.ok(fs.statSync(path.join(root, 'qwen-extension', 'rules')).isDirectory());
});

test('generation does not depend on the order a file system lists a folder in (Linux lists unsorted)', () => {
  const sorted = expectedFiles(ROOT);
  const real = fs.readdirSync;
  for (const order of [list => [...list].reverse(), list => [...list].sort((a, b) => (String(a).length - String(b).length) || (String(a) < String(b) ? 1 : -1))]) {
    fs.readdirSync = (...args) => order(real(...args));
    try {
      assert.deepStrictEqual(expectedFiles(ROOT), sorted);
    } finally {
      fs.readdirSync = real;
    }
  }
});
