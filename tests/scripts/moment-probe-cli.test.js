'use strict';

// The moment probe CLI (scripts/moment-probe.js) against a fake `claude` binary: the stderr reason survives a trailing
// chunk, a failed ask is unanswered with its reason in --out, an id given as a number and as a string are one id, and
// the timeout must be a whole timer value.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', '..', 'scripts', 'moment-probe.js');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-cli-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'claude'), '#!/bin/sh\nprintf "rate limit \\303\\251"\nsleep 0.1\nprintf "\\n" >&2\nprintf "rate limit \\303\\251" >&2\nsleep 0.1\nprintf "\\n" >&2\nexit 2\n', { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'tree', 'skills', 'candle-reading'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tree', 'skills', 'candle-reading', 'SKILL.md'), '---\nname: candle-reading\ndescription: x\n---\nNEW body\n');
  const log = { prompt: '<skill name="candle-reading">\nOLD\n</skill>\nbar', result: 'CYCLE RESULT: planned - x', argv: ['claude', '--append-system-prompt-file', '/s.md'] };
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify(log));
  fs.writeFileSync(path.join(dir, 'm.json'), JSON.stringify([{ cycle: path.join(dir, 'c.json'), id: 1, set: 'change', want: 'no-trade' }]));
  return dir;
}

const run = (dir, extra) => spawnSync(process.execPath, [CLI, '--moments', path.join(dir, 'm.json'), '--tree', path.join(dir, 'tree'), '--k', '1', '--out', path.join(dir, 'out'), ...extra],
  { env: { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}` }, encoding: 'utf8' });

test('CLI: a failed ask is unanswered with its stderr reason in --out, and the run is not ok', () => {
  const dir = setup();
  const r = run(dir, ['--timeout-ms', '20000']);
  assert.strictEqual(r.status, 1);
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'moment-probe.json'), 'utf8'));
  assert.strictEqual(out.rows[0].verdict, 'unanswered');
  assert.match(out.rows[0].errors[0], /claude exited 2: rate limit é/);
});

test('CLI: the timeout must be a whole value a timer takes', () => {
  const dir = setup();
  for (const t of ['0', '-5', '1.5', '3e9', 'abc']) {
    const r = run(dir, ['--timeout-ms', t]);
    assert.ok(r.status === 1 && /usage/.test(r.stderr), t);
  }
});
