#!/usr/bin/env node
'use strict';

/**
 * The moment probe (scripts/lib/eval/moment-probe.js): re-ask the model about recorded moments whose answer is known, once
 * under the recorded (old) skills and once under another tree's skills. It calls a model, so it is run by hand, never in CI.
 *
 *   node scripts/moment-probe.js --moments <file.json> --tree <root of the new skills> --k <asks per arm> --timeout-ms <per ask> [--out <dir>]
 *
 * Each moment's old arm is asked k times first; a moment whose majority is not what the real cycle did is uncalibrated
 * (reported, not counted), and its new arm is never asked.
 *
 * The moments file is a list of { id, set: "change" | "hold", want, cycle } where `cycle` is a recorded cycle log
 * (logs/cycles/DAY/HHMMSS-trade.json). A "change" moment is one the fix should move to `want`; a "hold" moment must not flip.
 * Each ask runs the cycle's recorded argv without its tools, in an empty directory. Exit 0 when the screen holds, 1 when not (or on a usage error).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const P = require('./lib/eval/moment-probe');

const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };

function ask(byId, cwd, timeoutMs) {
  return (prompt, { id }) => new Promise((resolve, reject) => {
    const m = byId[String(id)];
    const child = spawn('claude', P.probeArgs({ prompt, system: m.system, model: m.model }), { cwd, timeout: timeoutMs });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err = String(d); }); // drained, so a chatty child cannot block; the last chunk names a failure
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve({ text: out }) : reject(new Error(`claude exited ${code}: ${err.trim()}`))));
  });
}

(async () => {
  const file = arg('--moments');
  const tree = arg('--tree');
  const k = Number(arg('--k'));
  const timeoutMs = Number(arg('--timeout-ms'));
  if (!file || !tree || !Number.isInteger(k) || k < 1 || timeoutMs < 1 || timeoutMs !== (timeoutMs | 0) /* a whole number a timer takes */) {
    process.stderr.write('usage: moment-probe.js --moments <file.json> --tree <root> --k <asks per arm, whole> --timeout-ms <per ask> [--out <dir>]\n');
    process.exitCode = 1;
    return;
  }
  const specs = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byId = {};
  const moments = specs.map(s => {
    const log = JSON.parse(fs.readFileSync(s.cycle, 'utf8'));
    const m = P.momentFromCycle(log, s);
    byId[String(m.id)] = m;
    return m;
  });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'moment-probe-'));
  const { rows, summary } = await P.probeMoments({ moments, bodyOf: P.treeBodyOf(path.resolve(tree)), ask: ask(byId, cwd, timeoutMs), k });
  for (const r of rows) process.stdout.write([r.set, r.id, `want ${r.want}`, `old ${r.before}`, `new ${r.after}`, r.verdict].join('\t') + '\n');
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (arg('--out')) { fs.mkdirSync(arg('--out'), { recursive: true }); fs.writeFileSync(path.join(arg('--out'), 'moment-probe.json'), JSON.stringify({ rows, summary }, null, 1)); }
  process.exitCode = summary.ok ? 0 : 1;
})().catch(e => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });
