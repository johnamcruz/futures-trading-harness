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
/** A workflow's jobs: [{ name, body }] (each job's lines under `jobs:`, two spaces in). */
const jobsOf = yml => {
  const body = yml.split(/^jobs:\n/m)[1];
  const jobs = [...body.matchAll(/^ {2}([a-z0-9-]+):\n((?: {4}.*\n|\n)*)/gm)].map(m => ({ name: m[1], body: m[2] }));
  // Every job key read: one named outside the pattern would drop its steps from the checks below.
  const keys = [...body.matchAll(/^ {2}([^\s#][^:]*):/gm)].map(m => m[1]);
  assert.deepStrictEqual(jobs.map(j => j.name), keys, 'every CI job is read (job names are lowercase, digits and dashes)');
  return jobs;
};
// The goal regression's jobs (below): its parts and the one aggregate.
const GOAL_JOBS = ['goal-part', 'goal-full'];

test('process: `npm run verify` runs every check CI runs (the regression is one command, the same as CI)', () => {
  const verify = JSON.parse(read('package.json')).scripts.verify;
  assert.ok(verify, 'package.json has a verify script');
  const steps = verify.split('&&').map(s => s.trim());
  // CI's own checks: every `run:` step of every job but the installs and the goal regression's jobs (below).
  const ci = jobsOf(read('.github/workflows/ci.yml')).filter(j => !GOAL_JOBS.includes(j.name)).flatMap(j => j.body.split('\n')).map(l => /^\s*- run: (.+)$/.exec(l)).filter(Boolean).map(m => m[1].trim())
    .filter(c => !/^(npm ci|pip install)\b/.test(c));
  assert.ok(ci.length >= 4, `CI's checks: ${ci.join('; ')}`);
  for (const c of ci) assert.ok(steps.includes(c), `CI runs "${c}" but npm run verify doesn't`);
  assert.strictEqual(steps.length, ci.length, `npm run verify runs ${steps.join('; ')}; CI runs ${ci.join('; ')}`);
});

// The goal regression's tier 2 runs in CI on every pull request, not in npm run verify (it plays the live path for
// minutes): its parts in parallel (goal-part: tier 2's days in shards, a job for each other tests/goal/*.goal.js file),
// then one aggregate (goal-full, the one required name) that needs every part and fails unless they all passed, then
// judges the shards as one run. Locally npm run goal:full runs it all.
test('process: the goal regression is CI\'s parts in parallel, every file and every tier 2 day covered, and one aggregate goal-full that fails if any part did', () => {
  const ci = read('.github/workflows/ci.yml');
  const pkg = JSON.parse(read('package.json')).scripts;
  assert.match(ci, /^on:\n(?:.*\n)*?\s+pull_request:/m, 'CI runs on every pull request');
  const jobs = Object.fromEntries(jobsOf(ci).map(j => [j.name, j.body]));
  const part = jobs['goal-part'];
  assert.ok(part, 'a goal-part job');
  assert.match(part, /fail-fast: false/, 'every part runs to its end');
  const entries = [...part.matchAll(/- part: (\S+)\n\s+file: (\S+)(?:\n\s+shard: (\d+)\/(\d+))?/g)].map(m => ({ part: m[1], file: m[2], shard: m[3] ? { k: Number(m[3]), n: Number(m[4]) } : null }));
  // Every goal file exactly once, tier 2's main file in shards 1..n of one n, each shard one round of its parallel days.
  const files = fs.readdirSync(path.join(REPO, 'tests', 'goal')).filter(f => f.endsWith('.goal.js')).map(f => `tests/goal/${f}`).sort();
  const SHARDED = 'tests/goal/tier2.goal.js';
  assert.deepStrictEqual(entries.filter(e => !e.shard).map(e => e.file).sort(), files.filter(f => f !== SHARDED), 'a job for each goal file but the sharded one, once');
  assert.ok(!entries.some(e => e.shard && e.file !== SHARDED), 'only tier 2\'s main file is sharded');
  const shards = entries.filter(e => e.shard);
  const n = shards.length;
  assert.deepStrictEqual(shards.map(e => `${e.shard.k}/${e.shard.n}`), Array.from({ length: n }, (_, i) => `${i + 1}/${n}`), 'shards 1..n of n, once each');
  const T = require('../goal/tier2-run');
  const days = T.allDays().length;
  const parallel = require('../../scripts/lib/tunables').training().goalRegression.tier2.parallel;
  assert.ok(n * parallel >= days, `each shard one round: ${n} shards x ${parallel} at once must cover tier 2's ${days} days (add shards)`);
  assert.ok(n < days, 'no empty shard');
  assert.ok(new Set(entries.map(e => e.part)).size === entries.length, 'each part named once');
  assert.match(part, /- run: node --test \$\{\{ matrix\.file \}\}\n\s+env:\n\s+FTH_GOAL_SHARD: \$\{\{ matrix\.shard \}\}\n\s+FTH_GOAL_SHARD_OUT: goal-shards\n/, 'each part runs its file, a shard its days, its results written');
  assert.match(part, /- if: matrix\.shard\n\s+uses: actions\/upload-artifact@v4\n\s+with:\n\s+name: goal-shard-\$\{\{ matrix\.part \}\}\n\s+path: goal-shards\//, 'each shard\'s results uploaded');
  // The aggregate: after every part, always, failing unless every part passed; then the shards judged as one.
  const full = jobs['goal-full'];
  assert.ok(full, 'a goal-full job (the one required check)');
  assert.match(full, /^ {4}needs: goal-part\n/m);
  assert.match(full, /^ {4}if: always\(\)\n/m, 'it runs when a part failed, so it fails too (a skipped required check passes)');
  assert.match(full, /PARTS: \$\{\{ needs\.goal-part\.result \}\}\n\s+run: test "\$PARTS" = success\n/, 'it fails unless every part passed');
  assert.match(full, /uses: actions\/download-artifact@v4\n\s+with:\n\s+pattern: goal-shard-\*\n\s+path: goal-shards\n\s+merge-multiple: true\n/);
  assert.match(full, /- run: npm run goal:aggregate -- goal-shards\n/);
  assert.strictEqual(pkg['goal:aggregate'], 'node tests/goal/tier2-aggregate.js');
  assert.match(pkg['goal:full'], /tests\/goal\/\*\.goal\.js/);
  assert.ok(!pkg.verify.includes('goal:full'), 'not in npm run verify (its tier 1 is: tests/plugin/goal-regression.test.js)');
  assert.match(read('CLAUDE.md'), /goal regression/i);
  assert.match(read('.github/pull_request_template.md'), /Goal regression: main vs this PR/);
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
