'use strict';

// The moment probe's read mode (scripts/moment-probe.js --patch) and the moments maker (scripts/probe-moments.js),
// against a fake `claude` binary (no model): the old arm gets the recorded prompt, the new one the patched prompt; the
// table and the JSON carry the read counts; --system replaces the recorded system file; a patch that misses fails the
// run before any ask.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'moment-probe.js');
const MAKER = path.join(ROOT, 'scripts', 'probe-moments.js');
// The State line needs its module and its tunable on the checkout (both come with it).
const HAS_FRAME_STATE = fs.existsSync(path.join(ROOT, 'scripts', 'lib', 'trading', 'frame-state.js'))
  && Number.isFinite(require('../../scripts/lib/tunables').analysis().briefing.stateRangeAtr);

const BRIEF = ['--- bar_briefing {"symbol":"MNQ"} ---', 'Summary (MNQ 3m, 10:03 ET):', '- Trend rule: SHORT allowed (prevailing 1h down).', '- Alignment: long mixed, short mixed.',
  'Detail by timeframe:', '[m3] version m3@2021-05-11T14:03:00.000Z', '  et: 10:03', '  windowEntries: allowed', '[h1] version h1@2021-05-11T14:00:00.000Z', '  h1: {"trend":"down"}',
  '--- end of bar_briefing ---'].join('\n');

function setup(t, argv = ['claude', '--append-system-prompt-file', '/recorded.md']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.mkdirSync(path.join(dir, 'tmp'));
  // The fake model: logs its argv, answers by what it was shown (the patched line or not).
  const fake = ['#!/bin/sh', `printf '%s\\n' "$@" >> "${path.join(dir, 'argv.log')}"`, 'case "$2" in',
    '  *"- State (probe)"*) printf "The 1h label and price disagree: a transition.\\nCYCLE RESULT: no-trade - unresolved\\n" ;;',
    '  *) printf "Short with the 1h.\\nCYCLE RESULT: planned - short\\n" ;;', 'esac', ''].join('\n');
  fs.writeFileSync(path.join(dir, 'bin', 'claude'), fake, { mode: 0o755 });
  const log = { prompt: `Cycle.\n${BRIEF}\n`, result: 'CYCLE RESULT: planned - short', argv };
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify(log));
  fs.writeFileSync(path.join(dir, 'm.json'), JSON.stringify([{ cycle: path.join(dir, 'c.json'), id: 'c1', set: 'change' }]));
  fs.writeFileSync(path.join(dir, 'p.json'), JSON.stringify({ name: 'state-probe', within: { from: '--- bar_briefing', to: '--- end of bar_briefing' }, line: '^- Alignment:', op: 'before', text: '- State (probe): 1h down: DISAGREE.' }));
  return dir;
}

const run = (dir, extra, cli = CLI) => spawnSync(process.execPath, [cli, ...extra],
  { env: { ...process.env, TMPDIR: path.join(dir, 'tmp'), PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}` }, encoding: 'utf8' });
const base = dir => ['--moments', path.join(dir, 'm.json'), '--k', '2', '--timeout-ms', '20000', '--out', path.join(dir, 'out')];

test('read CLI: a patch file arm; both arms asked k times; the table and JSON carry the reads', t => {
  const dir = setup(t);
  const r = run(dir, [...base(dir), '--patch', path.join(dir, 'p.json')]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^arms: .*the same system prompt file on both/);
  // The new answer's words only ("label and price disagree: a transition"), with a line shown: words-only, never own.
  assert.match(r.stdout, /\nchange\s+c1\s+planned\s+planned\s+no-trade\s+0\/2 > 0\/2\s+0\/2 > 0\/2\s+2\/2\s+0\/2\s+0\/2 > 0\/2\s+-\s+state-probe\n/);
  assert.match(r.stdout, /change: 1 moments \(0 untestable, 0 with a read-back unknown\), calibrated 1, decision changed 1 of 1/);
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'moment-probe-read.json'), 'utf8'));
  assert.strictEqual(out.rows[0].new.namesConflict, 2);
  assert.strictEqual(out.rows[0].new.transitionOnly, 2);
  assert.strictEqual(out.summary.change.decisionChanged, 1);
  const argv = fs.readFileSync(path.join(dir, 'argv.log'), 'utf8');
  assert.strictEqual(argv.split('\n').filter(l => l === '/recorded.md').length, 4, 'the recorded system file, 2 asks per arm');
  assert.ok(argv.includes('--tools'), 'asked without tools');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'tmp')), [], 'the temp directory is removed');
});

test('read CLI: --system replaces the recorded system file; a cycle without one needs it', t => {
  const dir = setup(t, ['claude', '--plugin-dir', '/p']);
  const no = run(dir, [...base(dir), '--patch', path.join(dir, 'p.json')]);
  assert.strictEqual(no.status, 1);
  assert.match(no.stderr, /--system/);
  const missing = run(dir, [...base(dir), '--patch', path.join(dir, 'p.json'), '--system', path.join(dir, 'head.md')]);
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /--system .*head\.md: no such file/);
  assert.ok(!fs.existsSync(path.join(dir, 'argv.log')), 'checked before any ask');
  fs.writeFileSync(path.join(dir, 'head.md'), 'head');
  const r = run(dir, [...base(dir), '--patch', path.join(dir, 'p.json'), '--system', path.join(dir, 'head.md')]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.readFileSync(path.join(dir, 'argv.log'), 'utf8').split('\n').includes(path.join(dir, 'head.md')));
});

test('read CLI: --system-new goes to the new arm only, labelled, in its own JSON file', t => {
  const dir = setup(t);
  const nw = path.join(dir, 'new-head.md');
  assert.match(run(dir, [...base(dir), '--patch', path.join(dir, 'p.json'), '--system-new', nw]).stderr, /--system-new .*no such file/);
  fs.writeFileSync(nw, 'new head');
  const r = run(dir, [...base(dir), '--patch', path.join(dir, 'p.json'), '--system-new', nw]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^arms: .*new system prompt file .*new-head\.md on the new arm: the line confounded with its skill text/);
  const lines = fs.readFileSync(path.join(dir, 'argv.log'), 'utf8').split('\n');
  assert.strictEqual(lines.filter(l => l === nw).length, 2, 'the new arm\'s 2 asks');
  assert.strictEqual(lines.filter(l => l === '/recorded.md').length, 2, 'the old arm keeps the recorded file');
  assert.ok(fs.existsSync(path.join(dir, 'out', 'moment-probe-read-system-new.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'out', 'moment-probe-read.json')), 'never the same-system run\'s file');
});

test('read CLI: a patch whose anchor is missing fails the run and asks nothing', t => {
  const dir = setup(t);
  fs.writeFileSync(path.join(dir, 'p.json'), JSON.stringify([{ name: 'x', line: '^- Nowhere:', op: 'before', text: 'y' }]));
  const r = run(dir, [...base(dir), '--patch', path.join(dir, 'p.json')]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /nothing asked[\s\S]*c1: patch: anchor line \^- Nowhere: not found/);
  assert.ok(!fs.existsSync(path.join(dir, 'argv.log')), 'no model call');
});

test('read CLI: a failed ask is shown with its reason and the run exits 1 (its counts are short)', t => {
  const dir = setup(t);
  fs.writeFileSync(path.join(dir, 'bin', 'claude'), '#!/bin/sh\nprintf "rate limit\\n" >&2\nexit 2\n', { mode: 0o755 });
  const r = run(dir, [...base(dir), '--patch', path.join(dir, 'p.json')]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /\nc1\tclaude exited 2: rate limit\n/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'out', 'moment-probe-read.json'), 'utf8')).rows[0].new.errors, 2);
});

test('read CLI: neither --tree nor --patch is a usage error; the outcome mode still needs no --patch', t => {
  const dir = setup(t);
  const r = run(dir, base(dir));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /usage/);
});

test('read CLI: --patch state-line needs the frame-state module, or says so', t => {
  const dir = setup(t);
  const r = run(dir, [...base(dir), '--patch', 'state-line']);
  if (HAS_FRAME_STATE) assert.strictEqual(r.status, 0, r.stderr);
  else { assert.strictEqual(r.status, 1); assert.match(r.stderr, /State line patch needs (?:scripts\/lib\/trading\/frame-state\.js|config\/analysis\.json briefing\.stateRangeAtr)/); }
});

test('probe-moments CLI: usage without --home or --out; a home without logs/cycles fails', t => {
  const dir = setup(t);
  assert.match(run(dir, ['--out', path.join(dir, 'x.json')], MAKER).stderr, /usage/);
  const r = run(dir, ['--home', path.join(dir, 'none'), '--out', path.join(dir, 'x.json')], MAKER);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, HAS_FRAME_STATE ? /no logs\/cycles/ : /frame-state\.js|stateRangeAtr/);
});
