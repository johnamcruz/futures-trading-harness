#!/usr/bin/env node
'use strict';

/**
 * The moment probe (scripts/lib/eval/moment-probe.js): re-ask the model about recorded moments whose answer is known, once
 * under the recorded (old) skills and once under another tree's skills. It calls a model, so it is run by hand, never in CI.
 *
 *   node scripts/moment-probe.js --moments <file.json> --tree <root of the new skills> [--k 3] [--out <dir>]
 *
 * Each moment's old arm is asked k times first; a moment whose majority is not what the real cycle did is uncalibrated
 * (reported, not counted), and its new arm is never asked.
 *
 * The moments file is a list of { id, set: "change" | "hold", want, cycle } where `cycle` is a recorded cycle log
 * (logs/cycles/DAY/HHMMSS-trade.json). A "change" moment is one the fix should move to `want`; a "hold" moment must not flip.
 * Each ask runs the cycle's recorded argv without its tools, in an empty directory. Exit 0 when the screen holds, 1 when not.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const P = require('./lib/eval/moment-probe');

const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };

function ask(byId, cwd) {
  return (prompt, { id }) => new Promise((resolve, reject) => {
    const m = byId[id];
    const args = ['-p', prompt, ...(m.model ? ['--model', m.model] : []), '--append-system-prompt-file', m.system, '--permission-mode', 'dontAsk', '--output-format', 'text'];
    const child = spawn(m.bin, args, { cwd, timeout: 300000 });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve({ text: out }) : reject(new Error(`${m.bin} exited ${code}`))));
  });
}

(async () => {
  const file = arg('--moments');
  const tree = arg('--tree');
  if (!file || !tree) { process.stderr.write('usage: moment-probe.js --moments <file.json> --tree <root> [--out <dir>]\n'); process.exit(4); }
  const specs = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byId = {};
  const moments = specs.map(s => {
    const log = JSON.parse(fs.readFileSync(s.cycle, 'utf8'));
    const m = P.momentFromCycle(log, s);
    byId[m.id] = { ...m, bin: log.argv[0] };
    return m;
  });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'moment-probe-'));
  const { rows, summary } = await P.probeMoments({ moments, bodyOf: P.treeBodyOf(path.resolve(tree)), ask: ask(byId, cwd), k: Number(arg('--k') || 3) });
  for (const r of rows) process.stdout.write(`${r.set.padEnd(6)} ${r.id.padEnd(22)} want ${String(r.want).padEnd(9)} old ${String(r.before).padEnd(9)} new ${String(r.after).padEnd(9)} ${r.verdict}\n`);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (arg('--out')) { fs.mkdirSync(arg('--out'), { recursive: true }); fs.writeFileSync(path.join(arg('--out'), 'moment-probe.json'), JSON.stringify({ rows, summary }, null, 1)); }
  process.exit(summary.ok ? 0 : 1);
})().catch(e => { process.stderr.write(`${e.message}\n`); process.exit(4); });
