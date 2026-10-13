'use strict';

// The pull-request process as hard rules (CLAUDE.md, "Before a pull request"):
// every coding agent and person runs the regression and an adversarial review
// before a pull request. What can be checked in code is checked here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(REPO, f), 'utf8');

test('process: `npm run verify` runs every check CI runs (the regression is one command, the same as CI)', () => {
  const verify = JSON.parse(read('package.json')).scripts.verify;
  assert.ok(verify, 'package.json has a verify script');
  const steps = verify.split('&&').map(s => s.trim());
  // CI's own checks: every `run:` step but the installs.
  const ci = read('.github/workflows/ci.yml').split('\n').map(l => /^\s*- run: (.+)$/.exec(l)).filter(Boolean).map(m => m[1].trim())
    .filter(c => !/^(npm ci|pip install)\b/.test(c));
  assert.ok(ci.length >= 4, `CI's checks: ${ci.join('; ')}`);
  for (const c of ci) assert.ok(steps.includes(c), `CI runs "${c}" but npm run verify doesn't`);
  assert.strictEqual(steps.length, ci.length, `npm run verify runs ${steps.join('; ')}; CI runs ${ci.join('; ')}`);
});

test('process: the hard rule is where every coding agent reads it, and the PR template asks for both', () => {
  const rule = read('CLAUDE.md');
  assert.match(rule, /## Before a pull request \(hard rule\)/);
  assert.match(rule, /`npm run verify` passes/);
  assert.match(rule, /\*\*Adversarial review\.\*\* A reviewer other than the author/);
  assert.match(rule, /Never open a pull request with a failing regression or an unaddressed\s+confirmed finding/);
  // Documents only get a soundness review; anything agents act on keeps the full round.
  const exception = /A change to documents only \(([^)]*)\)[\s\S]*?not\s+the full adversarial round/.exec(rule);
  assert.ok(exception, 'the documents-only exception');
  assert.match(exception[1].replace(/\s+/g, ' '), /^Markdown under `docs\/`, `README\.md`, `CONTRIBUTING\.md`, and nothing else$/, 'its scope is a closed list');
  assert.match(rule, /Skills, agents, commands, rules, strategies, and\s+accounts are instructions agents act on: they get the full round/);
  // Every document agents are pointed to is named as getting the full round: a new pointer can't slip into the exception.
  // A reference is any mention of a document's file name (any case, with or without a path) in an instruction file or script.
  const walk = d => fs.readdirSync(path.join(REPO, d), { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const docs = walk('docs').filter(f => /\.md$/i.test(f)).map(f => f.split(path.sep).join('/'));
  const sources = ['skills', 'agents', 'commands', 'rules', 'strategies', 'accounts', 'hooks', 'scripts']
    .filter(d => fs.existsSync(path.join(REPO, d))).flatMap(walk).filter(f => /\.(md|js|json)$/i.test(f)).map(f => read(f).toLowerCase()).join('\n');
  const pointed = new Set(docs.filter(d => sources.includes(path.basename(d).toLowerCase())));
  const fullRound = rule.slice(rule.indexOf('they get the full round'), rule.indexOf('Never open a pull request'));
  for (const doc of pointed) assert.ok(fullRound.includes(`\`${doc}\``), `${doc} is pointed to by an instruction file or script: name it in CLAUDE.md as getting the full round`);
  assert.ok(pointed.has('docs/BROKER-MCP-INTERFACE.md'));
  assert.ok(pointed.has('docs/LIVE-DRY-RUN.md'), 'preflight points to the live runbook');
  // Codex and other agents read AGENTS.md, Qwen Code reads QWEN.md: both point at it.
  for (const f of ['AGENTS.md', 'QWEN.md']) {
    assert.match(read(f), /CLAUDE\.md/, `${f} points to CLAUDE.md`);
    assert.match(read(f), /adversarial review/i, `${f} names the review`);
  }
  assert.match(read('CONTRIBUTING.md'), /## Before a pull request \(hard rule\)/);
  assert.match(read('CONTRIBUTING.md'), /still runs the regression/);
  const template = read('.github/pull_request_template.md');
  assert.match(template, /## Regression \(required\)[\s\S]*npm run verify/);
  assert.match(template, /## Adversarial review \(required\)/);
  assert.match(template, /Documents only .*not a document agents are pointed to.*the regression still ran/);
});
