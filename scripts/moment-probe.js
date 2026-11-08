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
 *
 * Read mode (scripts/lib/eval/read-probe.js): a change to what the model is SHOWN, and whether it reads the state.
 *
 *   node scripts/moment-probe.js --moments <file.json> --patch <patch.json | state-line> [--tree <root>] [--system <file>] --k <n> --timeout-ms <ms> [--out <dir>]
 *
 * The new arm is the recorded prompt patched: a patch file (one patch or a list, briefing-patch.js: anchor `line` or
 * `match`, op before | after | replace | remove, `text`, `within`, `unless`), or `state-line`: each cycle's own State
 * line (scripts/lib/trading/frame-state.js, read back from its recorded briefing) inserted before `- Alignment:`. With
 * --tree, the tree's skill blocks too. Both arms are asked k times, always; each answer is scored for namesConflict,
 * calledLabelStale, echoesState and its decision (counts, never a pass or fail). Moments: { id, set: "change" | "hold",
 * cycle } (`want` ignored); make them from run homes with scripts/probe-moments.js. --system replaces the recorded system
 * prompt file on both arms (required for a cycle whose argv has none). Every arm is built before any ask: a patch that
 * misses or matches twice fails the run, nothing asked. Exit 0 when the run completes (1 on a usage or patch error).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const P = require('./lib/eval/moment-probe');
const R = require('./lib/eval/read-probe');
const B = require('./lib/eval/briefing-patch');

const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };

function ask(byId, cwd, timeoutMs) {
  return (prompt, { id }) => new Promise((resolve, reject) => {
    const m = byId[String(id)];
    const child = spawn('claude', P.probeArgs({ prompt, system: m.system, model: m.model }), { cwd, timeout: timeoutMs });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { err = (err + d).split('\n').slice(-1 - 1).join('\n'); }); // drained, so a chatty child cannot block; its last non-empty line names a failure (the last two lines kept: a final newline may stand alone)
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve({ text: out }) : reject(new Error(`claude exited ${code}: ${err.split('\n').filter(l => l.trim()).at(-1) || ''}`))));
  });
}

/** Read mode: the recorded prompt against the patched one, every answer's reads counted. */
async function readMode({ specs, tree, k, timeoutMs }) {
  const patchArg = arg('--patch');
  const patches = patchArg === 'state-line' ? [] : [].concat(JSON.parse(fs.readFileSync(patchArg, 'utf8')));
  patches.forEach(B.validatePatch);
  const frameState = patchArg === 'state-line' ? B.loadFrameState() : null;
  const byId = {};
  const moments = specs.map(s => {
    const m = R.momentForRead(JSON.parse(fs.readFileSync(s.cycle, 'utf8')), s, { system: arg('--system') && path.resolve(arg('--system')) });
    byId[String(m.id)] = m;
    return m;
  });
  const arm = m => R.armOf(m, { patches, bodyOf: tree ? P.treeBodyOf(path.resolve(tree)) : null, stateLine: frameState && (x => B.stateLineFor({ prompt: x.prompt }, frameState)) });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'moment-probe-'));
  let result;
  try { result = await R.probeReads({ moments, arm, ask: ask(byId, cwd, timeoutMs), k }); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  process.stdout.write(R.readTable(result));
  for (const r of result.rows.filter(x => x.errors)) process.stdout.write(`${r.id}\t${r.errors.join('\t')}\n`);
  process.stdout.write(`${JSON.stringify(result.summary)}\n`);
  if (arg('--out')) { fs.mkdirSync(arg('--out'), { recursive: true }); fs.writeFileSync(path.join(arg('--out'), 'moment-probe-read.json'), JSON.stringify({ patch: patchArg, system: arg('--system'), ...result }, null, 1)); }
}

(async () => {
  const file = arg('--moments');
  const tree = arg('--tree');
  const k = Number(arg('--k'));
  const timeoutMs = Number(arg('--timeout-ms'));
  if (!file || !(tree || arg('--patch')) || !Number.isInteger(k) || k < 1 || timeoutMs < 1 || timeoutMs !== (timeoutMs | 0) /* a whole number a timer takes */) {
    process.stderr.write('usage: moment-probe.js --moments <file.json> (--tree <root> | --patch <patch.json | state-line> [--tree <root>] [--system <file>]) --k <asks per arm, whole> --timeout-ms <per ask> [--out <dir>]\n');
    process.exitCode = 1;
    return;
  }
  const specs = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (arg('--patch')) { await readMode({ specs, tree, k, timeoutMs }); return; }
  const byId = {};
  const moments = specs.map(s => {
    const log = JSON.parse(fs.readFileSync(s.cycle, 'utf8'));
    const m = P.momentFromCycle(log, s);
    byId[String(m.id)] = m;
    return m;
  });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'moment-probe-'));
  let result;
  try { result = await P.probeMoments({ moments, bodyOf: P.treeBodyOf(path.resolve(tree)), ask: ask(byId, cwd, timeoutMs), k }); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  const { rows, summary } = result;
  for (const r of rows) process.stdout.write([r.set, r.id, `want ${r.want}`, `old ${r.before}`, `new ${r.after}`, r.verdict, `swapped ${r.swapped.join(',')}`, ...(r.errors || [])].join('\t') + '\n');
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (arg('--out')) { fs.mkdirSync(arg('--out'), { recursive: true }); fs.writeFileSync(path.join(arg('--out'), 'moment-probe.json'), JSON.stringify({ rows, summary }, null, 1)); }
  process.exitCode = summary.ok ? 0 : 1;
})().catch(e => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });
