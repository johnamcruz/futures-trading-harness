'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('../helpers');
const T = require('../../scripts/lib/train/tree');

function repo() {
  const dir = tmpDir();
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(dir, 'skills', 'a'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'a', 'SKILL.md'), '# A\n\nold text\n');
  fs.mkdirSync(path.join(dir, 'workspace'));
  fs.writeFileSync(path.join(dir, 'workspace', 'AGENTS.md'), 'generated\n');
  fs.symlinkSync('../skills', path.join(dir, 'workspace', 'skills'));
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { dir, git, head: git('rev-parse', 'HEAD') };
}

test('exportTree: HEAD as plain files, links kept; a repository with uncommitted changes is refused', () => {
  const r = repo();
  const out = path.join(tmpDir(), 'tree');
  assert.strictEqual(T.exportTree(r.dir, out), r.head);
  assert.strictEqual(fs.readFileSync(path.join(out, 'skills', 'a', 'SKILL.md'), 'utf8'), '# A\n\nold text\n');
  assert.strictEqual(fs.readlinkSync(path.join(out, 'workspace', 'skills')), '../skills');
  assert.ok(!fs.existsSync(path.join(out, '.git')));
  fs.writeFileSync(path.join(r.dir, 'skills', 'a', 'SKILL.md'), 'edited\n');
  assert.throws(() => T.exportTree(r.dir, path.join(tmpDir(), 'tree')), /uncommitted changes/);
});

test('copyTree and changedFiles: the working tree without .git; content, link and added or removed files differ', () => {
  const r = repo();
  const a = path.join(tmpDir(), 'a');
  const b = path.join(tmpDir(), 'b');
  T.copyTree(r.dir, a);
  T.copyTree(r.dir, b);
  assert.ok(!fs.existsSync(path.join(a, '.git')));
  assert.deepStrictEqual(T.changedFiles(a, b), []);
  fs.writeFileSync(path.join(b, 'skills', 'a', 'SKILL.md'), 'new\n');
  fs.writeFileSync(path.join(b, 'workspace', 'NEW.md'), 'x\n');
  fs.unlinkSync(path.join(b, 'workspace', 'AGENTS.md'));
  fs.unlinkSync(path.join(b, 'workspace', 'skills'));
  fs.symlinkSync('../strategies', path.join(b, 'workspace', 'skills'));
  assert.deepStrictEqual(T.changedFiles(a, b), ['skills/a/SKILL.md', 'workspace/AGENTS.md', 'workspace/NEW.md', 'workspace/skills']);
  assert.ok(T.GENERATED.test('workspace/opencode.json') && T.GENERATED.test('qwen-extension/QWEN.md') && T.GENERATED.test('.codex/agents/x.toml'));
  assert.ok(!T.GENERATED.test('skills/a/SKILL.md') && !T.GENERATED.test('scripts/lib/x.js'));
});

test('prepareTree: applies the proposal, then syncs and validates in the tree', () => {
  const r = repo();
  const calls = [];
  const files = T.prepareTree(r.dir, { proposal: { targets: ['bad size'], expects: 'x', edits: [{ file: 'skills/a/SKILL.md', find: 'old text', replace: 'new text' }] }, run: (dir, args) => calls.push([dir, args.map(x => path.basename(x))]) });
  assert.deepStrictEqual(files, ['skills/a/SKILL.md']);
  assert.match(fs.readFileSync(path.join(r.dir, 'skills', 'a', 'SKILL.md'), 'utf8'), /new text/);
  assert.deepStrictEqual(calls, [[r.dir, ['sync-harness.js']], [r.dir, ['strategies.js', 'validate']]]);
});

test('prepareTree: the real sync and validation run in a copy of this repository', () => {
  const ROOT = path.resolve(__dirname, '..', '..');
  const copy = path.join(tmpDir(), 'tree');
  T.copyTree(ROOT, copy);
  T.prepareTree(copy, {});
  assert.deepStrictEqual(T.changedFiles(ROOT, copy).filter(f => !f.startsWith('tests/') && !f.startsWith('.claude/')), [], 'a synced tree with no proposal is the tree');
});

test('writeBranch: a local branch on the base commit with the files, without a checkout; never over an existing branch', () => {
  const r = repo();
  const cand = path.join(tmpDir(), 'cand');
  T.exportTree(r.dir, cand);
  fs.writeFileSync(path.join(cand, 'skills', 'a', 'SKILL.md'), '# A\n\nnew text\n');
  fs.writeFileSync(path.join(cand, 'workspace', 'NEW.md'), 'gen\n');
  fs.unlinkSync(path.join(cand, 'workspace', 'AGENTS.md'));
  const files = T.changedFiles(r.dir, cand).filter(f => !f.startsWith('.git'));
  const index = path.join(tmpDir(), 'index.tmp');
  const commit = T.writeBranch(r.dir, { branch: 'train/l1-i1-abc', base: r.head, fromDir: cand, files, message: 'docs: x\n', indexFile: index });
  assert.strictEqual(r.git('rev-parse', 'train/l1-i1-abc'), commit);
  assert.strictEqual(r.git('rev-parse', 'HEAD'), r.head, 'the checkout is unchanged');
  assert.strictEqual(r.git('status', '--porcelain'), '', 'the working tree and index are untouched');
  assert.strictEqual(r.git('show', 'train/l1-i1-abc:skills/a/SKILL.md'), '# A\n\nnew text');
  assert.deepStrictEqual(r.git('diff', '--name-status', r.head, commit).split('\n').sort(), ['A\tworkspace/NEW.md', 'D\tworkspace/AGENTS.md', 'M\tskills/a/SKILL.md']);
  assert.strictEqual(r.git('log', '-1', '--format=%P', commit), r.head);
  assert.ok(!fs.existsSync(index));
  assert.throws(() => T.writeBranch(r.dir, { branch: 'train/l1-i1-abc', base: r.head, fromDir: cand, files, message: 'x', indexFile: index }), /already exists/);
  assert.throws(() => T.writeBranch(r.dir, { branch: '../x', base: r.head, fromDir: cand, files, message: 'x', indexFile: index }), /branch name/);
  assert.strictEqual(r.git('remote'), '', 'nothing pushed anywhere');
});

test('removeTree: only a tree under the loop\'s own folder', () => {
  const owned = tmpDir();
  const t = path.join(owned, 'trees', 'x');
  fs.mkdirSync(t, { recursive: true });
  assert.throws(() => T.removeTree(owned, owned), /not one of the loop's own/);
  assert.throws(() => T.removeTree(path.join(owned, '..'), owned), /not one of the loop's own/);
  T.removeTree(t, path.join(owned, 'trees'));
  assert.ok(!fs.existsSync(t));
});
