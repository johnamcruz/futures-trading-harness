'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { docsOnly, scopeOf } = require('../../scripts/lib/ci-scope');

test('docsOnly: only Markdown under docs/, README.md and CONTRIBUTING.md are documents', () => {
  assert.strictEqual(docsOnly(['README.md']), true);
  assert.strictEqual(docsOnly(['README.md', 'docs/TRAINING.md', 'docs/research/x.md', 'CONTRIBUTING.md']), true);
});

test('docsOnly: anything else, or nothing, is not docs only (the full run is the safe side)', () => {
  assert.strictEqual(docsOnly([]), false);
  assert.strictEqual(docsOnly(['README.md', 'scripts/lib/runner.js']), false);
  assert.strictEqual(docsOnly(['skills/x/SKILL.md']), false, 'a skill is an instruction agents act on');
  assert.strictEqual(docsOnly(['CLAUDE.md']), false);
  assert.strictEqual(docsOnly(['docs/data.json']), false, 'only Markdown under docs/');
  assert.strictEqual(docsOnly(['notdocs/a.md', 'xdocs/a.md', 'docs.md']), false);
  assert.strictEqual(docsOnly(['.github/workflows/ci.yml', 'README.md']), false, 'a change to CI itself runs it all');
  assert.strictEqual(docsOnly(['']), false);
  assert.strictEqual(docsOnly(null), false);
});

test('scopeOf: a git error or an unusable base is not docs only', () => {
  assert.deepStrictEqual(scopeOf(() => 'README.md\n', 'abc'), { docsOnly: true, files: ['README.md'] });
  assert.strictEqual(scopeOf(() => { throw new Error('bad object'); }, 'abc').docsOnly, false);
  assert.strictEqual(scopeOf(() => 'README.md\n', '').docsOnly, false, 'no base');
  assert.strictEqual(scopeOf(() => 'README.md\n', '0000000000000000000000000000000000000000').docsOnly, false, 'a new branch has no base');
  assert.strictEqual(scopeOf(() => '\n', 'abc').docsOnly, false, 'no changed files');
});

test('ci-scope CLI: prints docs_only for the diff of a base to HEAD, and writes GITHUB_OUTPUT', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-scope-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 'n');
  fs.writeFileSync(path.join(dir, 'a.js'), '1'); git('add', '.'); git('commit', '-qm', 'one');
  const base = git('rev-parse', 'HEAD');
  fs.mkdirSync(path.join(dir, 'docs')); fs.writeFileSync(path.join(dir, 'docs', 'a.md'), 'x'); git('add', '.'); git('commit', '-qm', 'two');
  const cli = path.join(__dirname, '..', '..', 'scripts', 'ci-scope.js');
  const out = path.join(dir, 'out');
  const run = b => spawnSync('node', [cli, '--base', b], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out } });
  assert.strictEqual(run(base).stdout.trim(), 'docs_only=true');
  assert.match(fs.readFileSync(out, 'utf8'), /docs_only=true/);
  fs.writeFileSync(path.join(dir, 'b.js'), '2'); git('add', '.'); git('commit', '-qm', 'three');
  assert.strictEqual(run(base).stdout.trim(), 'docs_only=false');
  // a code file moved into docs/ is a change to code: git's rename detection would list only the new path
  fs.mkdirSync(path.join(dir, 'scripts')); fs.writeFileSync(path.join(dir, 'scripts', 'x.md'), 'same text'); git('add', '.'); git('commit', '-qm', 'four');
  const before = git('rev-parse', 'HEAD');
  git('mv', 'scripts/x.md', 'docs/x.md'); git('commit', '-qm', 'five');
  assert.strictEqual(run(before).stdout.trim(), 'docs_only=false', 'a rename into docs/ counts as the deleted path too');
  const bad = run('not-a-commit');
  assert.strictEqual(bad.status, 0, 'an unusable base never fails the job: it just runs everything');
  assert.strictEqual(bad.stdout.trim(), 'docs_only=false');
});
