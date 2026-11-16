'use strict';

// The structure-read dataset CLI end to end (scripts/structure-read-dataset.js prompts, build and show) on a fixture
// run: the prompts written for any model to answer, an answer kept only when it verifies, the files where asked.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('../helpers');
const { briefing } = require('../fixtures/structure-briefing');
const SR = require('../../scripts/lib/learning/structure-read');

const ROOT = path.resolve(__dirname, '..', '..');
const NOW = require('../../scripts/lib/learning/adapter').currentDigests(ROOT);
const run = args => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'structure-read-dataset.js'), ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, FTH_HOME: tmpDir() } });
const SHAPES = [
  { last: { kind: 'BOS', direction: 'up' }, previous: { kind: 'BOS', direction: 'up' }, pullback: null },
  {},
  { last: { kind: 'CHoCH', direction: 'down' }, previous: { kind: 'CHoCH', direction: 'up' }, pullback: null, marketState: '- Market state (3m): chop; class chop.' },
];

function writeRun(home) {
  const runDir = path.join(home, 'replay', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ runId: 'r1', start: '2022-03-07T00:00:00Z', end: '2022-03-12T00:00:00Z' }));
  fs.writeFileSync(path.join(runDir, 'setup.json'), JSON.stringify({ runId: 'r1', code: NOW.code }));
  ['2022-03-07', '2022-03-08'].forEach(day => SHAPES.forEach((shape, k) => {
    const t = `${day}T1${5 + k}:00:00.000Z`;
    fs.mkdirSync(path.join(home, 'logs', 'cycles', day), { recursive: true });
    fs.writeFileSync(path.join(home, 'logs', 'cycles', day, `${k}-trade.json`), JSON.stringify({ timing: { barClose: t }, prompt: `P\n${briefing({ t, ...shape })}` }));
  }));
  return runDir;
}

test('structure-read-dataset.js prompts, build and show', () => {
  const dir = tmpDir();
  const runDir = writeRun(path.join(dir, 'home'));
  const promptsFile = path.join(dir, 'prompts.jsonl');
  const p = run(['prompts', '--run', runDir, '--out', promptsFile]);
  assert.strictEqual(p.status, 0, p.stderr);
  const prompts = fs.readFileSync(promptsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.strictEqual(prompts.length, 12);
  assert.ok(prompts.every(x => x.id === crypto.createHash('sha256').update(x.prompt).digest('hex')));
  assert.match(run(['prompts', '--run', runDir, '--out', promptsFile]).stderr, /exists/);
  // One answer right, one wrong.
  const seq = prompts.filter(x => x.kind === 'sequence');
  const right = SR.goldAnswer('sequence', SR.truthOf(SR.briefingOf(seq[0].prompt)).sequence);
  const answers = path.join(dir, 'answers.jsonl');
  fs.writeFileSync(answers, `${JSON.stringify({ id: seq[0].id, text: right })}\n${JSON.stringify({ id: seq[1].id, text: '{"seq":"none"}' })}\n`);
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters', 'spec.json'), 'utf8'));
  const specFile = path.join(dir, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify({ ...spec, structureRead: { seed: 1, maxCaseShare: 0.5, maxRegimeShare: 0.5 } }));
  const out = path.join(dir, 'ds');
  const b = run(['build', '--train', runDir, '--answers', answers, '--out', out, '--spec', specFile]);
  assert.strictEqual(b.status, 0, b.stderr + b.stdout);
  assert.match(b.stdout, /dataset [0-9a-f]{64}/);
  assert.match(b.stdout, /answers: 2 seen, 1 verified on every field, 1 rejected/);
  assert.match(b.stdout, /"sequence:model":1/);
  assert.strictEqual(fs.readFileSync(path.join(out, 'train.jsonl'), 'utf8').split('\n').filter(Boolean).length, 12);
  assert.strictEqual(run(['show', out]).status, 0);
  assert.match(run(['build', '--train', runDir, '--out', out, '--spec', specFile]).stderr, /already holds a dataset/);
  assert.match(run(['build', '--train', runDir, '--bogus', 'x']).stderr, /unknown flag --bogus/);
  assert.match(run(['build', '--out', path.join(dir, 'x')]).stderr, /usage/);
});
